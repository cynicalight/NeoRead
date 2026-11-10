package neoread

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTranslationInstructionsReachCLIProviders(t *testing.T) {
	for _, provider := range []string{"codex", "claude", "kimi"} {
		t.Run(provider, func(t *testing.T) {
			fakeAgent(t, provider, "success")
			s := testServer(t)
			capture := filepath.Join(t.TempDir(), "system.txt")
			t.Setenv("NEOREAD_SYSTEM_CAPTURE", capture)
			in := AIInput{Prompt: "Translate this paragraph.", SystemPrompt: translationSystemPrompt}
			if _, err := invokeCLI(t.Context(), s.Store.Root, provider, "", in, nil); err != nil {
				t.Fatal(err)
			}
			b, err := os.ReadFile(capture)
			if err != nil || !strings.Contains(string(b), translationSystemPrompt) || strings.Contains(string(b), readerFormulaRules) {
				t.Fatalf("wrong translation instructions: %q %v", b, err)
			}
		})
	}
}

func TestTranslationInstructionsReachPublicAPIProtocols(t *testing.T) {
	for _, protocol := range []string{"openai", "anthropic"} {
		t.Run(protocol, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					w.WriteHeader(400)
					return
				}
				var system any
				if protocol == "anthropic" {
					system = body["system"]
				} else {
					system = body["messages"].([]any)[0].(map[string]any)["content"]
				}
				if system != translationSystemPrompt {
					t.Errorf("translation system not forwarded: %v", system)
				}
				if protocol == "anthropic" {
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, anthropicTestWire("ok"))
				} else {
					writeAPIReply(w, "ok")
				}
			}))
			defer upstream.Close()
			_, err := invokeAPI(t.Context(), APIConnection{URL: upstream.URL, Protocol: protocol, Model: "test"}, AIInput{Prompt: "Translate", SystemPrompt: translationSystemPrompt}, nil)
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}
