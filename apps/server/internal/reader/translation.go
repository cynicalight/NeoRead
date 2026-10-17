package reader

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

type TranslationSentence struct {
	// Source is the model's sentence, which may repair extraction errors.
	Source string `json:"source"`
	Target string `json:"target"`
	// Anchor is the extracted text the sentence covers, set when it differs
	// from Source. Readers locate sentences in the PDF text layer by it.
	Anchor string `json:"anchor,omitempty"`
}
type TranslationBlock struct {
	BlockID         string                `json:"blockId"`
	SourceHash      string                `json:"sourceHash"`
	Status          string                `json:"status"`
	Sentences       []TranslationSentence `json:"sentences"`
	FormulaMarkdown string                `json:"formulaMarkdown,omitempty"`
	Error           string                `json:"error,omitempty"`
}

func translationSource(b PDFBlock) string {
	if isPDFPageDecoration(b) {
		return ""
	}
	switch b.Label {
	case "reference", "reference_content", "algorithm", "display_formula", "inline_formula", "formula_number", "header", "footer", "number":
		return ""
	}
	if isImageAsset(b) {
		return strings.TrimSpace(b.Caption)
	}
	return strings.TrimSpace(b.Text)
}
func translationHash(source string) string {
	sum := sha256.Sum256([]byte("zh-CN:v1:" + source))
	return hex.EncodeToString(sum[:])
}
func needsTranslation(b PDFBlock) bool {
	return translationSource(b) != "" || (isFormula(b) && b.Image != "")
}
func newTranslation(b PDFBlock) TranslationBlock {
	source := translationSource(b)
	if isFormula(b) {
		source = "formula-image:v1:" + b.Image + ":" + b.Text
	}
	return TranslationBlock{BlockID: b.ID, SourceHash: translationHash(source), Status: "pending", Sentences: []TranslationSentence{}}
}

// Book paragraphs stay idle until requested; PDF papers translate in full.
func (s *Server) translations(documentID string, m translationInput) ([]TranslationBlock, error) {
	return s.translationRecords(documentID, m, false)
}

func (s *Server) visibleTranslations(documentID string, m translationInput) ([]TranslationBlock, error) {
	return s.translationRecords(documentID, m, true)
}

