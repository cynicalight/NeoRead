// Package diagnostics persists bounded local logs without request or document bodies.
package diagnostics

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const MaxFileBytes = 5 << 20
const MaxTotalBytes = 100 << 20
const Retention = 7 * 24 * time.Hour

var privateKey = regexp.MustCompile(`(?i)^(authorization|cookie|set-cookie|key|.*(token|password|secret|api.?key|credential).*|userMessage|prompt|context|content|sourceText|original|translated|translation|text|quote|note|attachments|references|body)$`)
var userMessageText = regexp.MustCompile(`(?i)["']?userMessage["']?\s*[:=]\s*[^\r\n]*`)
var panicText = regexp.MustCompile(`(?m)^(panic:|http: panic serving)[^\n]*`)
var authHeader = regexp.MustCompile(`(?i)(authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]*`)
var auth = regexp.MustCompile(`(?i)\b(Bearer|Basic)\s+[^\s"',;]+`)
var assigned = regexp.MustCompile(`(?i)(["']?(api[ _-]?key|key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|cookie)["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}]+)`)
var keyToken = regexp.MustCompile(`\bsk-[A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`)
var urls = regexp.MustCompile(`(?i)(https?|file)://[^\s"'<>]+`)
var paths = regexp.MustCompile(`/(Users|home|private|tmp|var|Volumes|Applications)/[^\r\n"'<>]+|[A-Za-z]:[\\/][^\r\n"'<>]+|\\\\[^\r\n"'<>]+`)
var rawOutput = regexp.MustCompile(`(?s)--- raw output ---.*$`)

func RedactText(text string, secrets ...string) string {
	secrets = append([]string(nil), secrets...)
	sort.Slice(secrets, func(i, j int) bool { return len(secrets[i]) > len(secrets[j]) })
	for _, secret := range secrets {
		if secret != "" {
			text = strings.ReplaceAll(text, secret, "[REDACTED]")
		}
	}
	text = userMessageText.ReplaceAllString(text, "[USER MESSAGE REMOVED]")
	text = panicText.ReplaceAllString(text, "panic: [MESSAGE REMOVED]")
	text = authHeader.ReplaceAllString(text, "[AUTH HEADER]")
	text = auth.ReplaceAllString(text, "[AUTH]")
	text = assigned.ReplaceAllString(text, "${1}[REDACTED]")
	text = keyToken.ReplaceAllString(text, "[TOKEN]")
	text = urls.ReplaceAllString(text, "[URL]")
	return paths.ReplaceAllString(text, "[PATH]")
}
func redact(v any, secrets []string) any {
	switch v := v.(type) {
	case string:
		return RedactText(v, secrets...)
	case map[string]any:
		safe := make(map[string]any, len(v))
		for key, value := range v {
			if privateKey.MatchString(key) {
				safe[key] = "[REDACTED]"
			} else {
				safe[key] = redact(value, secrets)
			}
		}
		return safe
	case []any:
		safe := make([]any, len(v))
		for i := range v {
			safe[i] = redact(v[i], secrets)
		}
		return safe

	default:
		return v
	}
}

// Authorization error responses are retained verbatim at the user's request.
// This exception applies only to the top-level body of a failed server request.
func redactLogEntry(value any, secrets []string) any {
	if event, ok := value.(map[string]any); ok {
		status, _ := event["upstreamStatus"].(float64)
		body, hasBody := event["upstreamErrorBody"].(string)
		if event["source"] == "server" && event["event"] == "ai.connection.request" && status >= 400 && status <= 599 && hasBody {
			fields := make(map[string]any, len(event)-1)
			for key, value := range event {
				if key != "upstreamErrorBody" {
					fields[key] = value
				}
			}
			safe := redact(fields, secrets).(map[string]any)
			safe["upstreamErrorBody"] = body
			return safe
		}
	}
	return redact(value, secrets)
}

