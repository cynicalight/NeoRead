package neoread

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Inspect instructions at the provider boundary, for text and image requests.
func TestAPISystemPrompt(t *testing.T) {
	for _, vision := range []bool{false, true} {
		t.Run(fmt.Sprintf("image=%t", vision), func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body struct {
					Messages []struct {
						Role    string          `json:"role"`
						Content json.RawMessage `json:"content"`
					} `json:"messages"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Messages) != 2 {
					t.Error("expected system and user messages", err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				var system string
				if err := json.Unmarshal(body.Messages[0].Content, &system); err != nil || system != readerSystemPrompt || body.Messages[0].Role != "system" || body.Messages[1].Role != "user" {
					t.Error("shared system prompt missing or incorrectly scoped", err)
				}
				if !strings.Contains(string(body.Messages[1].Content), "Explain") || (vision && !strings.Contains(string(body.Messages[1].Content), "data:image/png;base64,")) {
					t.Error("user content lost")
				}
				writeAPIReply(w, "ok")
			}))
			defer upstream.Close()
			in := AIInput{Prompt: "Explain"}
			if vision {
				in.Image = []byte{1}
			}
			if _, err := invokeAPI(t.Context(), APIConnection{URL: upstream.URL, Model: "test"}, in, nil); err != nil {
				t.Fatal(err)
			}
		})
	}
}
