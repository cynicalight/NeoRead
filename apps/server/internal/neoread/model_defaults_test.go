package neoread

import (
	"fmt"
	"strings"
	"testing"
)

func catalog(ids ...string) []AgentModel {
	models := []AgentModel{}
	for i, id := range ids {
		models = append(models, AgentModel{ID: id, Name: id, Default: i == 0})
	}
	return models
}

func TestDefaultTaskModelPerAgent(t *testing.T) {
	codex := catalog("gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna")
	claude := catalog("claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6")
	claude[1].Aliases = []string{"sonnet"}
	kimi := catalog("moonshot-cn/kimi-k3", "moonshot-cn/kimi-k2.7-code")
	for _, tt := range []struct {
		name     string
		task     modelTask
		provider string
		models   []AgentModel
		want     string
	}{
		{"codex chat takes the newest sol, never astra", taskChat, "codex", codex, "gpt-6.1-sol"},
		{"codex translation takes the newest luna", taskTranslation, "codex", codex, "gpt-6-luna"},
		{"claude chat takes the newest opus, never fable", taskChat, "claude", claude, "claude-opus-5-5"},
		{"claude translation takes the newest sonnet", taskTranslation, "claude", claude, "claude-sonnet-5-5"},
		{"claude translation falls back to haiku", taskTranslation, "claude", catalog("claude-opus-5-5", "claude-haiku-4-5-20251001", "claude-haiku-3-5"), "claude-haiku-4-5-20251001"},
		{"kimi keeps its CLI default", taskChat, "kimi", kimi, ""},
		{"kimi has no fast tier", taskTranslation, "kimi", kimi, ""},
		{"kimi flash tier", taskTranslation, "kimi", catalog("kimi-k3", "kimi-k3-flash"), "kimi-k3-flash"},
		{"general beats code variant", taskTranslation, "codex", catalog("gpt-7-codex-mini", "gpt-6-mini"), "gpt-6-mini"},
		{"whole tokens only", taskTranslation, "codex", catalog("gemini-pro", "lunar-x"), ""},
		{"empty catalog", taskChat, "claude", nil, ""},
		{"6.1 beats 6", taskChat, "codex", catalog("gpt-6-sol", "gpt-6.1-sol", "gpt-5.6-sol"), "gpt-6.1-sol"},
		{"6.10 beats 6.9", taskChat, "codex", catalog("gpt-6.9-sol", "gpt-6.10-sol"), "gpt-6.10-sol"},
		{"6 beats 5.6", taskTranslation, "codex", catalog("gpt-5.6-luna", "gpt-6-luna"), "gpt-6-luna"},
		{"date snapshot is not a version", taskChat, "codex", catalog("gpt-6-sol-2026-01-15", "gpt-6.1-sol"), "gpt-6.1-sol"},
		{"claude dated id", taskTranslation, "claude", catalog("claude-haiku-4-5-20251001", "claude-haiku-4-6"), "claude-haiku-4-6"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := defaultTaskModel(tt.task, tt.provider, tt.models); got != tt.want {
				t.Fatalf("got %q want %q", got, tt.want)
			}
		})
	}
}

func TestTaskRecommendationsMarkCatalog(t *testing.T) {
	models := taskRecommendations("claude", catalog("claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"))
	got := map[string]string{}
	for _, m := range models {
		got[m.ID] = strings.Join(m.RecommendedFor, ",")
	}
	if got["claude-opus-5-5"] != "chat" || got["claude-sonnet-5-5"] != "translation" || got["claude-fable-5-1"] != "" {
		t.Fatal(got)
	}
}

func TestModelVersion(t *testing.T) {
	for id, want := range map[string]string{
		"gpt-6.1-sol":                "[6 1]",
		"gpt-6-sol-2026-01-15":       "[6]",
		"claude-haiku-4-5-20251001":  "[4 5]",
		"claude-3-5-sonnet-20241022": "[3 5]",
		"moonshot-cn/kimi-k2.7-code": "[2 7]",
	} {
		if got := fmt.Sprint(modelVersion(id)); got != want {
			t.Fatalf("%s: got %s want %s", id, got, want)
		}
	}
}
