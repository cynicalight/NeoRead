package neoread

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// withTestSkills swaps the registry for the duration of one test. Serial tests
// never overlap with t.Parallel tests, so the package-level swap is safe.
func withTestSkills(t *testing.T, skills ...Skill) {
	t.Helper()
	old := builtinSkills
	builtinSkills = skills
	t.Cleanup(func() { builtinSkills = old })
}

var testSkill = Skill{Name: "deep-read", Description: "逐段拆解论文方法与证据", Body: "先读摘要和结论，再核对每个实验的变量与样本。"}

func TestNormalizeChatSkills(t *testing.T) {
	withTestSkills(t, testSkill)
	if out, e := normalizeChatSkills(nil); e != nil || len(out) != 0 {
		t.Fatalf("empty request: %v %v", out, e)
	}
	out, e := normalizeChatSkills([]string{"deep-read", "", "deep-read"})
	if e != nil || len(out) != 1 || out[0] != "deep-read" {
		t.Fatalf("dedupe: %v %v", out, e)
	}
	if _, e = normalizeChatSkills([]string{"no-such-skill"}); e == nil {
		t.Fatal("unknown skill accepted")
	}
	many := []string{"a", "b", "c", "d"}
	withTestSkills(t,
		Skill{Name: "a"}, Skill{Name: "b"}, Skill{Name: "c"}, Skill{Name: "d"},
	)
	if _, e = normalizeChatSkills(many); e == nil || !strings.Contains(e.Error(), "3") {
		t.Fatalf("cap: %v", e)
	}
}

func TestSkillInstructions(t *testing.T) {
	if got := skillInstructions("base", nil); got != "base" {
		t.Fatalf("no skills must not touch the base prompt: %q", got)
	}
	withTestSkills(t, testSkill)
	got := skillInstructions("base", []string{"deep-read"})
	for _, want := range []string{"base", "<selected_skills>", "先读摘要和结论", "不可信资料", "</selected_skills>"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in %q", want, got)
		}
	}
	// An unknown name is skipped rather than emitted as an empty section.
	if got = skillInstructions("", []string{"ghost"}); got != "" {
		t.Fatalf("unknown skill injected: %q", got)
	}
}

func TestSkillsEndpoint(t *testing.T) {
	s := testServer(t)
	var empty struct {
		Skills []Skill `json:"skills"`
	}
	if e := json.Unmarshal(request(t, s, "GET", "/api/skills", nil).Body.Bytes(), &empty); e != nil {
		t.Fatal(e)
	}
	if len(empty.Skills) != 0 {
		t.Fatalf("registry should ship empty: %+v", empty.Skills)
	}
	withTestSkills(t, testSkill)
	var listed struct {
		Skills []Skill `json:"skills"`
	}
	if e := json.Unmarshal(request(t, s, "GET", "/api/skills", nil).Body.Bytes(), &listed); e != nil {
		t.Fatal(e)
	}
	if len(listed.Skills) != 1 || listed.Skills[0].Name != "deep-read" || listed.Skills[0].Description != testSkill.Description {
		t.Fatalf("listed: %+v", listed.Skills)
	}
	if listed.Skills[0].Body != "" {
		t.Fatal("skill body must never leave the server")
	}
}

// The API document path must fold selected skills into the system message and
// persist the selection on the user message for retry parity.
func TestAPIDocumentChatSkillsInjection(t *testing.T) {
	withTestSkills(t, testSkill)
	var system string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []toolCompletionMessage `json:"messages"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if len(body.Messages) > 0 && body.Messages[0].Role == "system" {
			if content, ok := body.Messages[0].Content.(string); ok {
				system = content
			}
		}
		writeAPIReply(w, "Original nonce [S2]")
	}))
	defer upstream.Close()
	_, a := originalDocumentFixture(t)
	in := AIInput{Prompt: "COBALT-19", Chat: &chatInput{Question: "COBALT-19", Skills: []string{"deep-read"}, Agent: a}}
	var text strings.Builder
	_, e := streamAPIDocumentChat(t.Context(), APIConnection{URL: upstream.URL}, completionRequest{Model: "plain"}, in, func(v ProviderEvent) error { text.WriteString(v.Text); return nil })
	if e != nil || text.Len() == 0 {
		t.Fatalf("chat failed: %v", e)
	}
	if !strings.Contains(system, "先读摘要和结论") || !strings.Contains(system, "不可信资料") {
		t.Fatalf("skill body missing from system prompt: %q", system)
	}
	// A turn without skills keeps the plain instructions.
	system = ""
	in2 := AIInput{Prompt: "COBALT-19", Chat: &chatInput{Question: "COBALT-19", Agent: a}}
	if _, e = streamAPIDocumentChat(t.Context(), APIConnection{URL: upstream.URL}, completionRequest{Model: "plain"}, in2, func(v ProviderEvent) error { text.WriteString(v.Text); return nil }); e != nil {
		t.Fatal(e)
	}
	if strings.Contains(system, "<selected_skills>") {
		t.Fatalf("skills leaked without selection: %q", system)
	}
}

func TestSameChatQuestionCoversSkills(t *testing.T) {
	base := Message{Role: "user", Content: "q", Skills: []string{"a"}}
	if sameChatQuestion(base, Message{Role: "user", Content: "q", Skills: []string{"a"}}) != true {
		t.Fatal("identical skills diverged")
	}
	if sameChatQuestion(base, Message{Role: "user", Content: "q"}) {
		t.Fatal("missing skills accepted")
	}
	if sameChatQuestion(base, Message{Role: "user", Content: "q", Skills: []string{"b"}}) {
		t.Fatal("changed skills accepted")
	}
}