func (s *Server) translationRecords(documentID string, m translationInput, visible bool) ([]TranslationBlock, error) {
	d, err := s.Store.Document(documentID)
	if err != nil {
		return nil, err
	}
	query := "SELECT body FROM translations WHERE document_id=?"
	if visible {
		query = `SELECT COALESCE(previous.body,t.body) FROM translations t LEFT JOIN translation_previous previous
ON previous.document_id=t.document_id AND previous.block_id=t.block_id AND previous.source_hash=t.source_hash WHERE t.document_id=?`
	}
	rows, err := s.Store.DB.Query(query, documentID)
	if err != nil {
		return nil, err
	}
	saved := map[string]TranslationBlock{}
	for rows.Next() {
		var body string
		var t TranslationBlock
		if err = rows.Scan(&body); err != nil {
			rows.Close()
			return nil, err
		}
		if err = json.Unmarshal([]byte(body), &t); err != nil {
			rows.Close()
			return nil, errors.New("译文记录损坏")
		}
		saved[t.BlockID+":"+t.SourceHash] = t
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	result := []TranslationBlock{}
	for _, t := range m.translationItems() {
		if value, ok := saved[t.BlockID+":"+t.SourceHash]; ok {
			t = value
		} else if d.Library == "books" || d.Type == "epub" {
			t.Status = "idle"
		}
		result = append(result, t)
	}
	return result, nil
}

func (s *Server) retryFailedTranslations(documentID string) error {
	m, err := s.readTranslationSource(documentID)
	if err != nil {
		return nil
	}
	items, err := s.translations(documentID, m)
	if err != nil {
		return err
	}
	for _, t := range items {
		if t.Status == "failed" {
			t.Status = "pending"
			t.Error = ""
			if err = s.saveTranslation(documentID, t); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Server) saveTranslation(documentID string, t TranslationBlock) error {
	s.translationMu.Lock()
	defer s.translationMu.Unlock()
	body, err := json.Marshal(t)
	if err != nil {
		return err
	}
	tx, err := s.Store.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT INTO translations(document_id,block_id,source_hash,status,body) VALUES(?,?,?,?,?) ON CONFLICT(document_id,block_id,source_hash) DO UPDATE SET status=excluded.status,body=excluded.body`, documentID, t.BlockID, t.SourceHash, t.Status, string(body)); err != nil {
		return err
	}
	visible := t
	if t.Status == "complete" {
		_, err = tx.Exec("DELETE FROM translation_previous WHERE document_id=? AND block_id=? AND source_hash=?", documentID, t.BlockID, t.SourceHash)
	} else {
		var previous string
		err = tx.QueryRow("SELECT body FROM translation_previous WHERE document_id=? AND block_id=? AND source_hash=?", documentID, t.BlockID, t.SourceHash).Scan(&previous)
		if err == nil {
			err = json.Unmarshal([]byte(previous), &visible)
		} else if errors.Is(err, sql.ErrNoRows) {
			err = nil
		}
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	s.publishTranslation(documentID, visible)
	return nil
}
func (s *Server) documentTranslations(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil || (d.Type != "pdf" && d.Type != "epub") {
		fail(w, 404, "文档不存在")
		return
	}
	m, err := s.readTranslationSource(d.ID)
	if err != nil {
		respond(w, 200, []TranslationBlock{})
		return
	}
	items, err := s.visibleTranslations(d.ID, m)
	if err != nil {
		fail(w, 500, "无法读取译文")
		return
	}
	respond(w, 200, items)
}

// Requests only enqueue work. The translation lane owns provider calls and persists
// completed responses independently, so closing a reader never loses progress.
func (s *Server) requestTranslation(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil || (d.Type != "pdf" && d.Type != "epub") {
		fail(w, 404, "文档不存在")
		return
	}
	var req struct {
		BlockID string `json:"blockId"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.BlockID == "" && (d.Library == "books" || d.Type == "epub") {
		fail(w, 400, "图书请按章节翻译")
		return
	}
	m, err := s.readTranslationSource(d.ID)
	if err != nil {
		fail(w, 409, "正文仍在解析中")
		return
	}
	s.processingMu.Lock()
	defer s.processingMu.Unlock()
	p, err := s.Store.processing(d.ID)
	if err != nil || !p.Enabled {
		fail(w, 409, "请先开始翻译")
		return
	}
	items, err := s.translations(d.ID, m)
	if err != nil {
		fail(w, 500, "无法读取译文")
		return
	}
	found := req.BlockID == ""
	for _, t := range items {
		if req.BlockID != "" && t.BlockID != req.BlockID {
			continue
		}
		found = true
		if t.Status == "complete" || t.Status == "running" {
			continue
		}
		t.Status = "pending"
		t.Error = ""
		if err = s.saveTranslation(d.ID, t); err != nil {
			fail(w, 500, "无法保存翻译任务")
			return
		}
	}
	if !found {
		fail(w, 404, "没有可翻译的段落")
		return
	}
	if p.Status != "running" || (p.Translating != nil && p.Translating.Status != "running") {
		if p.Phase == "ready" {
			p.Phase = "translating"
		}
		p.Status = "queued"
		p.Detail = "等待继续处理"
		p.queueTranslation = true
		if err = s.Store.saveProcessing(p); err != nil {
			fail(w, 500, "无法安排翻译任务")
			return
		}
	}
	respond(w, 202, map[string]bool{"queued": true})
}

func parseTranslation(raw, source string) ([]TranslationSentence, error) {
	return parseTranslationSource(raw, source, true)
}

func parseTranslationSource(raw, source string, repairPDF bool) ([]TranslationSentence, error) {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "```") {
		if i := strings.IndexByte(raw, '\n'); i >= 0 {
			raw = strings.TrimSpace(raw[i+1:])
			raw = strings.TrimSpace(strings.TrimSuffix(raw, "```"))
		}
	}
	var out struct {
		Sentences []TranslationSentence `json:"sentences"`
	}
	if json.Unmarshal([]byte(raw), &out) != nil || len(out.Sentences) == 0 {
		return nil, errors.New("译文格式不完整，请重试此段")
	}
	var joined strings.Builder
	for i, sentence := range out.Sentences {
		out.Sentences[i].Anchor = ""
		if strings.TrimSpace(sentence.Source) == "" || strings.TrimSpace(sentence.Target) == "" {
			return nil, errors.New("译文存在空句，请重试此段")
		}
		joined.WriteString(sentence.Source)
		joined.WriteByte(' ')
	}
	normalize := func(v string) string { return strings.Join(strings.Fields(v), "") }
	if normalize(joined.String()) == normalize(source) {
		return out.Sentences, nil
	}
	if !repairPDF || !similarText(joined.String(), source) {
		return nil, errors.New("原文句子未完整对应，请重试此段")
	}
	for i, anchor := range alignAnchors(source, out.Sentences) {
		out.Sentences[i].Anchor = anchor
	}
	return out.Sentences, nil
}
