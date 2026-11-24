package neoread

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"

	"go.yaml.in/yaml/v3"
)

const (
	maxSkillBytes = 64 << 10
	skillFilename = "SKILL.md"
)

var localSkillSources = [...]string{"agents", "claude", "codex"}

type skillMetadata struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Source      string `json:"source"`
}

type chatSkill struct {
	name string
	body []byte
}

func (skill *chatSkill) writePrompt(b *strings.Builder) {
	if skill == nil {
		return
	}
	fmt.Fprintf(b, "用户为本轮明确选择的技能 %q（本轮用户指令，不是原文资料）：\n仅在现有权限内执行，可使用本轮已提供的文档工具；不能访问本地文件、运行脚本或执行命令。\n", skill.name)
	b.Write(skill.body)
	b.WriteString("\n本轮技能指令结束。\n")
}

func (s *Server) listSkills(w http.ResponseWriter, r *http.Request) {
	skills := []skillMetadata{}
	seen := map[string]bool{}
	s.scanLocalSkills(r.Context(), func(meta skillMetadata, _ []byte) bool {
		if !seen[meta.Name] {
			seen[meta.Name] = true
			skills = append(skills, meta)
		}
		return false
	})
	respond(w, http.StatusOK, skills)
}

func (s *Server) resolveRequestedSkill(w http.ResponseWriter, r *http.Request, name string) (*chatSkill, bool) {
	if name == "" {
		return nil, true
	}
	var skill *chatSkill
	s.scanLocalSkills(r.Context(), func(meta skillMetadata, body []byte) bool {
		if meta.Name != name {
			return false
		}
		skill = &chatSkill{name: meta.Name, body: body}
		return true
	})
	if skill == nil {
		s.diagnosticEvent(slog.LevelWarn, "chat.skill.missing", "requestId", requestID(r.Context()), "reasonCode", "skill_not_found")
		fail(w, http.StatusBadRequest, "未找到技能 "+name)
		return nil, false
	}
	return skill, true
}

func (s *Server) logSkillAttachment(ctx context.Context, skill *chatSkill) {
	if skill != nil {
		s.diagnosticEvent(slog.LevelInfo, "chat.skill.attached", "requestId", requestID(ctx), "name", skill.name, "bytes", len(skill.body))
	}
}

// A visitor returning true stops at the first match, using the same source and
// directory order as listing. Neither operation caches the user's files.
func (s *Server) scanLocalSkills(ctx context.Context, visit func(skillMetadata, []byte) bool) {
	home, err := os.UserHomeDir()
	if err != nil {
		s.diagnosticEvent(slog.LevelWarn, "skills.scan.skipped", "requestId", requestID(ctx), "reasonCode", "home_unavailable", "count", 1)
		return
	}
	for _, source := range localSkillSources {
		if ctx.Err() != nil || s.scanLocalSkillSource(ctx, filepath.Join(home, "."+source, "skills"), source, visit) {
			return
		}
	}
}

func (s *Server) scanLocalSkillSource(ctx context.Context, root, source string, visit func(skillMetadata, []byte) bool) bool {
	var skipped map[string]int
	defer func() {
		for reason, count := range skipped {
			s.diagnosticEvent(slog.LevelWarn, "skills.scan.skipped", "requestId", requestID(ctx), "source", source, "reasonCode", reason, "count", count)
		}
	}()
	skip := func(reason string) {
		if skipped == nil {
			skipped = make(map[string]int)
		}
		skipped[reason]++
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		if !os.IsNotExist(err) {
			skip("root_unavailable")
		}
		return false
	}
	for _, entry := range entries {
		if ctx.Err() != nil {
			return true
		}
		if !entry.IsDir() && entry.Type()&os.ModeSymlink == 0 {
			continue
		}
		data, reason := readSkillFile(filepath.Join(root, entry.Name(), skillFilename))
		if reason != "" {
			if reason != "missing" {
				skip(reason)
			}
			continue
		}
		meta, body, ok := parseSkill(data)
		if !ok {
			skip("invalid_front_matter")
			continue
		}
		meta.Source = source
		if visit(meta, body) {
			return true
		}
	}
	return false
}

func readSkillFile(path string) ([]byte, string) {
	// A configured folder or SKILL.md can link outside the source roots,
	// but only a file named SKILL.md may supply instructions.
	resolved, err := filepath.EvalSymlinks(path)
	if os.IsNotExist(err) {
		return nil, "missing"
	}
	if err != nil {
		return nil, "unreadable"
	}
	if filepath.Base(resolved) != skillFilename {
		return nil, "unsafe_path"
	}
	info, err := os.Lstat(resolved)
	if os.IsNotExist(err) {
		return nil, "missing"
	}
	if err != nil {
		return nil, "unreadable"
	}
	if !info.Mode().IsRegular() {
		return nil, "unsafe_path"
	}
	if info.Size() > maxSkillBytes {
		return nil, "file_too_large"
	}
	// A raced replacement with a FIFO must not block before the inode check.
	file, err := os.OpenFile(resolved, os.O_RDONLY|skillReadFlags, 0)
	if err != nil {
		return nil, "unreadable"
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) || !opened.Mode().IsRegular() {
		return nil, "unsafe_path"
	}
	data, err := io.ReadAll(io.LimitReader(file, maxSkillBytes+1))
	if err != nil {
		return nil, "unreadable"
	}
	if len(data) > maxSkillBytes {
		return nil, "file_too_large"
	}
	return data, ""
}

func parseSkill(data []byte) (skillMetadata, []byte, bool) {
	if !utf8.Valid(data) {
		return skillMetadata{}, nil, false
	}
	marker := func(line []byte) bool { return bytes.Equal(bytes.TrimRight(line, " \t\r"), []byte("---")) }
	first, rest, _ := bytes.Cut(bytes.TrimPrefix(data, []byte("\ufeff")), []byte("\n"))
	if !marker(first) {
		return skillMetadata{}, nil, false
	}
	for tail := rest; len(tail) > 0; {
		line, next, _ := bytes.Cut(tail, []byte("\n"))
		if marker(line) {
			var metadata struct {
				Name        yaml.Node `yaml:"name"`
				Description yaml.Node `yaml:"description"`
			}
			if err := yaml.Unmarshal(rest[:len(rest)-len(tail)], &metadata); err != nil || !skillYAMLString(metadata.Name) || (metadata.Description.Kind != 0 && !skillYAMLString(metadata.Description)) {
				return skillMetadata{}, nil, false
			}
			name := strings.TrimSpace(metadata.Name.Value)
			if name == "" || len(name) > 64 || strings.ContainsAny(name, "/\\") || strings.ContainsFunc(name, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) {
				return skillMetadata{}, nil, false
			}
			return skillMetadata{Name: name, Description: strings.TrimSpace(metadata.Description.Value)}, next, true
		}
		tail = next
	}
	return skillMetadata{}, nil, false
}

func skillYAMLString(node yaml.Node) bool {
	return node.Kind == yaml.ScalarNode && node.ShortTag() == "!!str"
}
