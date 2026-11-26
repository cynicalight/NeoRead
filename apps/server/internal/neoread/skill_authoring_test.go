package neoread

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"neoread.local/server/internal/diagnostics"
)

func saveSkillForTest(t *testing.T, s *Server, draft skillDraft, overwrite bool) *httptest.ResponseRecorder {
	t.Helper()
	return request(t, s, "POST", "/api/skills", strings.NewReader(jsonText(struct {
		skillDraft
		Overwrite bool `json:"overwrite"`
	}{draft, overwrite})))
}

func TestSaveSkillValidation(t *testing.T) {
	home := localSkillTestHome(t)
	s := testServer(t)
	for _, name := range []string{"", "../escape", "a/b", `a\b`, "white space", "Upper", "snake_case", "中", strings.Repeat("a", 65)} {
		if out := saveSkillForTest(t, s, skillDraft{name, "Description", "Body"}, false); out.Code != 400 {
			t.Errorf("name %q: got %d", name, out.Code)
		}
	}
	for _, in := range []string{
		`{"name":"n","description":" ","body":"body"}`,
		`{"name":"n","description":"description","body":"\n"}`,
		`{"name":"n","description":"description","body":"body"}{}`,
		`{"name":"n","description":"description","body":"body","path":"elsewhere"}`,
		strings.Repeat(" ", maxSkillJSONBytes+1),
	} {
		if out := request(t, s, "POST", "/api/skills", strings.NewReader(in)); out.Code != 400 {
			t.Errorf("invalid input returned %d", out.Code)
		}
	}
	if _, err := os.Stat(filepath.Join(home, ".agents")); !os.IsNotExist(err) {
		t.Fatalf("invalid requests touched skill storage: %v", err)
	}

	name := strings.Repeat("a", 62) + "-9"
	draft := skillDraft{name, "描述", "x"}
	header, err := draft.frontMatter()
	if err != nil {
		t.Fatal(err)
	}
	draft.Body = strings.Repeat("x", maxSkillBytes-len(header)+1)
	if out := saveSkillForTest(t, s, draft, false); out.Code != 400 {
		t.Fatalf("over cap including front matter: %d", out.Code)
	}
	draft.Body = draft.Body[:len(draft.Body)-1]
	if out := saveSkillForTest(t, s, draft, false); out.Code != 201 {
		t.Fatal(out.Code, out.Body.String())
	}
	path := filepath.Join(home, ".agents", "skills", name, skillFilename)
	info, err := os.Stat(path)
	if err != nil || info.Size() != maxSkillBytes {
		t.Fatalf("file should be exactly 64 KiB: %v, %v", info, err)
	}
}

