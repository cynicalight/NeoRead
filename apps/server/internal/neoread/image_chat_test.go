package neoread

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func imageFixture(t *testing.T) (*Server, []byte) {
	t.Helper()
	s, _ := processingFixture(t)
	s.Token = "test-secret"
	data, _, err := visionProbe()
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(s.analysisDir("doc"), "assets", "p1-b1.png"), data, 0600); err != nil {
		t.Fatal(err)
	}
	return s, data
}
func TestBlockImageAuthorizationAndBoundaries(t *testing.T) {
	s, data := imageFixture(t)
	good := request(t, s, "GET", "/pub/test-secret/doc/assets/p1-b1.png", nil)
	if good.Code != 200 || good.Header().Get("Content-Type") != "image/png" || !bytes.Equal(good.Body.Bytes(), data) {
		t.Fatal("image resource failed", good.Code)
	}
	for _, path := range []string{"/pub/wrong/doc/assets/p1-b1.png", "/pub/test-secret/doc/assets/p1-b2.png", "/pub/test-secret/missing/assets/p1-b1.png"} {
		if res := request(t, s, "GET", path, nil); res.Code == 200 {
			t.Fatal("invalid resource accepted", path)
		}
	}
	if _, _, err := s.readBlockImage("doc", "../../ai-connections"); err == nil {
		t.Fatal("path accepted")
	}
	external := filepath.Join(t.TempDir(), "outside.png")
	os.WriteFile(external, data, 0600)
	asset := filepath.Join(s.analysisDir("doc"), "assets", "p1-b1.png")
	os.Remove(asset)
	if err := os.Symlink(external, asset); err != nil {
		if runtime.GOOS == "windows" && os.IsPermission(err) {
			t.Skip("symlink creation requires Windows privilege")
		}
		t.Fatal(err)
	}
	if _, _, err := s.readBlockImage("doc", "p1-b1"); err == nil {
		t.Fatal("symlink escaped analysis root")
	}
}
func TestImageChatSendsPixelsAndRecordsAttachmentWithFallback(t *testing.T) {
	s, data := imageFixture(t)
	layout, err := s.readLayout("doc")
	if err != nil {
		t.Fatal(err)
	}
	before, after := layout.Blocks[0], layout.Blocks[0]
	before.ID, before.Label, before.Image, before.Text = "p1-b2", "text", "", "PREVIOUS: experimental conditions"
	after.ID, after.Label, after.Image, after.Text = "p1-b3", "text", "", "FOLLOWING: Figure 5 caption"
	layout.Blocks = []PDFBlock{before, layout.Blocks[0], after}
	encoded, err := json.Marshal(layout)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), encoded, 0600); err != nil {
		t.Fatal(err)
	}

	calls := 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var body struct {
			Messages []struct {
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		var content []struct {
			Type     string `json:"type"`
			ImageURL struct {
				URL string `json:"url"`
			} `json:"image_url"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		if len(body.Messages) != 2 {
			t.Error("expected system and user messages")
			return
		}
		if err := json.Unmarshal(body.Messages[1].Content, &content); err != nil {
			t.Error(err)
			return
		}
		for _, want := range []string{"PREVIOUS: experimental conditions", "FOLLOWING: Figure 5 caption"} {
			if !strings.Contains(string(body.Messages[1].Content), want) {
				t.Errorf("missing image neighbor in provider request: %s", want)
			}
		}
		if len(content) != 2 || content[1].ImageURL.URL != imageData(data) {
			t.Error("original image pixels missing")
		}
		w.Header().Set("Content-Type", "application/json")
		writeAPIReply(w, "Image explanation")
	}))
	defer api.Close()
	config := AIConfig{Primary: "codex", Models: map[string]string{}, ImageAPI: APIConnection{URL: api.URL, Model: "vision"}, Capabilities: map[string]Capability{}}
	config.Capabilities["image-api"] = Capability{Text: true, Vision: true, Fingerprint: configPrint(config, "image-api")}
	if err := s.writeAIConfig(config); err != nil {
		t.Fatal(err)
	}
	res := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(`{"provider":"codex","prompt":"Explain","context":"source","attachments":["p1-b1","p1-b1"]}`))
	if res.Code != 200 || !strings.Contains(res.Body.String(), "event: fallback") || !strings.Contains(res.Body.String(), "event: done") || calls != 1 {
		t.Fatalf("chat failed: %d %s", res.Code, res.Body.String())
	}
	messages := request(t, s, "GET", "/api/documents/doc/messages", nil)
	var stored []Message
	if err := json.Unmarshal(messages.Body.Bytes(), &stored); err != nil {
		t.Fatal(err)
	}
	if len(stored) != 2 || len(stored[0].Attachments) != 1 || stored[0].Attachments[0].ID != "p1-b1" || stored[1].Content != "Image explanation" {
		t.Fatalf("attachment not persisted: %+v", stored)
	}
	for _, want := range []string{"PREVIOUS: experimental conditions", "FOLLOWING: Figure 5 caption"} {
		if strings.Count(stored[0].Context, want) != 1 {
			t.Fatalf("neighbor not persisted exactly once: %s", stored[0].Context)
		}
	}
}
func TestImageChatRejectsInvalidOrUnverifiedInput(t *testing.T) {
	s, _ := imageFixture(t)
	for _, ids := range []string{`["p1-b1"]`, `["../secret"]`, `["p1-b2"]`, `["p1-b1","p1-b1","p1-b1","p1-b1","p1-b1"]`} {
		res := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(`{"provider":"codex","prompt":"Explain","context":"","attachments":`+ids+`}`))
		if res.Code != 400 {
			t.Fatalf("expected rejection: %d %s", res.Code, res.Body.String())
		}
	}
	var count int
	if err := s.Store.DB.QueryRow("SELECT count(*) FROM messages").Scan(&count); err != nil || count != 0 {
		t.Fatal("failed validation stored a message")
	}
}

func TestImageAPIKeepsMultipleAttachments(t *testing.T) {
	data, _, err := visionProbe()
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := visionProbe()
	if err != nil {
		t.Fatal(err)
	}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []struct {
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		var content []struct {
			ImageURL struct {
				URL string `json:"url"`
			} `json:"image_url"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		if len(body.Messages) != 2 {
			t.Error("expected system and user messages")
			return
		}
		if err := json.Unmarshal(body.Messages[1].Content, &content); err != nil {
			t.Error(err)
			return
		}
		if len(content) != 3 {
			t.Error("not all images transmitted")
		} else if content[1].ImageURL.URL != imageData(data) || content[2].ImageURL.URL != imageData(second) {
			t.Error("image ordering changed")
		}
		writeAPIReply(w, "Both images received")
	}))
	defer api.Close()
	_, err = invokeAPI(t.Context(), APIConnection{URL: api.URL, Model: "vision"}, AIInput{Prompt: "Compare", Images: [][]byte{data, second}}, nil)
	if err != nil {
		t.Fatal(err)
	}
}

