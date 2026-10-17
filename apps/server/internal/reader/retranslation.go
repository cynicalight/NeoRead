package reader

import (
	"encoding/json"
	"errors"
	"maps"
	"net/http"
)

// Only task choices are persisted. Connections, capabilities and secrets still
// come from the configured provider when the job runs or resumes.
type translationRunOptions struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Effort   string `json:"effort"`
	Prompt   string `json:"prompt"`
}

func snapshotTranslationOptions(c AIConfig) translationRunOptions {
	model := c.TranslationModels[c.Primary]
	o := translationRunOptions{Provider: c.Primary, Model: model, Effort: c.TranslationEfforts[c.Primary][model]}
	if c.TranslationPrompt != nil {
		o.Prompt = *c.TranslationPrompt
	}
	return o
}

func (o *translationRunOptions) apply(c AIConfig) AIConfig {
	if o == nil {
		return c
	}
	c.Primary = o.Provider
	c.TranslationModels = maps.Clone(c.TranslationModels)
	if c.TranslationModels == nil {
		c.TranslationModels = map[string]string{}
	}
	c.TranslationModels[o.Provider] = o.Model
	c.TranslationEfforts = maps.Clone(c.TranslationEfforts)
	if c.TranslationEfforts == nil {
		c.TranslationEfforts = map[string]map[string]string{}
	}
	c.TranslationEfforts[o.Provider] = maps.Clone(c.TranslationEfforts[o.Provider])
	if c.TranslationEfforts[o.Provider] == nil {
		c.TranslationEfforts[o.Provider] = map[string]string{}
	}
	c.TranslationEfforts[o.Provider][o.Model] = o.Effort
	c.TranslationPrompt = &o.Prompt
	return c
}

func (s *Server) retranslationOptions(p *Processing) (*translationRunOptions, error) {
	if !p.Retranslating {
		return nil, nil
	}
	var body string
	if err := s.Store.DB.QueryRow("SELECT options FROM translation_restarts WHERE document_id=?", p.DocumentID).Scan(&body); err != nil {
		return nil, err
	}
	var options translationRunOptions
	if err := json.Unmarshal([]byte(body), &options); err != nil {
		return nil, err
	}
	return &options, nil
}

func (s *Server) translationPrevious(documentID string) (map[string]bool, error) {
	rows, err := s.Store.DB.Query("SELECT block_id,source_hash FROM translation_previous WHERE document_id=?", documentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	previous := map[string]bool{}
	for rows.Next() {
		var block, hash string
		if err := rows.Scan(&block, &hash); err != nil {
			return nil, err
		}
		previous[block+":"+hash] = true
	}
	return previous, rows.Err()
}

func (s *Server) requestRetranslation(w http.ResponseWriter, r *http.Request) {
	config := s.aiConfig()
	if !validAgent(config.Primary) || !(primaryCapable(config, taskTranslation) || capable(config, "text-api", false)) {
		fail(w, 409, "请先配置并检测翻译模型")
		return
	}
	s.processingControlMu.Lock()
	defer s.processingControlMu.Unlock()
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil || d.DeletedAt != "" {
		fail(w, 404, "文档不存在")
		return
	}
	if d.Type != "pdf" || d.Library == "books" {
		fail(w, 400, "全文重译仅适用于论文；图书请按章节翻译")
		return
	}
	m, err := s.readTranslationSource(d.ID)
	if err != nil {
		fail(w, 409, "正文仍在解析中")
		return
	}
	s.processingMu.Lock()
	p, err := s.Store.processing(d.ID)
	if err != nil || p.Status != "complete" {
		s.processingMu.Unlock()
		fail(w, 409, "请等待当前翻译完成后再重新翻译")
		return
	}
	if s.blockedProcessing == nil {
		s.blockedProcessing = map[string]bool{}
	}
	s.blockedProcessing[d.ID] = true
	task := s.activeProcessing[d.ID]
	if task != nil {
		task.cancel()
	}
	s.processingMu.Unlock()
	if task != nil {
		<-task.done
	}
	s.processingMu.Lock()
	defer s.processingMu.Unlock()
	defer delete(s.blockedProcessing, d.ID)
	// Joining prevents a previous worker's delayed results from replacing this run.
	p, err = s.Store.processing(d.ID)
	if err == nil {
		err = s.queueRetranslation(p, m, snapshotTranslationOptions(config))
	}
	if err != nil {
		fail(w, 409, "无法开始重新翻译："+err.Error())
		return
	}
	p, err = s.Store.processing(d.ID)
	if err != nil {
		fail(w, 500, "无法读取翻译任务")
		return
	}
	respond(w, 200, p)
}

func (s *Server) queueRetranslation(p Processing, m translationInput, options translationRunOptions) error {
	items, err := s.translations(p.DocumentID, m)
	if err != nil {
		return err
	}
	text := map[string]bool{}
	for _, paragraph := range m.translationParagraphs() {
		text[paragraph.BlockID+":"+paragraph.SourceHash] = true
	}
	count := 0
	for i := range items {
		if text[items[i].BlockID+":"+items[i].SourceHash] && items[i].Status == "complete" {
			items[i].Status = "pending"
			items[i].Sentences = []TranslationSentence{}
			items[i].Error = ""
			count++
		}
	}
	if count == 0 {
		return errors.New("没有已完成的正文译文")
	}
	s.translationMu.Lock()
	defer s.translationMu.Unlock()
	s.Store.processingWriteMu.Lock()
	defer s.Store.processingWriteMu.Unlock()
	tx, err := s.Store.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, item := range items {
		if !text[item.BlockID+":"+item.SourceHash] || item.Status != "pending" {
			continue
		}
		if _, err = tx.Exec(`INSERT INTO translation_previous(document_id,block_id,source_hash,body)
SELECT document_id,block_id,source_hash,body FROM translations WHERE document_id=? AND block_id=? AND source_hash=? AND status='complete'
ON CONFLICT(document_id,block_id,source_hash) DO UPDATE SET body=excluded.body`, p.DocumentID, item.BlockID, item.SourceHash); err != nil {
			return err
		}
		body, err := json.Marshal(item)
		if err != nil {
			return err
		}
		if _, err = tx.Exec("UPDATE translations SET status='pending',body=? WHERE document_id=? AND block_id=? AND source_hash=?", string(body), p.DocumentID, item.BlockID, item.SourceHash); err != nil {
			return err
		}
	}
	if _, err = tx.Exec("INSERT INTO translation_restarts(document_id,options) VALUES(?,?) ON CONFLICT(document_id) DO UPDATE SET options=excluded.options", p.DocumentID, jsonText(options)); err != nil {
		return err
	}
	p.Enabled, p.Retranslating = true, true
	p.AutoTranslateMaxPages, p.ManualTranslation = nil, false
	p.Phase, p.Status, p.Detail = "translating", "queued", "等待重新翻译"
	p.CompletedAt, p.Warning = "", ""
	p.TranslationsDone, p.TranslationsTotal = translationCounts(items)
	p.Translating = &ProcessingStage{Status: "queued", Detail: "等待重新翻译"}
	p.UpdatedAt = now()
	if _, err = tx.Exec("UPDATE document_processing SET phase=?,status=?,body=? WHERE document_id=?", p.Phase, p.Status, jsonText(p), p.DocumentID); err != nil {
		return err
	}
	return tx.Commit()
}