func TestSaveSkillAtomicOverwriteAndDiagnostics(t *testing.T) {
	home := localSkillTestHome(t)
	s := testServer(t)
	logDir := filepath.Join(s.Store.Root, "logs")
	logs, err := diagnostics.New(logDir, "skill-authoring-test")
	if err != nil {
		t.Fatal(err)
	}
	s.SetDiagnostics(logs)
	draft := skillDraft{"make-notes", "PRIVATE-DESCRIPTION:\n---\nname: injected", "# PRIVATE-BODY\n  Indented text\n"}
	out := saveSkillForTest(t, s, draft, false)
	var summary skillMetadata
	if out.Code != 201 || json.Unmarshal(out.Body.Bytes(), &summary) != nil || summary != (skillMetadata{draft.Name, draft.Description, "agents"}) {
		t.Fatal(out.Code, out.Body.String())
	}
	if got := listLocalSkillsForTest(t, s); len(got) != 1 || got[0] != summary {
		t.Fatalf("saved skill not discoverable: %+v", got)
	}
	dir := filepath.Join(home, ".agents", "skills", draft.Name)
	path := filepath.Join(dir, skillFilename)
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	meta, body, ok := parseSkill(original)
	if !ok || meta.Name != draft.Name || meta.Description != draft.Description || string(body) != draft.Body {
		t.Fatalf("unexpected front matter or Markdown: %q", original)
	}
	oldLink := filepath.Join(dir, "old-file")
	if err := os.Link(path, oldLink); err != nil {
		t.Fatal(err)
	}
	draft.Body = "# PRIVATE-REPLACEMENT"
	if out := saveSkillForTest(t, s, draft, false); out.Code != 409 {
		t.Fatal(out.Code, out.Body.String())
	}
	if file, err := os.ReadFile(path); err != nil || !bytes.Equal(file, original) {
		t.Fatalf("conflict clobbered the file: %v", err)
	}
	if out := saveSkillForTest(t, s, draft, true); out.Code != 201 {
		t.Fatal(out.Code, out.Body.String())
	}
	header, _ := draft.frontMatter()
	expected := append(header, draft.Body...)
	if file, err := os.ReadFile(path); err != nil || !bytes.Equal(file, expected) {
		t.Fatalf("replacement file was incomplete: %v", err)
	}
	if file, err := os.ReadFile(oldLink); err != nil || !bytes.Equal(file, original) {
		t.Fatalf("overwrite mutated the old inode instead of replacing it: %v", err)
	}
	if runtime.GOOS != "windows" {
		for file, mode := range map[string]os.FileMode{path: 0644, dir: 0755, filepath.Dir(dir): 0755, filepath.Dir(filepath.Dir(dir)): 0755} {
			if info, err := os.Stat(file); err != nil || info.Mode().Perm() != mode {
				t.Errorf("%s: %v, %v, want mode %o", file, info, err, mode)
			}
		}
	}
	if entries, err := os.ReadDir(dir); err != nil || len(entries) != 2 {
		t.Fatalf("save left temporary files: %v, %v", entries, err)
	}
	files, err := filepath.Glob(filepath.Join(logDir, "*.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var logged strings.Builder
	for _, path := range files {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		logged.Write(data)
	}
	for _, marker := range []string{"skills.saved", `"name":"make-notes"`, fmt.Sprintf(`"bytes":%d`, len(original))} {
		if !strings.Contains(logged.String(), marker) {
			t.Errorf("missing diagnostic marker %s", marker)
		}
	}
	if strings.Contains(logged.String(), "PRIVATE-") || strings.Contains(logged.String(), skillFilename) {
		t.Fatal("diagnostics leaked the skill body, description, or path")
	}
}

func TestSaveSkillConcurrentNoClobber(t *testing.T) {
	home := localSkillTestHome(t)
	s := testServer(t)
	const writers = 12
	type result struct {
		code int
		body string
	}
	start := make(chan struct{})
	results := make(chan result, writers)
	for i := range writers {
		go func() {
			body := strings.Repeat(fmt.Sprintf("%02d", i), 16384)
			<-start
			out := saveSkillForTest(t, s, skillDraft{"race", "A skill", body}, false)
			results <- result{out.Code, body}
		}()
	}
	close(start)
	var winner string
	for range writers {
		r := <-results
		switch r.code {
		case 201:
			if winner != "" {
				t.Error("more than one writer reported success")
			}
			winner = r.body
		case 409:
		default:
			t.Errorf("unexpected save response %d", r.code)
		}
	}
	if winner == "" {
		t.Fatal("no writer won")
	}
	dir := filepath.Join(home, ".agents", "skills", "race")
	got, err := os.ReadFile(filepath.Join(dir, skillFilename))
	header, _ := (skillDraft{"race", "A skill", winner}).frontMatter()
	want := append(header, winner...)
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("winning skill not published intact: %v", err)
	}
	if entries, err := os.ReadDir(dir); err != nil || len(entries) != 1 {
		t.Fatalf("conflicts left temporary files: %v, %v", entries, err)
	}
}

func TestSaveSkillConfinement(t *testing.T) {
	for _, path := range []string{".agents", ".agents/skills", ".agents/skills/example", ".agents/skills/example/SKILL.md"} {
		t.Run(path, func(t *testing.T) {
			home := localSkillTestHome(t)
			s := testServer(t)
			outside := t.TempDir()
			target := outside
			isFile := strings.HasSuffix(path, skillFilename)
			if isFile {
				target = writeLocalSkillTestFile(t, filepath.Join(outside, "untouched"), "outside")
			}
			link := filepath.Join(home, filepath.FromSlash(path))
			if err := os.MkdirAll(filepath.Dir(link), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, link); err != nil {
				if runtime.GOOS == "windows" {
					t.Skipf("symlink permission unavailable: %v", err)
				}
				t.Fatal(err)
			}
			draft := skillDraft{"example", "Description", "Body"}
			want, wantOverwrite := 400, 400
			if isFile {
				want, wantOverwrite = 409, 500
			}
			if out := saveSkillForTest(t, s, draft, false); out.Code != want {
				t.Fatal(out.Code, out.Body.String())
			}
			if out := saveSkillForTest(t, s, draft, true); out.Code != wantOverwrite ||
				(!isFile && !strings.Contains(out.Body.String(), "技能目录是符号链接，不能保存或覆盖")) {
				t.Fatal(out.Code, out.Body.String())
			}
			if after, err := os.Readlink(link); err != nil || after != target {
				t.Fatalf("symlink was changed: %q, %v", after, err)
			}
			if isFile {
				if data, err := os.ReadFile(target); err != nil || string(data) != "outside" {
					t.Fatalf("writes escaped through the file symlink: %q, %v", data, err)
				}
			} else if files, err := os.ReadDir(outside); err != nil || len(files) != 0 {
				t.Fatalf("writes escaped through a directory symlink: %v, %v", files, err)
			}
		})
	}
}

func TestDraftSkillRequestValidation(t *testing.T) {
	s := testServer(t)
	stamp := now()
	if _, err := s.Store.DB.Exec(`INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,deleted_at)
		VALUES('doc','epub','Document','',0,?,?,''),
		      ('other','epub','Other','',0,?,?,''),
		      ('deleted','epub','Deleted','',0,?,?,?)`, stamp, stamp, stamp, stamp, stamp, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.DB.Exec(`INSERT INTO chat_sessions(id,document_id,title,provider,created_at,updated_at)
		VALUES('foreign','other','Other','api',?,?)`, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, body string
		status     int
	}{
		{"missing document id", `{"request":"draft"}`, 400},
		{"bad id", `{"documentId":"doc ","request":"draft"}`, 400},
		{"bad session id", `{"documentId":"doc","sessionId":"\n","request":"draft"}`, 400},
		{"blank request", `{"documentId":"doc","request":" \n "}`, 400},
		{"request exceeds byte cap", jsonText(map[string]string{"documentId": "doc", "request": strings.Repeat("中", maxSkillDraftRequestBytes/3+1)}), 400},
		{"payload exceeds cap", strings.Repeat(" ", 6*maxSkillDraftRequestBytes+2049), 400},
		{"unknown field", `{"documentId":"doc","request":"draft","provider":"untrusted"}`, 400},
		{"trailing JSON", `{"documentId":"doc","request":"draft"}[]`, 400},
		{"missing document", `{"documentId":"unknown","request":"draft"}`, 404},
		{"deleted document", `{"documentId":"deleted","request":"draft"}`, 404},
		{"missing session", `{"documentId":"doc","sessionId":"unknown","request":"draft"}`, 404},
		{"foreign session", `{"documentId":"doc","sessionId":"foreign","request":"draft"}`, 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if out := request(t, s, "POST", "/api/skills/draft", strings.NewReader(tc.body)); out.Code != tc.status {
				t.Fatalf("got %d, want %d: %s", out.Code, tc.status, out.Body.String())
			}
		})
	}
}

func TestDraftSkillUsesCurrentAgentAndBoundedSession(t *testing.T) {
	piTestRuntime(t)
	home := localSkillTestHome(t)
	s, _ := originalDocumentFixture(t)
	defaultID, err := s.ensureChatSession("doc", "api")
	if err != nil {
		t.Fatal(err)
	}
	selected := createSessionTest(t, s)
	if _, err := s.Store.DB.Exec("UPDATE chat_sessions SET provider='codex' WHERE id=?", selected.ID); err != nil {
		t.Fatal(err)
	}
	add := func(id, sid, role, text, reasoning string) {
		t.Helper()
		if err := s.Store.saveMessage(Message{ID: id, DocumentID: "doc", SessionID: sid, Role: role, Content: text, Reasoning: reasoning}); err != nil {
			t.Fatal(err)
		}
	}
	add("default", defaultID, "user", "默认会话", "")
	add("unassigned", "", "user", "未分配的历史", "")
	for i := range maxSkillDraftMessages + 1 {
		add(fmt.Sprintf("selected-%d", i), selected.ID, "user", fmt.Sprintf("问题%d", i), "")
	}
	long := strings.Repeat("文", maxSkillDraftMessageRunes)
	add("latest", selected.ID, "assistant", long+"TRUNCATED", "PRIVATE-REASONING")
	add("tool", selected.ID, "tool", "PRIVATE-TOOL", "")

	wantDraft := skillDraft{"drafted", "技能描述", "# 草稿正文"}
	type promptInput struct {
		Request      string
		Conversation []skillDraftMessage
	}
	seen := make(chan promptInput, 2)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "test"}}})
			return
		}
		var payload struct {
			Messages []struct {
				Role, Content string
			}
			Tools []any
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || len(payload.Messages) != 2 || len(payload.Tools) != 0 {
			t.Errorf("expected tool-free one-shot prompt: %+v, %v", payload, err)
			w.WriteHeader(400)
			return
		}
		if system := payload.Messages[0]; system.Role != "system" || !strings.Contains(system.Content, "不可信的历史对话") {
			t.Errorf("missing system instruction to treat conversation as untrusted: %+v", system)
		}
		var in promptInput
		if user := payload.Messages[1]; user.Role != "user" || json.Unmarshal([]byte(user.Content), &in) != nil ||
			strings.Contains(user.Content, "PRIVATE-") || strings.Contains(user.Content, "fixture original") {
			t.Error("invalid prompt or extra private content")
		}
		seen <- in
		writeAPIReply(w, jsonText(wantDraft))
	}))
	defer api.Close()
	configureDocumentAPI(t, s, api.URL)
	for _, sid := range []string{selected.ID, ""} {
		out := request(t, s, "POST", "/api/skills/draft", strings.NewReader(jsonText(map[string]string{
			"documentId": "doc", "sessionId": sid, "request": " 提炼成技能 ",
		})))
		var got skillDraft
		if out.Code != 200 || json.Unmarshal(out.Body.Bytes(), &got) != nil || got != wantDraft {
			t.Fatal(out.Code, out.Body.String())
		}
		in := <-seen
		if in.Request != "提炼成技能" {
			t.Fatalf("wrong draft request: %q", in.Request)
		}
		if sid == "" {
			if len(in.Conversation) != 1 || in.Conversation[0].Content != "默认会话" {
				t.Fatalf("did not use default session: %+v", in.Conversation)
			}
		} else {
			if len(in.Conversation) != maxSkillDraftMessages || in.Conversation[0].Content != "问题2" ||
				in.Conversation[maxSkillDraftMessages-1] != (skillDraftMessage{"assistant", long}) {
				t.Fatal("wrong session, ordering, or transcript bounds")
			}
		}
	}
	if _, err := os.Stat(filepath.Join(home, ".agents")); !os.IsNotExist(err) {
		t.Fatalf("draft touched the skill directory: %v", err)
	}
}

func TestDraftSkillValidatesModelOutput(t *testing.T) {
	draft := skillDraft{"drafted", "Description", "# Body"}
	if got, ok := parseSkillDraft(jsonText(draft)); !ok || got != draft {
		t.Fatalf("valid model output rejected: %+v", got)
	}
	draft.Body = strings.Repeat("a", maxSkillBytes)
	for _, raw := range []string{
		`{"name":"../escape","description":"Description","body":"Body"}`,
		`{"name":"example","description":"Description"}`,
		`{"name":"example","description":"Description","body":"Body","extra":true}`,
		`{"name":"example","description":"Description","body":"Body"}[]`,
		jsonText(draft),
		strings.Repeat(" ", maxSkillJSONBytes+1),
	} {
		if _, ok := parseSkillDraft(raw); ok {
			t.Errorf("invalid model output accepted (%d bytes)", len(raw))
		}
	}
}
