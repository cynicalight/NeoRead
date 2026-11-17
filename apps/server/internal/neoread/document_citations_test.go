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

func TestSearchOnlyCitationsPersistWithoutReadCoverage(t *testing.T) {
	s, a := originalDocumentFixture(t)
	a.provider = "api"
	input := AIInput{Chat: &chatInput{Question: "cobalt", Agent: a}}
	if _, err := a.beginConversation(t.Context(), input, "search-key"); err != nil {
		t.Fatal(err)
	}
	raw, err := a.call(t.Context(), "search_document", json.RawMessage(`{"query":"COBALT-19"}`))
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Items []struct {
			BlockID string `json:"blockId"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &result); err != nil || len(result.Items) != 1 {
		t.Fatalf("search result: %s %v", raw, err)
	}
	block := result.Items[0].BlockID
	if refs, err := a.references("[" + a.corpus.Passages[0].ID + "]"); err != nil || string(refs) != "[]" {
		t.Fatalf("unreturned corpus paragraph acquired a target: %s %v", refs, err)
	}
	ev := a.Searched[block]
	if len(a.Evidence) != 0 || len(a.turnRead) != 0 || a.bytes != 0 || a.evidenceTokens != 0 {
		t.Fatal("search counted as reading", a.readingCoverage())
	}
	for _, text := range []string{"[" + block + "]", "【" + block + "】", "cite" + block + "", "filecite" + block + "", "[S1] " + block + "\n正文 [S1]"} {
		refs, err := a.references(text)
		var parsed []documentEvidence
		if err != nil || json.Unmarshal(refs, &parsed) != nil || len(parsed) != 1 {
			t.Fatalf("search citation unresolved: %q %s %v", text, refs, err)
		}
		ref := parsed[0]
		if ref.BlockID != block || ref.Text != ev.Text || ref.Hash != ev.Hash || ref.Revision != ev.Revision || string(ref.Location) != string(ev.Location) || ref.Precision != ev.Precision {
			t.Fatal("search citation lost provenance", string(refs))
		}
		if strings.Contains(text, "[S1]") != (ref.SourceID == "S1") {
			t.Fatal("invented or lost S alias", string(refs))
		}
	}
	for _, text := range []string{"[S1]", "[S999]", "[unknown-123]", "citeunknown-123", "[S1] unrelated " + block, "[S1]\n" + block} {
		if refs, err := a.references(text); err != nil || string(refs) != "[]" {
			t.Fatalf("unknown or nonadjacent source navigable: %q %s %v", text, refs, err)
		}
	}
	answer := "原文 [" + block + "]，对应 [S1] " + block + "\n正文 [S1]"
	if err := s.saveDocumentAgentAnswer(t.Context(), a, answer, "api"); err != nil {
		t.Fatal(err)
	}
	history, err := s.Store.chatHistory("doc")
	if err != nil || len(history) != 1 {
		t.Fatal(history, err)
	}
	message := history[0]
	var savedRefs []documentEvidence
	if err := json.Unmarshal(message.References, &savedRefs); err != nil || len(savedRefs) != 2 {
		t.Fatalf("mixed direct and alias citations lost a navigation key: %s %v", message.References, err)
	}
	base := "/api/documents/doc/messages/" + message.ID + "/sources/"
	for _, key := range []string{block, "S1"} {
		if out := request(t, s, "GET", base+key, nil); out.Code != 200 {
			t.Fatalf("source %s: %d %s", key, out.Code, out.Body.String())
		}
	}
	if out := request(t, s, "GET", base+"unknown-123", nil); out.Code != 409 {
		t.Fatal("unknown source accepted", out.Code)
	}
	state, err := s.Store.documentConversation(t.Context(), "doc", "api", "search-key")
	if err != nil || len(state.SearchedBlocks) != 1 || len(state.ReadBlocks) != 0 {
		t.Fatal("search not persisted separately", state, err)
	}
	next := &documentAgent{server: s, corpus: a.corpus, ctx: t.Context(), provider: "api"}
	input.Chat.History = history
	if _, err := next.beginConversation(t.Context(), input, "search-key"); err != nil {
		t.Fatal(err)
	}
	if refs, err := next.references("[" + block + "]"); err != nil || string(refs) == "[]" || len(next.Evidence) != 0 || len(next.turnRead) != 0 {
		t.Fatalf("search evidence not restored independently: %s %v", refs, err)
	}
	staleCorpus := *a.corpus
	staleCorpus.Revision = "changed"
	stale := &documentAgent{server: s, corpus: &staleCorpus, ctx: t.Context(), provider: "api"}
	if _, err := stale.beginConversation(t.Context(), input, "search-key"); err != nil {
		t.Fatal(err)
	}
	if refs, err := stale.references("[" + block + "]"); err != nil || string(refs) != "[]" || len(stale.Searched) != 0 {
		t.Fatalf("stale searched block revived: %s %v", refs, err)
	}
	// A matching self-hash is insufficient: compare the saved source to the
	// actual paragraph in the active corpus, not only to its own metadata.
	forged := []documentEvidence{{BlockID: block, SourceID: "S1", Text: "fabricated", Hash: sourceKey("fabricated"), Revision: a.corpus.Revision}}
	message.References = json.RawMessage(jsonText(forged))
	if _, err := s.Store.DB.Exec("UPDATE messages SET body=? WHERE id=?", jsonText(message), message.ID); err != nil {
		t.Fatal(err)
	}
	if out := request(t, s, "GET", base+"S1", nil); out.Code != 409 {
		t.Fatal("forged block content accepted", out.Code)
	}
	if err := os.WriteFile(filepath.Join(s.Store.Root, "cache", "doc", "manifest.json"), []byte(`{"readingOrder":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if out := request(t, s, "GET", base+block, nil); out.Code != 409 {
		t.Fatal("stale search citation accepted", out.Code)
	}
}

func TestSearchCitationAliasesNeverOverrideRealSources(t *testing.T) {
	_, a := originalDocumentFixture(t)
	if _, err := a.call(t.Context(), "search_document", json.RawMessage(`{"query":"COBALT-19"}`)); err != nil {
		t.Fatal(err)
	}
	var searched documentEvidence
	for _, ev := range a.Searched {
		searched = ev
	}
	if _, err := a.call(t.Context(), "read_passage", json.RawMessage(`{"full":true}`)); err != nil {
		t.Fatal(err)
	}
	real := a.Evidence[0]
	if real.BlockID == searched.BlockID {
		t.Fatal("fixture must have distinct real and aliased blocks")
	}
	refs, err := a.references("[" + real.SourceID + "] " + searched.BlockID + "\n正文 [" + real.SourceID + "]")
	var parsed []documentEvidence
	if err != nil || json.Unmarshal(refs, &parsed) != nil || len(parsed) != 1 || parsed[0].BlockID != real.BlockID {
		t.Fatalf("alias overrode read source: %s %v", refs, err)
	}
	a.Evidence = nil
	if refs, err := a.references("[S1] " + searched.BlockID + "\n[S1] unknown-123"); err != nil || string(refs) != "[]" {
		t.Fatalf("ambiguous alias acquired a target: %s %v", refs, err)
	}
	ev := a.Searched[searched.BlockID]
	ev.Revision = "old"
	a.Searched[searched.BlockID] = ev
	if refs, err := a.references("[" + searched.BlockID + "]"); err != nil || string(refs) != "[]" {
		t.Fatalf("stale in-memory search acquired a target: %s %v", refs, err)
	}
}

func TestNumericPrefixBlockCitationsAndCheckpointEvidence(t *testing.T) {
	ev := documentEvidence{BlockID: "123abc456def-182", Text: "original", Revision: "revision", Hash: sourceKey("original")}
	a := &documentAgent{corpus: &documentCorpus{Revision: ev.Revision}, Searched: map[string]documentEvidence{ev.BlockID: ev}}
	for _, text := range []string{"[" + ev.BlockID + "]", "cite" + ev.BlockID + "", "[S1] " + ev.BlockID} {
		if refs, err := a.references(text); err != nil || !strings.Contains(string(refs), `"blockId":"`+ev.BlockID+`"`) {
			t.Fatalf("numeric prefix lost: %s %s %v", text, refs, err)
		}
	}
	cp := piCheckpoint{Searched: a.Searched}
	var restored piCheckpoint
	if err := json.Unmarshal([]byte(jsonText(cp)), &restored); err != nil || restored.Searched[ev.BlockID].Hash != ev.Hash || len(restored.Evidence) != 0 {
		t.Fatal("checkpoint lost independent search evidence", restored, err)
	}
}

func TestLegacySourceWithoutBlockIDStillValidates(t *testing.T) {
	s, a := originalDocumentFixture(t)
	if _, err := a.call(t.Context(), "read_passage", json.RawMessage(`{"full":true}`)); err != nil {
		t.Fatal(err)
	}
	source := a.Evidence[0]
	if err := s.saveDocumentAgentAnswer(t.Context(), a, "["+source.SourceID+"]", "api"); err != nil {
		t.Fatal(err)
	}
	history, err := s.Store.chatHistory("doc")
	if err != nil || len(history) != 1 {
		t.Fatal(history, err)
	}
	message := history[0]
	source.BlockID = ""
	message.References = json.RawMessage(jsonText([]documentEvidence{source}))
	if _, err := s.Store.DB.Exec("UPDATE messages SET body=? WHERE id=?", jsonText(message), message.ID); err != nil {
		t.Fatal(err)
	}
	if out := request(t, s, "GET", "/api/documents/doc/messages/"+message.ID+"/sources/"+source.SourceID, nil); out.Code != 200 {
		t.Fatal("legacy S reference rejected", out.Code, out.Body.String())
	}
}
