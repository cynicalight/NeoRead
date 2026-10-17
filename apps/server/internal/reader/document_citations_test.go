package reader

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDocumentProviderCitationsRequireReadEvidence(t *testing.T) {
	a := &documentAgent{Evidence: []documentEvidence{{SourceID: "S64", Text: "original"}, {SourceID: "S65", Text: "second"}}}
	for _, text := range []string{"answer [S64]", "answer citeS64", "answer fileciteS64", "answer citeS64S65 [S64]"} {
		refs, err := a.references(text)
		if err != nil || !strings.Contains(string(refs), `"sourceId":"S64"`) {
			t.Fatalf("citation not resolved: %s %s %v", text, refs, err)
		}
		if strings.Count(string(refs), `"sourceId":"S64"`) != 1 {
			t.Fatal("duplicate reference", string(refs))
		}
	}
	for _, text := range []string{"[S999]", "citeS999", "citeS64S999", "citeturn1search0", "cite", "citeS64", "citeS64", "cite", "filecite", "cite", "ci", "citeS999citeS64"} {
		if _, err := a.references(text); errorKind(err) != ErrorProtocol {
			t.Fatalf("unverified citation accepted: %q %v", text, err)
		}
	}
	for _, text := range []string{"other[S999]", "other [S999]"} {
		if _, err := a.references(text); errorKind(err) != ErrorProtocol {
			t.Fatalf("provider marker hid native source validation: %q %v", text, err)
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
