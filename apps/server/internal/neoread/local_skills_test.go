package neoread

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"neoread.local/server/internal/diagnostics"
)

func localSkillTestHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	return home
}

func writeLocalSkillTestFile(t *testing.T, path, contents string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func listLocalSkillsForTest(t *testing.T, s *Server) []skillMetadata {
	t.Helper()
	out := request(t, s, "GET", "/api/skills", nil)
	var skills []skillMetadata
	if out.Code != http.StatusOK || json.Unmarshal(out.Body.Bytes(), &skills) != nil || skills == nil {
		t.Fatalf("unexpected skill list: %d %s", out.Code, out.Body.String())
	}
	return skills
}

func TestLocalSkillFrontMatter(t *testing.T) {
	input := "\ufeff---\r\nname: 'reader-help'\r\ndescription: >-\r\n  Read the outline\r\n  and explain it.\r\nmetadata:\r\n  version: 1\r\n---\r\n    Preserve indentation\r\n---\r\nRest of the body."
	meta, body, ok := parseSkill([]byte(input))
	if !ok || meta.Name != "reader-help" || meta.Description != "Read the outline and explain it." || string(body) != "    Preserve indentation\r\n---\r\nRest of the body." {
		t.Fatalf("unexpected front matter: %+v, body %q, ok=%v", meta, body, ok)
	}
	for _, invalid := range []string{
		"No front matter",
		"---\nname: missing-end\n",
		"---\ndescription: missing name\n---\n",
		"---\nname: 42\n---\n",
		"---\nname: invalid/name\n---\n",
		"---\nname: [malformed\n---\n",
		"---\nname: one\nname: two\n---\n",
		"---\nname: nested\ndescription: {not: text}\n---\n",
		"---\nname: invalid-utf8\n---\n\xff",
	} {
		if _, _, ok := parseSkill([]byte(invalid)); ok {
			t.Errorf("accepted invalid skill %q", invalid)
		}
	}
}

func TestLocalSkillsScanPrecedenceAndRefresh(t *testing.T) {
	home := localSkillTestHome(t)
	s := testServer(t)
	if got := listLocalSkillsForTest(t, s); len(got) != 0 {
		t.Fatalf("empty home returned %+v", got)
	}
	first := writeLocalSkillTestFile(t, filepath.Join(home, ".agents", "skills", "01-folder", "SKILL.md"), "---\nname: review\ndescription: from agents\n---\nAGENTS BODY")
	writeLocalSkillTestFile(t, filepath.Join(home, ".agents", "skills", "02-folder", "SKILL.md"), "---\nname: review\ndescription: same source duplicate\n---\nDUPLICATE BODY")
	writeLocalSkillTestFile(t, filepath.Join(home, ".claude", "skills", "copy", "SKILL.md"), "---\nname: review\ndescription: from claude\n---\nCLAUDE BODY")
	writeLocalSkillTestFile(t, filepath.Join(home, ".claude", "skills", "other", "SKILL.md"), "---\nname: cite\ndescription: cite sources\n---\nCLAUDE CITE")
	writeLocalSkillTestFile(t, filepath.Join(home, ".codex", "skills", "copy", "SKILL.md"), "---\nname: cite\ndescription: lower precedence\n---\nCODEX CITE")
	writeLocalSkillTestFile(t, filepath.Join(home, ".codex", "skills", "unique", "SKILL.md"), "---\nname: compare\ndescription: compare evidence\n---\nCODEX BODY")
	writeLocalSkillTestFile(t, filepath.Join(home, ".codex", "skills", "unique", "ignored.md"), "---\nname: sibling\n---\nIGNORED")
	writeLocalSkillTestFile(t, filepath.Join(home, ".codex", "skills", "nested", "child", "SKILL.md"), "---\nname: nested\n---\nIGNORED")
	writeLocalSkillTestFile(t, filepath.Join(home, ".codex", "skills", "SKILL.md"), "---\nname: direct\n---\nIGNORED")
	want := []skillMetadata{{"review", "from agents", "agents"}, {"cite", "cite sources", "claude"}, {"compare", "compare evidence", "codex"}}
	if got := listLocalSkillsForTest(t, s); !reflect.DeepEqual(got, want) {
		t.Fatalf("list got %+v, want %+v", got, want)
	}
	resolve := func(name string) string {
		t.Helper()
		w := httptest.NewRecorder()
		skill, ok := s.resolveRequestedSkill(w, httptest.NewRequest(http.MethodPost, "/", nil), name)
		if !ok || skill == nil || skill.name != name {
			t.Fatalf("cannot resolve %s: %s", name, w.Body.String())
		}
		return string(skill.body)
	}
	if got := resolve("review"); got != "AGENTS BODY" {
		t.Fatalf("wrong source at runtime: %q", got)
	}
	writeLocalSkillTestFile(t, first, "---\nname: renamed\ndescription: edited locally\n---\nEDITED BODY")
	if got := resolve("renamed"); got != "EDITED BODY" {
		t.Fatalf("stale runtime skill after edit: %q", got)
	}
	want = append([]skillMetadata{{"renamed", "edited locally", "agents"}, {"review", "same source duplicate", "agents"}}, want[1:]...)
	if got := listLocalSkillsForTest(t, s); !reflect.DeepEqual(got, want) || resolve("review") != "DUPLICATE BODY" {
		t.Fatalf("scan did not refresh precedence: %+v", got)
	}
}

func TestLocalSkillsFollowLinks(t *testing.T) {
	home := localSkillTestHome(t)
	s := testServer(t)
	root := filepath.Join(home, ".agents", "skills")
	outside := writeLocalSkillTestFile(t, filepath.Join(home, "outside", "escaped", "SKILL.md"), "---\nname: escaped\n---\nOUTSIDE BODY")
	externalFile := writeLocalSkillTestFile(t, filepath.Join(home, "other", "SKILL.md"), "---\nname: linked-file\n---\nOTHER BODY")
	unrelated := writeLocalSkillTestFile(t, filepath.Join(root, "settings.json"), "---\nname: unrelated\n---\nPRIVATE CONTENT")
	link := func(target, location string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(location), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, location); err != nil {
			if os.IsPermission(err) {
				t.Skipf("cannot create symlink: %v", err)
			}
			t.Fatal(err)
		}
	}
	link(filepath.Dir(outside), filepath.Join(root, "outside-folder"))
	link(externalFile, filepath.Join(root, "outside-file", "SKILL.md"))
	link(unrelated, filepath.Join(root, "wrong-filename", "SKILL.md"))
	want := []skillMetadata{{Name: "linked-file", Source: "agents"}, {Name: "escaped", Source: "agents"}}
	if got := listLocalSkillsForTest(t, s); !reflect.DeepEqual(got, want) {
		t.Fatalf("linked list got %+v, want %+v", got, want)
	}
	if err := os.MkdirAll(filepath.Join(root, "not-a-file", skillFilename), 0700); err != nil {
		t.Fatal(err)
	}
	writeLocalSkillTestFile(t, filepath.Join(root, "too-big", skillFilename), strings.Repeat("x", maxSkillBytes+1))
	if got := listLocalSkillsForTest(t, s); !reflect.DeepEqual(got, want) {
		t.Fatalf("accepted a directory or oversized file: %+v", got)
	}
}

