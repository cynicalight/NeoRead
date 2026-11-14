package neoread

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// translationMu makes the initial snapshot + subscription atomic with saves.
// A slow reader reconnects to a fresh snapshot instead of blocking generation.
func (s *Server) publishTranslation(documentID string, block TranslationBlock) {
	for ch := range s.translationSubscribers[documentID] {
		select {
		case ch <- block:
		default:
			delete(s.translationSubscribers[documentID], ch)
			close(ch)
		}
	}
}
func (s *Server) streamTranslations(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil || (d.Type != "pdf" && d.Type != "epub") {
		fail(w, 404, "文档不存在")
		return
	}
	hrefs := r.URL.Query()["href"]
	var m translationInput
	var sourceErr error
	var allowed map[string]bool
	if d.Type == "epub" && len(hrefs) > 0 {
		manifest, e := s.readerManifest(d.ID)
		valid := map[string]bool{}
		for _, link := range manifest.ReadingOrder {
			valid[link.Href] = true
		}
		for _, href := range hrefs {
			if e != nil || !valid[href] {
				fail(w, 404, "该章节不属于当前书籍")
				return
			}
		}
		seen := map[string]bool{}
		blocks := epubTranslationDocument{}
		for _, href := range hrefs {
			if seen[href] {
				continue
			}
			seen[href] = true
			_, chapter, err := s.readerChapter(d.ID, href)
			if err != nil {
				fail(w, 500, "无法读取 EPUB 章节")
				return
			}
			blocks = append(blocks, chapter...)
		}
		m = blocks
		allowed = map[string]bool{}
		for _, item := range m.translationItems() {
			allowed[item.BlockID] = true
		}
	} else {
		m, sourceErr = s.readTranslationSource(d.ID)
	}
	s.translationMu.Lock()
	if sourceErr != nil {
		m = layoutManifest{}
	}
	items, err := s.translationRecords(d.ID, m, true, allowed != nil)
	if err != nil {
		s.translationMu.Unlock()
		fail(w, 500, "无法读取译文")
		return
	}
	sourceHashes := map[string]string{}
	for _, item := range m.translationItems() {
		sourceHashes[item.BlockID] = item.SourceHash
	}
	ch := make(chan TranslationBlock, 64)
	if s.translationSubscribers == nil {
		s.translationSubscribers = make(map[string]map[chan TranslationBlock]struct{})
	}
	if s.translationSubscribers[d.ID] == nil {
		s.translationSubscribers[d.ID] = make(map[chan TranslationBlock]struct{})
	}
	s.translationSubscribers[d.ID][ch] = struct{}{}
	s.translationMu.Unlock()
	defer func() {
		s.translationMu.Lock()
		delete(s.translationSubscribers[d.ID], ch)
		if len(s.translationSubscribers[d.ID]) == 0 {
			delete(s.translationSubscribers, d.ID)
		}
		s.translationMu.Unlock()
	}()
	controller := http.NewResponseController(w)
	defer controller.SetWriteDeadline(time.Time{})
	send := func(event string, value any) error {
		_ = controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
		data, err := json.Marshal(value)
		if err == nil {
			_, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
		}
		if err == nil {
			err = controller.Flush()
		}
		return err
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	if send("snapshot", items) != nil {
		return
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case block, ok := <-ch:
			if !ok {
				return
			}
			if allowed != nil && !allowed[block.BlockID] {
				continue
			}
			if hash, known := sourceHashes[block.BlockID]; known && hash != block.SourceHash {
				continue
			}
			sourceHashes[block.BlockID] = block.SourceHash
			if send("translation", block) != nil {
				return
			}
		case <-heartbeat.C:
			if _, err = s.Store.Document(d.ID); err != nil {
				_ = send("error", map[string]string{"error": "文档不存在"})
				return
			}
			_ = controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if _, err = fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			if controller.Flush() != nil {
				return
			}
		}
	}
}
