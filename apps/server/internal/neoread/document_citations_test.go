package neoread

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDocumentProviderCitationsRequireReadEvidence(t *testing.T) {
	a := &documentAgent{Evidence: []documentEvidence{{SourceID: "S64", Text: "original"}, {SourceID: "S65", Text: "second"}}}
	for _, text := range []string{"answer [S64]", "answer 【S64】", "answer ［S64］", "answer （S64、S65）", "answer (S64, S65)", "answer [S64; S65]", "answer citeS64", "answer fileciteS64", "answer citeS64S65 [S64]"} {
		refs, err := a.references(text)
		if err != nil || !strings.Contains(string(refs), `"sourceId":"S64"`) {
			t.Fatalf("citation not resolved: %s %s %v", text, refs, err)
		}
		if strings.Count(string(refs), `"sourceId":"S64"`) != 1 {
			t.Fatal("duplicate reference", string(refs))
		}
	}
	for _, text := range []string{"[S999]", "【S999】", "［S999］", "（S64、S999）", "(S64, S999)", "citeS999", "citeS64S999", "[S64][S999][S64]", "other[S999]", "other [S999]"} {
		refs, err := a.references(text)
		if err != nil || strings.Contains(string(refs), "S999") {
			t.Fatalf("unread source should not block answer or create reference: %q %s %v", text, refs, err)
		}
		want := 0
		if strings.Contains(text, "S64") {
			want = 1
		}
		var parsed []any
		if json.Unmarshal(refs, &parsed) != nil || len(parsed) != want {
			t.Fatalf("known references lost or duplicated: %q %s", text, refs)
		}
	}
	for _, text := range []string{"citeturn1search0", "cite", "citeS64", "citeS64", "cite", "filecite", "cite", "ci", "citeS999citeS64"} {
		if refs, err := a.references(text); err != nil || strings.Contains(string(refs), "S999") {
			t.Fatalf("malformed citation blocked answer or invented reference: %q %s %v", text, refs, err)
		}
	}
}

func TestProviderCitationPersistsAndValidatesOriginalLocation(t *testing.T) {
	s, a := originalDocumentFixture(t)
	if _, err := a.call(t.Context(), "read_passage", json.RawMessage(`{"full":true}`)); err != nil {
		t.Fatal(err)
	}
	source := a.Evidence[0].SourceID
	text := "依据原文 cite" + source + ""
	if err := s.saveDocumentAgentAnswer(t.Context(), a, text, "codex"); err != nil {
		t.Fatal(err)
	}
	history, _ := s.Store.chatHistory("doc")
	message := history[len(history)-1]
	if message.Content != text || !strings.Contains(string(message.References), `"href"`) {
		t.Fatal("lost original stream text or EPUB location", message)
	}
	path := "/api/documents/doc/messages/" + message.ID + "/sources/" + source
	if out := request(t, s, "GET", path, nil); out.Code != 200 {
		t.Fatal(out.Code, out.Body.String())
	}
	if err := os.WriteFile(filepath.Join(s.Store.Root, "cache", "doc", "manifest.json"), []byte(`{"readingOrder":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if out := request(t, s, "GET", path, nil); out.Code != 409 {
		t.Fatal("stale citation still navigable", out.Code, out.Body.String())
	}
}

func TestNativeCitationBracketsRemainPaired(t *testing.T) {
	for _, text := range []string{"【S64]", "［S64】", "（S64]", "(S64）", "S64", "(S64 is a variable)"} {
		sources, err := documentCitationSources(text)
		if err != nil || len(sources) != 0 {
			t.Fatalf("unexpected source for %q: %v %v", text, sources, err)
		}
	}
}
