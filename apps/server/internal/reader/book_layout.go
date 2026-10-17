package reader

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

// A book chapter request parses at most this many pages at once, so a long
// chapter or an outline-less book never runs the layout model over the book.
const bookLayoutPages = 30

type PageRange struct {
	From int `json:"fromPage"`
	To   int `json:"toPage"`
}

// runLayout parses the PDF into work. from and to bound a book chapter; zero
// parses the whole document.
func (s *Server) runLayout(ctx context.Context, d Document, work string, from, to int, p *Processing) (result error) {
	runID := id()
	started := time.Now()
	lastStage := "prepare"
	exitCode := -1
	stderr := &layoutStderr{}
	s.diagnosticEvent(slog.LevelInfo, "pdf.parse.start", "runId", runID, "documentId", d.ID, "fromPage", from, "toPage", to)
	defer func() {
		level := slog.LevelInfo
		outcome := "complete"
		if result != nil {
			level = slog.LevelError
			outcome = "failed"
		}
		s.diagnosticEvent(level, "pdf.parse.finish", "runId", runID, "documentId", d.ID,
			"stage", lastStage, "outcome", outcome, "exitCode", exitCode,
			"durationMs", time.Since(started).Milliseconds(), "stderrBytes", stderr.total,
			"stderrFingerprint", stderr.fingerprint(), "stderrTruncated", stderr.total > int64(len(stderr.tail)),
			"canceled", ctx.Err() != nil)
	}()
	worker := os.Getenv("READER_PROCESSOR")
	node := os.Getenv("READER_NODE")
	if worker == "" || node == "" {
		return errors.New("本地解析程序未启动，请重新构建并打开 Reader")
	}
	if err := os.RemoveAll(work); err != nil {
		return errors.New("无法清理未完成的解析")
	}
	child, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	args := []string{worker, "--input", s.Store.File(d), "--output", work}
	if from > 0 {
		args = append(args, "--from-page", strconv.Itoa(from), "--to-page", strconv.Itoa(to))
	}
	cmd := exec.CommandContext(child, node, args...)
	cmd.Env = append(os.Environ(), "ELECTRON_RUN_AS_NODE=1", "NODE_USE_ENV_PROXY=1")
	cmd.WaitDelay = 3 * time.Second
	cmd.Dir = s.Store.Root
	cmd.Stderr = stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	lastStage = "process_start"
	if err = cmd.Start(); err != nil {
		return errors.New("无法启动本地 PDF 解析程序")
	}
	lastStage = "bootstrap"
	s.diagnosticEvent(slog.LevelInfo, "pdf.parse.spawned", "runId", runID, "documentId", d.ID, "pid", cmd.Process.Pid)
	scan := bufio.NewScanner(out)
	scan.Buffer(make([]byte, 4096), 1<<20)
	var saveErr error
	for scan.Scan() {
		var event layoutDiagnostic
		if json.Unmarshal(scan.Bytes(), &event) != nil {
			continue
		}
		switch event.Event {
		case "diagnostic":
			if !event.valid() {
				continue
			}
			lastStage = event.Stage
			level := slog.LevelInfo
			if event.Status == "failed" {
				level = slog.LevelError
			}
			s.diagnosticEvent(level, "pdf.parse.stage", "runId", runID, "documentId", d.ID,
				"stage", event.Stage, "status", event.Status, "page", event.Page,
				"durationMs", event.DurationMs, "errorType", event.ErrorType,
				"errorCode", event.ErrorCode, "errorFingerprint", event.ErrorFingerprint)
			continue
		case "page":
			p.PagesDone, p.PagesTotal = event.Page, event.Total
			p.Detail = fmt.Sprintf("已解析 %d / %d 页", event.Page, event.Total)
			if from > 0 {
				p.PagesDone, p.PagesTotal = event.Page-from+1, min(to, event.Total)-from+1
				p.Detail = fmt.Sprintf("正在解析本章 · %d / %d 页", p.PagesDone, p.PagesTotal)
			}
		default:
			continue
		}
		if saveErr = s.Store.saveProcessing(*p); saveErr != nil {
			cancel()
			break
		}
	}
	if scan.Err() != nil {
		cancel()
	}
	err = cmd.Wait()
	if cmd.ProcessState != nil {
		exitCode = cmd.ProcessState.ExitCode()
	}
	if child.Err() == context.DeadlineExceeded {
		lastStage = "timeout"
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if saveErr != nil {
		return errors.New("无法保存解析进度")
	}
	if err != nil || scan.Err() != nil {
		return errors.New("PDF 解析未完成。请检查文件，或重新构建或安装 Reader 后重试")
	}
	return nil
}

func parsedPage(m *layoutManifest, page int) bool {
	return m != nil && (len(m.ParsedPages) == 0 || slices.Contains(m.ParsedPages, page))
}

// chapterWindow returns the next pages of [from, to] that still need work:
// it starts at the first unparsed page or the first page with untranslated
// paragraphs and spans at most bookLayoutPages.
func chapterWindow(m *layoutManifest, items []TranslationBlock, from, to int) (start, end int, ok bool) {
	open := map[int]bool{}
	if m != nil {
		to = min(to, m.Pages)
		status := map[string]string{}
		for _, t := range items {
			status[t.BlockID] = t.Status
		}
		for _, b := range m.Blocks {
			if s := status[b.ID]; s == "idle" || s == "failed" {
				open[b.Page] = true
			}
		}
	}
	for page := from; page <= to; page++ {
		if !parsedPage(m, page) || open[page] {
			return page, min(to, page+bookLayoutPages-1), true
		}
	}
	return 0, 0, false
}

func unparsedPages(m *layoutManifest, start, end int) []int {
	pages := []int{}
	for page := start; page <= end; page++ {
		if !parsedPage(m, page) {
			pages = append(pages, page)
		}
	}
	return pages
}

// learnBookChapter parses the missing pages of a requested chapter, merges
// them into the manifest and queues the chapter's translation.
func (s *Server) learnBookChapter(ctx context.Context, d Document, p *Processing) error {
	if p.Chapter == nil {
		return nil
	}
	var known *layoutManifest
	var items []TranslationBlock
	if m, err := s.readLayout(d.ID); err == nil {
		known = &m
		if items, err = s.translations(d.ID, m); err != nil {
			return err
		}
	}
	if start, end, ok := chapterWindow(known, items, p.Chapter.From, p.Chapter.To); ok {
		if missing := unparsedPages(known, start, end); len(missing) > 0 {
			work := filepath.Join(s.Store.Root, "cache", d.ID, "analysis-work")
			if err := s.runLayout(ctx, d, work, missing[0], missing[len(missing)-1], p); err != nil {
				return err
			}
			if err := s.mergeLayout(d.ID, work); err != nil {
				return err
			}
		}
	}
	m, err := s.readLayout(d.ID)
	if err != nil {
		return err
	}
	s.processingMu.Lock()
	_, err = s.queueTranslationRange(d, m, p.Chapter.From, p.Chapter.To)
	s.processingMu.Unlock()
	if err != nil {
		return err
	}
	p.Chapter = nil
	return nil
}

func readLayoutFile(path string) (layoutManifest, map[string]json.RawMessage, error) {
	var m layoutManifest
	var raw map[string]json.RawMessage
	b, err := os.ReadFile(path)
	if err == nil && len(b) > 32<<20 {
		err = errors.New("版面索引过大")
	}
	if err == nil {
		err = json.Unmarshal(b, &m)
	}
	if err == nil {
		err = json.Unmarshal(b, &raw)
	}
	return m, raw, err
}

func blockOrder(id string) int {
	_, n, _ := strings.Cut(id, "-b")
	order, _ := strconv.Atoi(n)
	return order
}

// mergeLayout adds the pages parsed into work to the document's manifest. The
// first chapter publishes the work directory; later chapters replace their
// pages' blocks and keep every other field of the manifest.
func (s *Server) mergeLayout(id, work string) error {
	added, _, err := readLayoutFile(filepath.Join(work, "manifest.json"))
	if err != nil || added.Pages < 1 {
		return errors.New("本章版面索引无效")
	}
	dir := s.analysisDir(id)
	current, raw, err := readLayoutFile(filepath.Join(dir, "manifest.json"))
	if errors.Is(err, os.ErrNotExist) {
		if _, statErr := os.Stat(dir); statErr == nil {
			return errors.New("已有解析目录异常，已保留，未覆盖")
		}
		if err = os.Rename(work, dir); err != nil {
			return errors.New("无法保存解析附件")
		}
		_, err = s.readLayout(id)
		return err
	}
	if err != nil {
		return err
	}
	replaced := map[int]bool{}
	for _, page := range added.ParsedPages {
		replaced[page] = true
	}
	blocks := []PDFBlock{}
	for _, b := range current.Blocks {
		if !replaced[b.Page] {
			blocks = append(blocks, b)
		}
	}
	for _, b := range added.Blocks {
		if b.Image != "" {
			if err = os.Rename(filepath.Join(work, b.Image), filepath.Join(dir, b.Image)); err != nil {
				return errors.New("无法保存解析附件")
			}
		}
		blocks = append(blocks, b)
	}
	slices.SortStableFunc(blocks, func(a, b PDFBlock) int {
		if a.Page != b.Page {
			return a.Page - b.Page
		}
		return blockOrder(a.ID) - blockOrder(b.ID)
	})
	parsed := slices.Clone(current.ParsedPages)
	incomplete := []int{}
	for _, page := range current.IncompletePages {
		if !replaced[page] {
			incomplete = append(incomplete, page)
		}
	}
	for page := range replaced {
		if !slices.Contains(parsed, page) {
			parsed = append(parsed, page)
		}
	}
	slices.Sort(parsed)
	incomplete = append(incomplete, added.IncompletePages...)
	slices.Sort(incomplete)
	warnings := slices.Clone(current.Warnings)
	for _, w := range added.Warnings {
		if !slices.Contains(warnings, w) {
			warnings = append(warnings, w)
		}
	}
	for key, value := range map[string]any{"blocks": blocks, "parsedPages": parsed, "incompletePages": incomplete, "warnings": warnings} {
		if raw[key], err = json.Marshal(value); err != nil {
			return err
		}
	}
	data, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return err
	}
	part := filepath.Join(dir, "manifest.json.part")
	if err = os.WriteFile(part, data, 0600); err != nil {
		return errors.New("无法保存版面索引")
	}
	if err = os.Rename(part, filepath.Join(dir, "manifest.json")); err != nil {
		return errors.New("无法保存版面索引")
	}
	return os.RemoveAll(work)
}
