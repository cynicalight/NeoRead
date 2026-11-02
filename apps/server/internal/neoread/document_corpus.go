package neoread

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"neoread.local/server/internal/runtimeenv"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const corpusVersion = "document-text-v3"

var errCorpusBusy = errors.New("全文检索索引正在准备，请稍后重试")

type corpusCoverage struct {
	Status          string   `json:"status"`
	TotalUnits      int      `json:"totalUnits"`
	SearchableUnits int      `json:"searchableUnits"`
	Missing         []string `json:"missingRanges"`
	Warnings        []string `json:"warnings"`
}
type documentPassage struct {
	ID        string          `json:"blockId"`
	Section   string          `json:"sectionId"`
	Label     string          `json:"label"`
	Text      string          `json:"text"`
	Location  json.RawMessage `json:"location"`
	Precision string          `json:"precision"`
}
type documentCorpus struct {
	DocumentID  string            `json:"-"`
	Fingerprint string            `json:"-"`
	Revision    string            `json:"corpusRevision"`
	Coverage    corpusCoverage    `json:"coverage"`
	Passages    []documentPassage `json:"passages"`
}

func (s *Server) corpusFingerprint(d Document) (string, error) {
	return s.corpusFingerprintAt(d, s.Store.Root)
}

func (s *Server) corpusFingerprintAt(d Document, logicalRoot string) (string, error) {
	paths := []string{s.Store.File(d)}
	if d.Type == "epub" {
		root := filepath.Join(s.Store.Root, "cache", d.ID)
		manifestPath := filepath.Join(root, "manifest.json")
		paths = append(paths, manifestPath)
		data, err := os.ReadFile(manifestPath)
		if err != nil {
			return "", err
		}
		var manifest struct {
			ReadingOrder []struct {
				Href string `json:"href"`
			} `json:"readingOrder"`
		}
		if err = json.Unmarshal(data, &manifest); err != nil {
			return "", err
		}
		for _, link := range manifest.ReadingOrder {
			name, e := safeResource(link.Href)
			if e != nil {
				return "", e
			}
			paths = append(paths, filepath.Join(root, filepath.FromSlash(name)))
		}
	}
	paths = append(paths, filepath.Join(s.analysisDir(d.ID), "manifest.json"))
	var parts []string
	for _, p := range paths {
		info, e := os.Stat(p)
		if e == nil {
			rel, err := filepath.Rel(s.Store.Root, p)
			if err != nil {
				return "", err
			}
			parts = append(parts, fmt.Sprintf("%s:%d:%d", filepath.Join(logicalRoot, rel), info.Size(), info.ModTime().UnixNano()))
		} else if !os.IsNotExist(e) {
			return "", e
		}
	}
	return sourceKey(corpusVersion + "\n" + strings.Join(parts, "\n")), nil
}
func (s *Server) documentCorpus(ctx context.Context, documentID string, preparing func() error) (*documentCorpus, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	d, err := s.Store.Document(documentID)
	if err != nil || d.DeletedAt != "" {
		return nil, generationError(ErrorCanceled, "文档已不可用")
	}
	fingerprint, err := s.corpusFingerprint(d)
	if err != nil {
		return nil, err
	}
	var body string
	if err = s.Store.DB.QueryRowContext(ctx, "SELECT body FROM document_corpora WHERE document_id=? AND fingerprint=?", d.ID, fingerprint).Scan(&body); err == nil {
		var c documentCorpus
		if json.Unmarshal([]byte(body), &c) == nil {
			c.DocumentID = d.ID
			c.Fingerprint = fingerprint
			return &c, nil
		}
	}
	if !s.corpusMu.TryLock() {
		return nil, errCorpusBusy
	}
	defer s.corpusMu.Unlock()
	if preparing != nil {
		if err = preparing(); err != nil {
			return nil, err
		}
	}
	c := &documentCorpus{DocumentID: d.ID, Fingerprint: fingerprint, Coverage: corpusCoverage{Status: "ready", Missing: []string{}, Warnings: []string{}}}
	if d.Type == "epub" {
		err = s.epubCorpus(ctx, d, c)
	} else {
		err = s.pdfCorpus(ctx, d, c)
	}
	if err != nil {
		return nil, err
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if current, e := s.corpusFingerprint(d); e != nil || current != fingerprint {
		return nil, generationError(ErrorProtocol, "原文已更新，请重试")
	}
	raw, _ := json.Marshal(c)
	if len(raw) > 32<<20 {
		return nil, generationError(ErrorLimit, "文档原文索引超过限制")
	}
	c.Revision = sourceKey(string(raw))
	for i := range c.Passages {
		c.Passages[i].ID = c.Revision[:12] + fmt.Sprintf("-%d", i+1)
	}
	raw, _ = json.Marshal(c)
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "DELETE FROM document_passages_fts WHERE document_id=?", d.ID); err != nil {
		return nil, err
	}
	for _, p := range c.Passages {
		if _, err = tx.ExecContext(ctx, "INSERT INTO document_passages_fts(document_id,revision,block_id,content) VALUES(?,?,?,?)", d.ID, c.Revision, p.ID, p.Text); err != nil {
			return nil, err
		}
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO document_corpora(document_id,fingerprint,revision,body) VALUES(?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET fingerprint=excluded.fingerprint,revision=excluded.revision,body=excluded.body", d.ID, fingerprint, c.Revision, string(raw)); err != nil {
		return nil, err
	}
	// Only refresh existing overviews automatically. Opening an old library
	// must not enqueue first-time paid generation for every historical document.
	var settings string
	_ = tx.QueryRowContext(ctx, "SELECT value FROM settings WHERE key='neoread'").Scan(&settings)
	var prefs struct {
		Enabled bool `json:"autoGenerateOverview"`
	}
	if json.Unmarshal([]byte(settings), &prefs) == nil && prefs.Enabled {
		if _, err = tx.ExecContext(ctx, `INSERT INTO document_overview_jobs(document_id,job_id,status,error)
 SELECT ?,?,'queued','' WHERE EXISTS(SELECT 1 FROM document_overviews WHERE document_id=?)
 ON CONFLICT(document_id) DO UPDATE SET job_id=excluded.job_id,status='queued',error='' WHERE document_overview_jobs.status NOT IN ('running','queued')`, d.ID, id(), d.ID); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return c, nil
}

func (s *Store) queueDocumentCorpus(documentID string) error {
	_, err := s.DB.Exec("INSERT INTO document_corpus_jobs(document_id,status) VALUES(?,'queued') ON CONFLICT(document_id) DO UPDATE SET status='queued'", documentID)
	return err
}

// Use the existing processing lifetime and document cancellation registry. Jobs
// survive restart, but failed preparations are retried only on import, parsing
// or a chat request, rather than spinning once a second.
func (s *Server) corpusWorker(ctx context.Context) {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		var documentID string
		// Avoid extracting PDF text while its existing layout pass is queued or
		// running. Paused/failed layout and manual books can index without it.
		err := s.Store.DB.QueryRowContext(ctx, `SELECT j.document_id FROM document_corpus_jobs j
 JOIN documents d ON d.id=j.document_id LEFT JOIN document_processing p ON p.document_id=d.id
 WHERE j.status='queued' AND d.deleted_at='' AND NOT
 (d.type='pdf' AND COALESCE(p.phase,'')='learning' AND p.status IN ('queued','running'))
 ORDER BY j.rowid LIMIT 1`).Scan(&documentID)
		if err != nil {
			continue
		}
		work, finish, err := s.beginDocumentTask(ctx, documentID)
		if err != nil {
			continue
		}
		_, err = s.Store.DB.ExecContext(work, "UPDATE document_corpus_jobs SET status='running' WHERE document_id=? AND status='queued'", documentID)
		if err == nil {
			child, cancel := context.WithTimeout(work, 3*time.Minute)
			_, err = s.documentCorpus(child, documentID, nil)
			cancel()
		}
		if err == nil {
			_, _ = s.Store.DB.Exec("DELETE FROM document_corpus_jobs WHERE document_id=? AND status='running'", documentID)
		} else {
			status := "failed"
			if work.Err() != nil || errors.Is(err, errCorpusBusy) {
				status = "queued"
			}
			_, _ = s.Store.DB.Exec("UPDATE document_corpus_jobs SET status=? WHERE document_id=? AND status='running'", status, documentID)
			if status == "failed" {
				s.diagnosticEvent(slog.LevelWarn, "corpus.prepare.failed", "documentId", documentID, "errorCode", errorKind(err))
			}
		}
		finish()
	}
}
func addCorpusPassage(c *documentCorpus, section, label, text string, location any, precision string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	raw, _ := json.Marshal(location)
	offset := 0
	// Bounded slices preserve reachability for long paragraphs.
	for text != "" {
		n := min(len(text), 2400)
		for n > 0 && !utf8.ValidString(text[:n]) {
			n--
		}
		for n > 1 {
			encoded, _ := json.Marshal(text[:n])
			if len(encoded) <= 4000 {
				break
			}
			n /= 2
			for n > 0 && !utf8.ValidString(text[:n]) {
				n--
			}
		}
		piece := text[:n]
		pieceLocation := raw
		if loc, ok := location.(EPUBReadingLocation); ok {
			loc.Quote = piece
			loc.Start, loc.End = offset, offset+utf16Length(piece)
			var locator map[string]any
			if json.Unmarshal([]byte(loc.Locator), &locator) == nil {
				locator["text"] = map[string]string{"highlight": piece}
				encoded, _ := json.Marshal(locator)
				loc.Locator = string(encoded)
			}
			pieceLocation, _ = json.Marshal(loc)
		}
		c.Passages = append(c.Passages, documentPassage{Section: section, Label: label, Text: piece, Location: pieceLocation, Precision: precision})
		offset += utf16Length(piece)
		text = text[n:]
	}
}
func (s *Server) epubCorpus(ctx context.Context, d Document, c *documentCorpus) error {
	blocks, err := s.readEPUBBlocks(d.ID)
	if err != nil {
		return generationError(ErrorConfiguration, "EPUB 原文索引无法读取")
	}
	seen := map[string]bool{}
	readable := map[string]bool{}
	for _, b := range blocks {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		seen[b.Location.Href] = true
		if b.Image == "" && strings.TrimSpace(b.Text) != "" {
			readable[b.Location.Href] = true
			addCorpusPassage(c, b.Location.Href, b.Label, b.Text, b.Location, "paragraph")
		}
	}
	// Include spine resources with no text, rather than infer coverage from blocks.
	data, e := os.ReadFile(filepath.Join(s.Store.Root, "cache", d.ID, "manifest.json"))
	if e != nil {
		return e
	}
	var m epubReaderManifest
	if json.Unmarshal(data, &m) != nil {
		return fmt.Errorf("EPUB manifest invalid")
	}
	for _, r := range m.ReadingOrder {
		seen[r.Href] = true
	}
	titles := map[string]string{}
	for _, r := range m.ReadingOrder {
		if r.Title != "" {
			titles[r.Href] = r.Title
		}
	}
	var visit func([]epubReaderLink)
	visit = func(links []epubReaderLink) {
		for _, link := range links {
			href := strings.Split(link.Href, "#")[0]
			if titles[href] == "" && link.Title != "" {
				titles[href] = link.Title
			}
			visit(link.Children)
		}
	}
	visit(m.TOC)
	for _, b := range blocks {
		if b.Label == "paragraph_title" && titles[b.Location.Href] == "" {
			titles[b.Location.Href] = truncateChatText(b.Text, 200)
		}
	}
	for i := range c.Passages {
		if title := titles[c.Passages[i].Section]; title != "" {
			c.Passages[i].Label = title
		} else {
			c.Passages[i].Label = c.Passages[i].Section
		}
	}
	c.Coverage.TotalUnits = len(seen)
	c.Coverage.SearchableUnits = len(readable)
	for href := range seen {
		if !readable[href] {
			c.Coverage.Missing = append(c.Coverage.Missing, href)
		}
	}
	sort.Strings(c.Coverage.Missing)
	if len(c.Coverage.Missing) > 0 {
		c.Coverage.Status = "partial"
		c.Coverage.Warnings = append(c.Coverage.Warnings, "部分 EPUB 资源没有可用文字")
	}
	return nil
}

type extractedPDF struct {
	TotalPages int `json:"totalPages"`
	Pages      []struct {
		Page  int `json:"page"`
		Spans []struct {
			Text   string                                `json:"text"`
			Bounds struct{ X, Y, Width, Height float64 } `json:"bounds"`
		} `json:"spans"`
	} `json:"pages"`
	Outline []struct {
		Title string `json:"title"`
		Page  int    `json:"page"`
	} `json:"outline"`
}

func (s *Server) pdfCorpus(ctx context.Context, d Document, c *documentCorpus) error {
	var extracted extractedPDF
	layout, layoutErr := s.readLayout(d.ID)
	if layoutErr == nil && layout.Pages > 1000 {
		return generationError(ErrorProtocol, "已有解析的页数超过支持范围")
	}
	missingPages := []string{}
	if layoutErr == nil {
		for page := 1; page <= layout.Pages; page++ {
			if !parsedPage(&layout, page) {
				missingPages = append(missingPages, fmt.Sprint(page))
			}
		}
	}
	needsExtraction := layoutErr != nil || len(missingPages) > 0
	worker := corpusProcessor()
	node := os.Getenv("NEOREAD_NODE")
	if needsExtraction && worker != "" && node != "" {
		work, err := os.MkdirTemp(filepath.Join(s.Store.Root, "ai-work"), "corpus-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(work)
		out := filepath.Join(work, "text.json")
		cmd := runtimeenv.CommandContext(ctx, node, worker, "--input", s.Store.File(d), "--output", out)
		if layoutErr == nil {
			cmd.Args = append(cmd.Args, "--pages", strings.Join(missingPages, ","))
		}
		cmd.Dir = work
		cmd.Env = append(os.Environ(), "ELECTRON_RUN_AS_NODE=1")
		cmd.Stderr = io.Discard
		cmd.WaitDelay = 3_000_000_000
		if err = cmd.Run(); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return generationError(ErrorConfiguration, "全文文字提取失败，请检查 PDF 或本地解析程序")
		}
		info, err := os.Stat(out)
		if err != nil || info.Size() > 32<<20 {
			return generationError(ErrorLimit, "PDF 原文索引不可用或过大")
		}
		data, err := os.ReadFile(out)
		if err != nil {
			return err
		}
		if json.Unmarshal(data, &extracted) != nil || len(extracted.Pages) < 1 || extracted.TotalPages < 1 || extracted.TotalPages > 1000 {
			return fmt.Errorf("PDF corpus invalid")
		}
	}
	if len(extracted.Pages) == 0 && layoutErr != nil {
		return generationError(ErrorConfiguration, "全文检索需要本地 PDF 文字提取程序，请重新构建 NeoRead")
	}
	if layoutErr == nil {
		c.Coverage.TotalUnits = layout.Pages
		if extracted.TotalPages > 0 && extracted.TotalPages != layout.Pages {
			return generationError(ErrorProtocol, "已有解析与 PDF 页数不符，请重新解析")
		}
	} else {
		c.Coverage.TotalUnits = extracted.TotalPages
	}
	if needsExtraction && len(extracted.Pages) == 0 {
		c.Coverage.Warnings = append(c.Coverage.Warnings, "当前仅可读取已解析页面，全文文字提取程序尚未就绪")
	}
	extractedPages := map[int]int{}
	complexText := false
	for i, page := range extracted.Pages {
		if page.Page < 1 || page.Page > c.Coverage.TotalUnits {
			return fmt.Errorf("PDF page invalid")
		}
		if _, duplicate := extractedPages[page.Page]; duplicate {
			return fmt.Errorf("PDF page duplicated")
		}
		extractedPages[page.Page] = i
	}
	for number := 1; number <= c.Coverage.TotalUnits; number++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		section := fmt.Sprintf("p%d", number)
		label := fmt.Sprintf("第 %d 页", number)
		for _, o := range extracted.Outline {
			if o.Page <= number && o.Title != "" {
				label = o.Title
			}
		}
		start := len(c.Passages)
		// Already parsed pages use existing blocks and their exact geometry.
		if layoutErr == nil && parsedPage(&layout, number) {
			for _, b := range layout.Blocks {
				if b.Page == number && !isPDFPageDecoration(b) && strings.TrimSpace(b.Text) != "" {
					if b.Image != "" {
						complexText = true
					}
					addCorpusPassage(c, section, label, b.Text, map[string]any{"type": "pdf", "page": number, "rects": []any{b.Bounds}}, "block")
				}
			}
		}
		if extractedIndex, available := extractedPages[number]; available && (layoutErr != nil || !parsedPage(&layout, number)) {
			page := extracted.Pages[extractedIndex]
			var text strings.Builder
			flush := func() {
				addCorpusPassage(c, section, label, text.String(), map[string]any{"type": "pdf", "page": number}, "page")
				text.Reset()
			}
			for _, span := range page.Spans {
				if text.Len() > 1800 {
					flush()
				}
				text.WriteString(span.Text)
				text.WriteByte(' ')
			}
			flush()
		}
		if len(c.Passages) > start {
			c.Coverage.SearchableUnits++
		} else {
			c.Coverage.Missing = append(c.Coverage.Missing, section)
		}
	}
	if len(c.Coverage.Missing) > 0 {
		c.Coverage.Status = "partial"
		c.Coverage.Warnings = append(c.Coverage.Warnings, "部分页面没有可检索文字，可查看对应页面原图")
	}
	if complexText {
		c.Coverage.Warnings = append(c.Coverage.Warnings, "表格、图表和公式只索引已有原文文字；二维结构需对照原文")
	}
	return nil
}
