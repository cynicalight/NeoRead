package reader

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTranslationPromptSettingsPreserveAndReset(t *testing.T) {
	s, _, _ := translationFixture(t)
	value := "自然流畅，保留英文术语"
	c := AIConfig{Primary: "codex", TranslationPrompt: &value}
	for _, step := range []struct {
		prompt *string
		want   string
	}{{&value, value}, {nil, value}, {new(string), ""}} {
		c.TranslationPrompt = step.prompt
		out := request(t, s, "PUT", "/api/ai/config", strings.NewReader(jsonText(c)))
		if out.Code != 200 {
			t.Fatal(out.Code, out.Body.String())
		}
		stored := s.aiConfig().TranslationPrompt
		if stored == nil || *stored != step.want {
			t.Fatalf("preference not preserved/reset: %v", stored)
		}
	}
	long := strings.Repeat("字", 6001)
	c.TranslationPrompt = &long
	if out := request(t, s, "PUT", "/api/ai/config", strings.NewReader(jsonText(c))); out.Code != 400 {
		t.Fatal("unbounded preference", out.Code)
	}
}

func TestTranslationPromptAppliesToTextButNotChatOrSource(t *testing.T) {
	s, p, m := translationFixture(t)
	var prompts []string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
			return
		}
		prompt := req.Messages[len(req.Messages)-1].Content
		prompts = append(prompts, prompt)
		if strings.Contains(prompt, "输入资料：") {
			writeAPIReply(w, translationLine(m.Blocks[0])+translationLine(m.Blocks[1]))
		} else {
			writeAPIReply(w, "划词译文")
		}
	}))
	defer provider.Close()
	configureTranslationTest(t, s, provider.URL)
	c := s.aiConfig()
	value := "自然中文，transaction 译为事务"
	c.TranslationPrompt = &value
	if err := s.writeAIConfig(c); err != nil {
		t.Fatal(err)
	}
	if err := s.processTranslation(t.Context(), &p); err != nil {
		t.Fatal(err)
	}
	g := s.taskGenerationService(c, taskTranslation)
	if _, err := generateSelectionTranslation(t.Context(), g, selectionTranslationInput{Text: "transaction"}); err != nil {
		t.Fatal(err)
	}
	if len(prompts) != 2 {
		t.Fatal(prompts)
	}
	for _, prompt := range prompts {
		if !strings.Contains(prompt, value) {
			t.Fatal("preference missing", prompt)
		}
	}
	if !strings.Contains(prompts[0], "只输出 JSONL") || !strings.Contains(prompts[0], "不可信") || !strings.Contains(prompts[0], `"source":"First sentence. Second sentence."`) {
		t.Fatal("preference replaced the format/source contract")
	}
	if s.taskGenerationService(c, taskChat).translationInstructions != "" {
		t.Fatal("translation preference leaked into chat")
	}
}
