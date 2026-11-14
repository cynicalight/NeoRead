package neoread

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/net/html"
)

// Migration is atomic and marked per document. Restarting later must not reset
// work that the reader explicitly requested under the chapter policy.
func (s *Store) prepareManualEPUBProcessing() error {
	rows, err := s.DB.Query("SELECT id FROM documents WHERE type='epub'")
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, id := range ids {
		var body string
		p := initialDocumentProcessing(Document{ID: id, Type: "epub"}, "")
		err = tx.QueryRow("SELECT body FROM document_processing WHERE document_id=?", id).Scan(&body)
		if err == nil {
			p = Processing{}
			if err = json.Unmarshal([]byte(body), &p); err != nil {
				return err
			}
			if p.EPUBManual {
				continue
			}
			if p.Retranslating {
				if _, err = tx.Exec("UPDATE document_processing SET body=json_set(body,'$.epubManual',json('true')) WHERE document_id=?", id); err != nil {
					return err
				}
				continue
			}
			p.EPUBManual = true
			p.Enabled, p.Status, p.Detail = false, "paused", "旧任务已暂停，请按章节翻译"
			p.TranslationBlocks, p.TranslationScopeKind = nil, ""
			p.Phase, p.Translating = "translating", &ProcessingStage{Status: "complete", Detail: "请按章节翻译"}
			p.TranslationsTotal = p.TranslationsDone
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		// Also covers an old import whose processing record is missing.
		if _, err = tx.Exec(`UPDATE translations SET status='idle', body=json_set(body,'$.status','idle','$.error','') WHERE document_id=? AND status!='complete'`, id); err != nil {
			return err
		}
		p.UpdatedAt = now()
		data, e := json.Marshal(p)
		if e != nil {
			return e
		}
		if _, err = tx.Exec(`INSERT INTO document_processing(document_id,phase,status,body) VALUES(?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET phase=excluded.phase,status=excluded.status,body=excluded.body`, id, p.Phase, p.Status, string(data)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// DOM IDs resolve to the first block at or following the anchor, including an
// empty <a id> before a heading. This uses the same extraction as saved blocks.
func epubFragmentBlocks(href, source string) (map[string]string, error) {
	runs := map[*html.Node]string{}
	doc, _, err := parseEPUBChapter(href, source, func(b EPUBReadingBlock, nodes []*html.Node) {
		for _, n := range nodes {
			runs[n] = b.ID
		}
	})
	if err != nil {
		return nil, err
	}
	var nodes []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Data == "head" || epubDropped[strings.ToLower(n.Data)] {
			return
		}
		nodes = append(nodes, n)
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	out := map[string]string{}
	next := ""
	for i := len(nodes) - 1; i >= 0; i-- {
		n := nodes[i]
		if id := runs[n]; id != "" {
			next = id
		}
		for _, a := range n.Attr {
			if a.Key == "id" && next != "" {
				out[a.Val] = next
			}
		}
	}
	return out, nil
}

// The chapter is a half-open block interval with its TOC title. Top-level TOC
// entries define chapters; a single book-title parent delegates to its
// children, as for PDF. Without a TOC the title is empty.
func (s *Server) epubTranslationChapter(id string, blocks epubTranslationDocument, location EPUBReadingLocation) (int, int, string, error) {
	manifest, err := s.readerManifest(id)
	if err != nil {
		return 0, 0, "", err
	}
	byID := map[string]int{}
	files := map[string]int{}
	for i, b := range blocks {
		byID[b.ID] = i
		if _, ok := files[b.Location.Href]; !ok {
			files[b.Location.Href] = i
		}
	}
	// Empty spine items share the next non-empty block boundary.
	next := len(blocks)
	for i := len(manifest.ReadingOrder) - 1; i >= 0; i-- {
		href := manifest.ReadingOrder[i].Href
		if start, ok := files[href]; ok {
			next = start
		} else {
			files[href] = next
		}
	}
	fragments := map[string]map[string]string{}
	resolve := func(href string) (int, error) {
		u, e := url.Parse(href)
		if e != nil || u.IsAbs() || u.Host != "" {
			return 0, fmt.Errorf("章节位置无效")
		}
		u.Fragment = ""
		file := u.String()
		start, ok := files[file]
		if !ok {
			return 0, fmt.Errorf("章节没有可定位正文")
		}
		original, _ := url.Parse(href)
		if original.Fragment == "" {
			return start, nil
		}
		if fragments[file] == nil {
			name, e := safeResource(file)
			if e != nil {
				return 0, e
			}
			data, e := os.ReadFile(filepath.Join(s.Store.Root, "cache", id, filepath.FromSlash(name)))
			if e != nil {
				return 0, e
			}
			anchors, e := epubFragmentBlocks(file, string(data))
			if e != nil {
				return 0, e
			}
			fragments[file] = anchors
		}
		block := fragments[file][original.Fragment]
		index, ok := byID[block]
		if !ok {
			return 0, fmt.Errorf("无法定位目录章节")
		}
		return index, nil
	}
	current, err := resolve(location.Href)
	if err != nil {
		return 0, 0, "", err
	}
	if location.BlockID != "" {
		i, ok := byID[location.BlockID]
		if !ok || blocks[i].Location.Href != strings.Split(location.Href, "#")[0] {
			return 0, 0, "", fmt.Errorf("段落不属于当前章节")
		}
		current = i
	}

	entries := manifest.TOC
	if len(entries) == 1 && len(entries[0].Children) > 0 {
		entries = entries[0].Children
	}
	starts := []int{0}
	titles := map[int]string{}
	if len(entries) == 0 {
		for _, i := range files {
			starts = append(starts, i)
		}
	} else {
		for _, entry := range entries {
			index, e := resolve(entry.Href)
			if e != nil {
				return 0, 0, "", fmt.Errorf("无法确定目录章节范围：%w", e)
			}
			starts = append(starts, index)
			if _, ok := titles[index]; !ok {
				titles[index] = strings.TrimSpace(entry.Title)
			}
		}
	}
	sort.Ints(starts)
	from, to := 0, len(blocks)
	for _, i := range starts {
		if i <= current {
			from = i
		} else {
			to = i
			break
		}
	}
	return from, to, titles[from], nil
}

type epubTranslationRange struct {
	Queued     int  `json:"queued"`
	Characters int  `json:"characters"`
	HasMore    bool `json:"hasMore"`
}

func (s *Server) requestEPUBTranslationChapter(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil || d.Type != "epub" {
		fail(w, 404, "EPUB 不存在")
		return
	}
	var req struct {
		Location EPUBReadingLocation `json:"location"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Location.Type != "epub" || req.Location.Href == "" {
		fail(w, 400, "章节位置无效")
		return
	}
	s.processingControlMu.Lock()
	defer s.processingControlMu.Unlock()
	s.processingMu.Lock()
	defer s.processingMu.Unlock()
	if p, err := s.Store.processing(d.ID); err == nil && p.Retranslating {
		fail(w, 409, "正文正在重新解析，请稍后再试")
		return
	}
	blocks, err := s.readEPUBBlocks(d.ID)
	if err != nil {
		fail(w, 500, "无法读取 EPUB 正文")
		return
	}
	from, to, _, err := s.epubTranslationChapter(d.ID, blocks, req.Location)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	if _, err = s.preemptParagraphTranslation(d.ID, blocks); err != nil {
		fail(w, 500, "无法停止旧段落翻译")
		return
	}
	result, err := s.queueTranslationInput(d, blocks[from:to])
	if err != nil {
		fail(w, 500, "无法安排翻译任务")
		return
	}
	respond(w, 202, epubTranslationRange{Queued: result.Queued, Characters: result.Characters})
}
