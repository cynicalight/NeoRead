package reader

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
	s.translationMu.Lock()
	m, sourceErr := s.readTranslationSource(d.ID)
	if sourceErr != nil {
		m = layoutManifest{}
	}
	items, err := s.visibleTranslations(d.ID, m)
	if err != nil {
		s.translationMu.Unlock()
		fail(w, 500, "无法读取译文")
		return
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
			if !ok || send("translation", block) != nil {
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
