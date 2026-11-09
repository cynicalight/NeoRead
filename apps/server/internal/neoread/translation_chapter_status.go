package neoread

import (
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"
)

// translationChapterStatus counts the translation units of the reader's
// current book chapter, so the toolbar reflects that chapter rather than the
// whole document. Failed units are reported separately; each one keeps its own
// retry control in the reading view.
type translationChapterStatus struct {
	// Key is stable while the location stays within the same chapter.
	Key      string `json:"key"`
	Title    string `json:"title"`
	Total    int    `json:"total"`
	Idle     int    `json:"idle"`
	Pending  int    `json:"pending"`
	Running  int    `json:"running"`
	Complete int    `json:"complete"`
	Failed   int    `json:"failed"`
	// Unparsed counts book PDF pages in the range that layout parsing has not
	// reached; their paragraphs are not known yet.
	Unparsed int `json:"unparsed"`
	// Parsing reports that the chapter's pages are being parsed on request.
	Parsing bool `json:"parsing"`
}

func countTranslationStatus(out *translationChapterStatus, items []TranslationBlock) {
	for _, t := range items {
		out.Total++
		switch t.Status {
		case "idle":
			out.Idle++
		case "pending":
			out.Pending++
		case "running":
			out.Running++
		case "complete":
			out.Complete++
		case "failed":
			out.Failed++
		}
	}
}

// A chapter without a TOC title is named by its first words.
func chapterOpening(blocks epubTranslationDocument) string {
	for _, b := range blocks {
		text := strings.Join(strings.Fields(b.Text), " ")
		if text == "" {
			continue
		}
		if utf8.RuneCountInString(text) > 24 {
			text = string([]rune(text)[:24]) + "…"
		}
		return text
	}
	return ""
}

func (s *Server) translationChapterState(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil || (d.Type != "epub" && (d.Type != "pdf" || d.Library != "books")) {
		fail(w, 404, "图书不存在")
		return
	}
	var req struct {
		Location *EPUBReadingLocation `json:"location"`
		FromPage int                  `json:"fromPage"`
		ToPage   int                  `json:"toPage"`
	}
	if !decode(w, r, &req) {
		return
	}
	out := translationChapterStatus{}
	if d.Type == "epub" {
		if req.Location == nil || req.Location.Type != "epub" || !validEPUBLocator(req.Location.Locator, req.Location.Href) {
			fail(w, 400, "章节位置无效")
			return
		}
		blocks, err := s.readEPUBBlocks(d.ID)
		if err != nil {
			fail(w, 500, "无法读取 EPUB 正文")
			return
		}
		from, to, title, err := s.epubTranslationChapter(d.ID, blocks, *req.Location)
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		chapter := blocks[from:to]
		items, err := s.translationRecords(d.ID, chapter, false, true)
		if err != nil {
			fail(w, 500, "无法读取译文")
			return
		}
		countTranslationStatus(&out, items)
		if from < len(blocks) {
			out.Key = blocks[from].ID
		}
		out.Title = title
		if out.Title == "" {
			out.Title = chapterOpening(chapter)
		}
		respond(w, 200, out)
		return
	}
	if req.FromPage < 1 || req.ToPage < req.FromPage {
		fail(w, 400, "页码范围无效")
		return
	}
	out.Key = pageRangeKey(req.FromPage, req.ToPage)
	var known *layoutManifest
	m, err := s.readLayout(d.ID)
	if err == nil {
		known = &m
		chapter := m
		chapter.Blocks = nil
		for _, b := range m.Blocks {
			if b.Page >= req.FromPage && b.Page <= req.ToPage {
				chapter.Blocks = append(chapter.Blocks, b)
			}
		}
		items, err := s.translationRecords(d.ID, chapter, false, true)
		if err != nil {
			fail(w, 500, "无法读取译文")
			return
		}
		countTranslationStatus(&out, items)
	}
	to := req.ToPage
	if known != nil {
		to = min(to, known.Pages)
	}
	out.Unparsed = len(unparsedPages(known, req.FromPage, to))
	if p, err := s.Store.processing(d.ID); err == nil && p.Chapter != nil &&
		p.Phase == "learning" && (p.Status == "queued" || p.Status == "running") &&
		p.Chapter.From <= req.ToPage && p.Chapter.To >= req.FromPage {
		out.Parsing = true
	}
	respond(w, 200, out)
}

func pageRangeKey(from, to int) string {
	return fmt.Sprintf("pages:%d-%d", from, to)
}
