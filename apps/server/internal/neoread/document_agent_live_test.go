package neoread

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func TestLiveDocumentDeepSeek(t *testing.T) {
	path := os.Getenv("NEOREAD_TEST_DOCUMENT_API_CONFIG")
	if path == "" {
		t.Skip("set NEOREAD_TEST_DOCUMENT_API_CONFIG to NeoRead's existing connection config; no configuration is changed")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("NeoRead connection file unavailable")
	}
	var saved savedConfig
	if json.Unmarshal(data, &saved) != nil {
		t.Fatal("NeoRead connection config invalid")
	}
	connection := saved.Config.API
	if !strings.HasPrefix(connection.URL, "https://api.deepseek.com") || connection.Key == "" {
		t.Fatal("expected an existing official DeepSeek connection")
	}
	model := os.Getenv("NEOREAD_TEST_DOCUMENT_MODEL")
	if model == "" {
		for _, id := range []string{"deepseek-v4-pro", "deepseek-flash"} {
			if saved.Config.Capabilities[apiCapabilityKey(id)].Text {
				model = id
				break
			}
		}
	}
	if model == "" {
		t.Fatal("choose an already configured DeepSeek model")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Minute)
	defer cancel()
	status, err := probeAPIDocumentTools(ctx, connection, model)
	if err != nil || status != "passed" {
		t.Fatalf("DeepSeek tool round-trip: %s %v", status, err)
	}
	s, a := originalDocumentFixture(t)
	a.ctx = ctx
	input := AIInput{Prompt: "Read both sections of the original document. Report the cobalt protocol's exact nonce, its applicability condition, and the number of experiment transactions. Search and read original passages; cite [Snumber].", Chat: &chatInput{Question: "Compare definition and experiment", Agent: a}}
	var delta strings.Builder
	start := time.Now()
	first := time.Duration(0)
	result, err := streamAPIDocumentChat(ctx, connection, completionRequest{Model: model, Effort: "high", Tools: true}, input, func(event ProviderEvent) error {
		if event.Text != "" {
			if first == 0 {
				first = time.Since(start)
			}
			delta.WriteString(event.Text)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != delta.String() || !strings.Contains(result.Text, "37") || !strings.Contains(result.Text, "COBALT-19") || len(a.Evidence) < 2 {
		t.Fatalf("missing original evidence: calls=%d sources=%d answer=%s", len(a.Traces), len(a.Evidence), result.Text)
	}
	if _, err = a.references(result.Text); err != nil {
		t.Fatal(err)
	}
	for _, trace := range a.Traces {
		t.Logf("tool=%s args=%s", trace.Tool, trace.Arguments)
	}
	t.Logf("model=%s thinking=enabled effort=high elapsed=%s first-final-delta=%s sources=%d answer=%s", model, time.Since(start).Round(time.Millisecond), first.Round(time.Millisecond), len(a.Evidence), result.Text)
	_ = s
}
