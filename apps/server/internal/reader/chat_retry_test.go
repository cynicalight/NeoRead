package reader

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func chatMessages(t *testing.T, s *Server) []Message {
	t.Helper()
	res := request(t, s, "GET", "/api/documents/doc/messages", nil)
	var messages []Message
	if res.Code != 200 || json.Unmarshal(res.Body.Bytes(), &messages) != nil {
		t.Fatal("cannot read chat history", res.Body.String())
	}
	return messages
}

func TestChatRegenerationReusesQuestionWithCurrentModel(t *testing.T) {
	s, _ := prepareConversationFixture(t)
	models := []string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "test"}}})
			return
		}
		var payload struct {
			Model    string                  `json:"model"`
			Messages []toolCompletionMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
			return
		}
		models = append(models, payload.Model)
		if len(models) == 1 {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"unfinished answer\"}}]}\n\n")
			return
		}
		if strings.Count(jsonText(payload.Messages), "RETRY-QUESTION") != 1 || strings.Contains(jsonText(payload.Messages), "unfinished answer") {
			t.Error("retry duplicated the question or retained failed output", jsonText(payload.Messages))
		}
		writeConversationReply(w, "complete answer", "")
	}))
	defer upstream.Close()
	configureDocumentAPI(t, s, upstream.URL)
	body := `{"provider":"api","prompt":"RETRY-QUESTION","context":"original source","references":[],"readingLocation":{"type":"epub","href":"a.xhtml","progression":0},"userMessageId":"11111111111111111111111111111111"}`
	first := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(body))
	if !strings.Contains(first.Body.String(), "event: error") {
		t.Fatal("expected interrupted generation", first.Body.String())
	}
	before := chatMessages(t, s)
	if len(before) != 1 || before[0].Role != "user" {
		t.Fatal("failed answer persisted", before)
	}
	config := s.aiConfig()
	config.Models["api"] = "replacement-model"
	config.APIModels = append(config.APIModels, "replacement-model")
	passModels(&config, map[string]bool{"replacement-model": false})
	cap := config.Capabilities["api:replacement-model"]
	cap.Tools, cap.ToolSchemaVersion = "passed", documentToolSchemaVersion
	config.Capabilities["api:replacement-model"] = cap
	if err := s.writeAIConfig(config); err != nil {
		t.Fatal(err)
	}
	second := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(body))
	if !strings.Contains(second.Body.String(), "event: done") {
		t.Fatal("retry failed", second.Body.String())
	}
	after := chatMessages(t, s)
	if len(after) != 2 || after[0].ID != before[0].ID || after[0].CreatedAt != before[0].CreatedAt || after[1].Content != "complete answer" {
		t.Fatal("retry must replace failed attempt without duplicating question", after)
	}
	if len(models) != 2 || models[1] != "replacement-model" {
		t.Fatal("retry used stale model", models)
	}
	duplicate := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(body))
	if duplicate.Code != 409 || len(models) != 2 || len(chatMessages(t, s)) != 2 {
		t.Fatal("saved turn was regenerated", duplicate.Code, duplicate.Body.String())
	}
}

func TestChatRetryRejectsChangedOrNonTailQuestion(t *testing.T) {
	for _, kind := range []string{"prompt", "context", "references", "location", "answered", "later-question", "assistant-id", "foreign-id", "busy", "invalid-id"} {
		t.Run(kind, func(t *testing.T) {
			s, _ := prepareConversationFixture(t)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Error("rejected retry reached provider")
				w.WriteHeader(500)
			}))
			defer upstream.Close()
			configureDocumentAPI(t, s, upstream.URL)
			uid := "22222222222222222222222222222222"
			m := Message{ID: uid, DocumentID: "doc", Role: "user", Content: "original", Context: "source", References: json.RawMessage(`[{"text":"quote"}]`), ReadingLocation: json.RawMessage(`{"type":"epub","href":"a.xhtml","progression":0}`)}
			if kind == "assistant-id" {
				m.Role = "assistant"
			}
			if kind == "foreign-id" {
				if _, err := s.Store.DB.Exec("INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at) VALUES('other','epub','other','',0,?,?)", now(), now()); err != nil {
					t.Fatal(err)
				}
				m.DocumentID = "other"
			}
			if err := s.Store.saveMessage(m); err != nil {
				t.Fatal(err)
			}
			body := map[string]any{"provider": "api", "prompt": m.Content, "context": m.Context, "references": m.References, "readingLocation": m.ReadingLocation, "userMessageId": uid}
			wantStatus := 409
			switch kind {
			case "prompt":
				body["prompt"] = "different"
			case "context":
				body["context"] = "different"
			case "references":
				body["references"] = []any{}
			case "location":
				body["readingLocation"] = map[string]any{"type": "epub", "href": "b.xhtml"}
			case "answered", "later-question":
				role := "assistant"
				if kind == "later-question" {
					role = "user"
				}
				if err := s.Store.saveMessage(Message{DocumentID: "doc", Role: role, Content: "later"}); err != nil {
					t.Fatal(err)
				}
			case "busy":
				s.aiMu.Lock()
				defer s.aiMu.Unlock()
			case "invalid-id":
				body["userMessageId"] = "../invalid"
				wantStatus = 400
			}
			before := jsonText(chatMessages(t, s))
			out := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(jsonText(body)))
			if out.Code != wantStatus {
				t.Fatal("unexpected retry status", out.Code, out.Body.String())
			}
			if after := jsonText(chatMessages(t, s)); after != before {
				t.Fatal("rejected retry changed saved history", after)
			}
		})
	}
}

func TestChatRetryKeepsImagesAndUsesNewProvider(t *testing.T) {
	s, pixels := imageFixture(t)
	fakeAgent(t, "codex", "fail-after")
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "vision"}}})
			return
		}
		calls++
		var payload struct {
			Messages []struct {
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
			return
		}
		if !strings.Contains(string(payload.Messages[len(payload.Messages)-1].Content), imageData(pixels)) {
			t.Error("retry lost original image")
		}
		if len(payload.Messages) != 2 {
			t.Error("failed question repeated in history", len(payload.Messages))
		}
		writeConversationReply(w, "image answer", "")
	}))
	defer upstream.Close()
	config := AIConfig{Primary: "codex", API: APIConnection{URL: upstream.URL}, Models: map[string]string{"api": "vision"}, APIModels: []string{"vision"}, Capabilities: map[string]Capability{}}
	config.Capabilities["codex"] = Capability{Text: true, Vision: true, Fingerprint: configPrint(config, "codex")}
	passModels(&config, map[string]bool{"vision": true})
	if err := s.writeAIConfig(config); err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"provider": "codex", "prompt": "explain image", "context": "selected source", "attachments": []string{"p1-b1"}, "references": []any{map[string]string{"text": "selected source"}}, "readingLocation": map[string]any{"type": "pdf", "page": 1}, "userMessageId": "33333333333333333333333333333333"}
	first := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(jsonText(body)))
	if !strings.Contains(first.Body.String(), "event: error") {
		t.Fatal(first.Body.String())
	}
	before := chatMessages(t, s)
	body["provider"] = "api"
	second := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(jsonText(body)))
	if !strings.Contains(second.Body.String(), "event: done") {
		t.Fatal(second.Body.String())
	}
	after := chatMessages(t, s)
	if calls != 1 || len(after) != 2 || jsonText(before[0]) != jsonText(after[0]) || after[1].Content != "image answer" {
		t.Fatal("image retry changed question or left duplicates", after)
	}
}