func TestImageParagraphsUseReadingOrderWithoutCaptionClassification(t *testing.T) {
	blocks := []PDFBlock{
		{ID: "far", Page: 1, Label: "text", Text: "too far"},
		{ID: "before", Page: 1, Label: "text", Text: "Table 5: experimental conditions"},
		{ID: "footer", Page: 1, Label: "footer", Text: "footer"},
		{ID: "image", Page: 2, Label: "chart", Image: "asset.png"},
		{ID: "formula", Page: 2, Label: "display_formula", Text: "formula"},
		{ID: "number", Page: 2, Label: "formula_number", Text: "(1)"},
		{ID: "other", Page: 2, Label: "image", Text: "other image text"},
		{ID: "empty", Page: 2, Label: "text", Text: " "},
		{ID: "after", Page: 2, Label: "text", Text: "Figure 5: interpretation"},
		{ID: "last", Page: 2, Label: "text", Text: "also too far"},
	}
	got := imageParagraphs(blocks, "image")
	for _, want := range []string{"图片前一段原文：\n第 1 页：Table 5: experimental conditions", "图片后一段原文：\n第 2 页：Figure 5: interpretation"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing neighboring paragraph: %s", got)
		}
	}
	for _, excluded := range []string{"too far", "footer", "formula", "other image text", "(1)"} {
		if strings.Contains(got, excluded) {
			t.Fatalf("unexpected context: %s", got)
		}
	}
	if imageParagraphs(blocks, "missing") != "" {
		t.Fatal("invented context for missing block")
	}
	if got := imageParagraphs(blocks[3:4], "image"); got != "" {
		t.Fatal("invented missing neighbors", got)
	}
	if got := imageParagraphs(blocks[3:], "image"); strings.Contains(got, "图片前一段") || !strings.Contains(got, "图片后一段") {
		t.Fatal("incorrect start boundary", got)
	}
	if got := imageParagraphs(blocks[:4], "image"); !strings.Contains(got, "图片前一段") || strings.Contains(got, "图片后一段") {
		t.Fatal("incorrect end boundary", got)
	}
}