func RedactLog(data []byte, legacy bool, secrets ...string) []byte {
	if legacy {
		data = rawOutput.ReplaceAll(data, []byte("--- raw output ---\n[DOCUMENT AND MODEL OUTPUT REMOVED]\n"))
	}
	var out bytes.Buffer
	for i, line := range bytes.Split(data, []byte("\n")) {
		if i > 0 {
			out.WriteByte('\n')
		}
		var value any
		if json.Unmarshal(line, &value) == nil {
			b, _ := json.Marshal(redactLogEntry(value, secrets))
			out.Write(b)
		} else {
			out.WriteString(RedactText(string(line), secrets...))
		}
	}
	return out.Bytes()
}

type Store struct {
	Dir         string
	Session     string
	Secrets     []string
	mu          sync.Mutex
	file        string
	sequence    int
	lastPrune   time.Time
	Dropped     int
	Environment map[string]any
}

func New(dir, session string, secrets ...string) (*Store, error) {
	if session == "" {
		session = rand.Text()
	}
	s := &Store{Dir: dir, Session: session, Secrets: secrets}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return s, err
	}
	return s, nil
}

func (s *Store) Write(b []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var value map[string]any
	if json.Unmarshal(bytes.TrimSpace(b), &value) != nil {
		value = map[string]any{"level": "WARN", "msg": "server.legacy", "detail": strings.TrimSpace(string(b))}
	}
	if message, ok := value["msg"].(string); ok {
		if regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,79}$`).MatchString(message) {
			value["event"] = message
		} else {
			value["event"] = "server.legacy"
			value["detail"] = message
		}
		delete(value, "msg")
	}
	if level, ok := value["level"].(string); ok {
		value["level"] = strings.ToLower(level)
	}
	if stamp, ok := value["time"]; ok {
		value["timestamp"] = stamp
		delete(value, "time")
	}
	value["source"] = "server"
	value["sessionId"] = s.Session
	if _, ok := value["timestamp"]; !ok {
		value["timestamp"] = time.Now().UTC().Format(time.RFC3339Nano)
	}
	data, _ := json.Marshal(redactLogEntry(value, s.Secrets))
	data = append(data, '\n')
	rotated := false
	if s.file == "" {
		s.nextFile()
		rotated = true
	}
	if info, err := os.Stat(s.file); err == nil && info.Size()+int64(len(data)) > MaxFileBytes {
		s.nextFile()
		rotated = true
	}
	if info, err := os.Lstat(s.file); err == nil && info.Mode()&os.ModeSymlink != 0 {
		s.Dropped++
		return len(b), nil
	}
	f, err := os.OpenFile(s.file, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err == nil {
		_, err = f.Write(data)
		closeErr := f.Close()
		if err == nil {
			err = closeErr
		}
	}
	if err != nil {
		s.Dropped++
		return len(b), nil
	} // Logging cannot prevent reading or saving.
	if rotated || time.Since(s.lastPrune) > time.Minute {
		s.prune()
		s.lastPrune = time.Now()
	}
	return len(b), nil
}
func (s *Store) nextFile() {
	s.sequence++
	s.file = filepath.Join(s.Dir, fmt.Sprintf("server-%s-%d-%04d.jsonl", time.Now().UTC().Format("20060102T150405"), os.Getpid(), s.sequence))
}
func (s *Store) Logger() *slog.Logger { return slog.New(slog.NewJSONHandler(s, nil)) }
func (s *Store) Event(level slog.Level, event string, attrs ...any) {
	if s != nil {
		s.Logger().Log(nil, level, event, attrs...)
	}
}
func LogName(name string) bool {
	return regexp.MustCompile(`^(desktop|server|renderer|server-stderr)-[A-Za-z0-9_.-]+\.(jsonl|log)$`).MatchString(name)
}
func (s *Store) prune() {
	entries, _ := os.ReadDir(s.Dir)
	type file struct {
		name string
		info os.FileInfo
	}
	var files []file
	var total int64
	for _, e := range entries {
		if !LogName(e.Name()) || e.Type()&os.ModeSymlink != 0 {
			continue
		}
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		files = append(files, file{e.Name(), info})
		total += info.Size()
	}
	sort.Slice(files, func(i, j int) bool { return files[i].info.ModTime().Before(files[j].info.ModTime()) })
	for _, f := range files {
		if time.Since(f.info.ModTime()) > Retention || total > MaxTotalBytes {
			if os.Remove(filepath.Join(s.Dir, f.name)) == nil {
				total -= f.info.Size()
			}
		}
	}
}