func TestLocalSkillsCapAndRedactedDiagnostics(t *testing.T) {
	home := localSkillTestHome(t)
	s := testServer(t)
	directory := filepath.Join(s.Store.Root, "logs")
	logs, err := diagnostics.New(directory, "skill-test")
	if err != nil {
		t.Fatal(err)
	}
	s.SetDiagnostics(logs)
	root := filepath.Join(home, ".agents", "skills")
	header := "---\nname: exact\ndescription: PRIVATE-DESCRIPTION\n---\n"
	body := strings.Repeat("X", maxSkillBytes-len(header)-len("PRIVATE-BODY")) + "PRIVATE-BODY"
	writeLocalSkillTestFile(t, filepath.Join(root, "exact", "SKILL.md"), header+body)
	writeLocalSkillTestFile(t, filepath.Join(root, "oversize", "SKILL.md"), strings.Replace(header, "exact", "large", 1)+body+"!")
	writeLocalSkillTestFile(t, filepath.Join(root, "malformed", "SKILL.md"), "---\nname: [PRIVATE-YAML\n---\n")
	if got := listLocalSkillsForTest(t, s); len(got) != 1 || got[0].Name != "exact" {
		t.Fatalf("size boundary not enforced: %+v", got)
	}
	w := httptest.NewRecorder()
	skill, ok := s.resolveRequestedSkill(w, httptest.NewRequest(http.MethodPost, "/", nil), "exact")
	if !ok || skill == nil || string(skill.body) != body {
		t.Fatal("skill at the size boundary was truncated or rejected")
	}
	s.logSkillAttachment(t.Context(), skill)
	files, err := filepath.Glob(filepath.Join(directory, "*.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		output.Write(data)
	}
	for _, marker := range []string{"skills.scan.skipped", "file_too_large", "invalid_front_matter", "chat.skill.attached", `"name":"exact"`, `"bytes":`} {
		if !strings.Contains(output.String(), marker) {
			t.Errorf("missing diagnostic marker %s", marker)
		}
	}
	if strings.Contains(output.String(), "PRIVATE-") || strings.Contains(output.String(), "SKILL.md") {
		t.Fatal("diagnostics leaked skill contents or paths")
	}
}

func TestChatSkillPromptBoundaries(t *testing.T) {
	_, agent := prepareConversationFixture(t)
	chat := &chatInput{
		Title: "Test", Question: "实际问题", CurrentText: "UNTRUSTED-EXCERPT",
		Skill: &chatSkill{name: "review", body: []byte("SKILL-BODY")},
	}
	in := AIInput{Chat: chat}
	agent.provider = "api"
	if _, err := agent.beginConversation(t.Context(), in, "test"); err != nil {
		t.Fatal(err)
	}
	for path, prompt := range map[string]string{"document": agent.conversationInput(in, true), "legacy": chat.legacyPrompt()} {
		source := strings.Index(prompt, "UNTRUSTED-EXCERPT")
		chosen := strings.Index(prompt, `用户为本轮明确选择的技能 "review"`)
		skill := strings.Index(prompt, "SKILL-BODY")
		question := strings.Index(prompt, "用户问题：实际问题")
		if source < 0 || !(source < chosen && chosen < skill && skill < question) || strings.Count(prompt, "SKILL-BODY") != 1 || !strings.Contains(prompt, "本轮已提供的文档工具") || !strings.Contains(prompt, "不能访问本地文件、运行脚本或执行命令") {
			t.Errorf("%s skill not isolated before question: %s", path, prompt)
		}
	}
	chat.Skill = nil
	if strings.Contains(chat.legacyPrompt(), "SKILL-BODY") || strings.Contains(agent.conversationInput(in, false), "SKILL-BODY") {
		t.Fatal("skill attached to a turn without a selection")
	}
}

func TestChatMissingSkillIsBadRequest(t *testing.T) {
	localSkillTestHome(t)
	s, _ := prepareConversationFixture(t)
	body := `{"provider":"api","context":"","prompt":"Question","skill":"removed-skill"}`
	out := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(body))
	var message map[string]string
	if out.Code != http.StatusBadRequest || json.Unmarshal(out.Body.Bytes(), &message) != nil || message["error"] != "未找到技能 removed-skill" {
		t.Fatalf("unexpected missing skill error: %d %s", out.Code, out.Body.String())
	}
	if got := chatMessages(t, s); len(got) != 0 {
		t.Fatalf("rejected skill wrote messages: %+v", got)
	}
}
