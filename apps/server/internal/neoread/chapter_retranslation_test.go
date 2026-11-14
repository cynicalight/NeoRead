package neoread

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestChapterRetranslationKeepsOldTextAndLimitsScope(t *testing.T) {
	for _, format := range []string{"epub", "pdf"} {
		t.Run(format, func(t *testing.T) {
			var s *Server
			var input translationInput
			var route, body string
			var first, last int
			if format == "epub" {
				server, blocks := epubRangeFixture(t, []epubReaderLink{{Href: "a.xhtml#one"}, {Href: "a.xhtml#two"}, {Href: "b.xhtml#three"}})
				s, input = server, blocks
				route, body = "chapter", `{"location":{"type":"epub","href":"a.xhtml#two"},"retranslate":true}`
				first, last = 2, 4
			} else {
				server, _, m := bookFixture(t)
				s, input = server, m
				route, body = "range", `{"fromPage":3,"toPage":4,"retranslate":true}`
				first, last = 2, 4
			}
			items, err := s.translations("doc", input)
			if err != nil {
				t.Fatal(err)
			}
			for i := range items {
				items[i].Status = "complete"
				items[i].Sentences = []TranslationSentence{{Source: "original", Target: "旧译文"}}
				if err = s.saveTranslation("doc", items[i]); err != nil {
					t.Fatal(err)
				}
			}
			p, err := s.Store.processing("doc")
			if err != nil {
				t.Fatal(err)
			}
			p.Phase, p.Status = "translating", "complete"
			p.Translating = &ProcessingStage{Status: "complete"}
			if err = s.Store.saveProcessing(p); err != nil {
				t.Fatal(err)
			}
			// A queued replacement outside this chapter must be retracted before
			// chapter work takes over the shared worker's execution scope.
			forceTranslationBlock(t, s, items[len(items)-1].BlockID)
			path := "/api/documents/doc/translations/" + route
			out := request(t, s, "POST", path, strings.NewReader(body))
			if out.Code != 202 {
				t.Fatalf("%d %s", out.Code, out.Body.String())
			}
			var result translationRange
			if err = json.Unmarshal(out.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Queued != last-first {
				t.Fatalf("queued %+v", result)
			}
			next, err := s.translations("doc", input)
			if err != nil {
				t.Fatal(err)
			}
			visible, err := s.visibleTranslations("doc", input)
			if err != nil {
				t.Fatal(err)
			}
			for i := range next {
				want := "complete"
				if i >= first && i < last {
					want = "pending"
				}
				if next[i].Status != want {
					t.Fatalf("%d status=%s want=%s", i, next[i].Status, want)
				}
				if len(visible[i].Sentences) != 1 || visible[i].Sentences[0].Target != "旧译文" {
					t.Fatalf("old text lost: %+v", visible[i])
				}
			}
			// A repeated request must not reset work already queued or running.
			out = request(t, s, "POST", path, strings.NewReader(body))
			if out.Code != 409 {
				t.Fatalf("duplicate: %d %s", out.Code, out.Body.String())
			}
			replacement := items[first]
			replacement.Sentences = []TranslationSentence{{Source: "original", Target: "新译文"}}
			if err = s.saveTranslation("doc", replacement, input); err != nil {
				t.Fatal(err)
			}
			visible, err = s.visibleTranslations("doc", input)
			if err != nil || visible[first].Sentences[0].Target != "新译文" || visible[first+1].Sentences[0].Target != "旧译文" {
				t.Fatalf("replacement: %+v %v", visible, err)
			}
		})
	}
}
