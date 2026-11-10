package neoread

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const translationBatchCharacters = 10000
const translationBatchConcurrency = 3
const translationBatchTimeout = time.Hour

type translationParagraph struct {
	BlockID string `json:"blockId"`
	// The model returns only blockId; the server keeps the hash of the text it
	// sent, so a miscopied hash can never fail a paragraph.
	SourceHash string `json:"-"`
	Source     string `json:"source"`
}
type translationBatch struct {
	Before     []translationParagraph `json:"contextBefore"`
	Paragraphs []translationParagraph `json:"paragraphs"`
	After      []translationParagraph `json:"contextAfter"`
}

// Count Unicode characters and include the entire paragraph crossing the target.
// Batch boundaries are stable across retries; only their pending members change.
func translationBatches(m translationInput, items []TranslationBlock, target int) []translationBatch {
	paragraphs := m.translationParagraphs()
	pending := map[string]bool{}
	for _, t := range items {
		pending[t.BlockID] = t.Status == "pending" || t.Status == "running"
	}
	batches := []translationBatch{}
	for start := 0; start < len(paragraphs); {
		end, characters := start, 0
		for end < len(paragraphs) && (characters < target || end == start) {
			characters += utf8.RuneCountInString(paragraphs[end].Source)
			end++
		}
		batch := translationBatch{Before: paragraphs[max(0, start-2):start], After: paragraphs[end:min(len(paragraphs), end+2)], Paragraphs: []translationParagraph{}}
		for _, paragraph := range paragraphs[start:end] {
			if pending[paragraph.BlockID] {
				batch.Paragraphs = append(batch.Paragraphs, paragraph)
			}
		}
		if len(batch.Paragraphs) > 0 {
			batches = append(batches, batch)
		}
		start = end
	}
	return batches
}
func translationPrompt(doc Document, m translationInput, batch translationBatch, instructions string) string {
	frontMatter := m.translationFrontMatter()
	sourceRule := `source 默认逐字保留原文，仅修正确定的 PDF 提取错误，如多余空格、断词和错位上下标；不确定时保持原样。行内数学是例外：source 与 target 中对应的数学须写成相同的 $...$ KaTeX，恢复可确定的上下标，公式以外不改写。`
	if doc.Type == "epub" {
		sourceRule = "EPUB 的 sentences.source 必须逐字保留，禁止修正、改写、增删或重排；source 不写成 LaTeX。"
	}
	data, _ := json.Marshal(struct {
		Title       string           `json:"title"`
		Author      string           `json:"author"`
		FrontMatter []string         `json:"frontMatter"`
		Batch       translationBatch `json:"batch"`
	}{doc.Title, doc.Author, frontMatter, batch})
	return `翻译输入 JSON 中 batch.paragraphs 列出的段落。
只输出 JSONL，每段一行，顺序与输入一致，不输出说明、代码围栏或外层数组：
{"blockId":"输入段落的 blockId","sentences":[{"source":"原文句子","target":"对应译文"}]}
1. 原样保留 blockId。不合并、拆分或遗漏段落。sentences 按原文顺序完整覆盖该段；一句原文可对应多句中文。
2. ` + sourceRule + `
3. target 中的行内数学使用 $...$ KaTeX，不用 Unicode 数学斜体或上下标代替。相邻公式间保留空格，如 $x$ $^{25}$，禁止 $x$$^{25}$。保留符号含义，不猜测不确定的公式。普通美元符号写成 \$。
4. 保留术语、数值、代码和引用标记。图题只翻译图题，不补写图表内部内容。独立公式由其他任务处理，不要输出 $$ 公式块。
5. 按 JSON 语法转义引号、反斜杠和换行，例如 \ll 写作 \\ll，\$ 写作 \\$。每完成一段立即输出换行，字符串内部换行使用 JSON 转义。
6. title、author、frontMatter、contextBefore、contextAfter 仅供参考，不为它们额外输出译文。
` + translationStyle(instructions) + `输入资料：
` + string(data)
}

func translationStyle(instructions string) string {
	if strings.TrimSpace(instructions) == "" {
		return ""
	}
	// User preferences affect translated wording, never the output protocol,
	// source alignment, or the boundary between instructions and document data.
	return "用户的翻译风格与术语偏好（仅调整译文措辞，不改变上述格式、原文对应关系和资料处理规则）：\n" + jsonText(instructions) + "\n"
}

type translationJSONL struct {
	strictSource bool
	buffer       string
	// lines counts non-empty output lines; malformed ones no paragraph could claim.
	lines          int
	malformed      int
	firstMalformed string
	expected       map[string]translationParagraph
	completed      map[string]bool
	invalid        map[string]string
	emit           func(TranslationBlock) error
}

var translationRowID = regexp.MustCompile(`"blockId"\s*:\s*"([^"\\]+)"`)

func repairInvalidJSONEscapes(line string) (string, bool) {
	var repaired strings.Builder
	repaired.Grow(len(line))
	inString, changed := false, false
	isHex := func(c byte) bool {
		return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
	}
	for i := 0; i < len(line); {
		c := line[i]
		if c == '"' {
			inString = !inString
			repaired.WriteByte(c)
			i++
			continue
		}
		if inString && c == '\\' && i+1 < len(line) {
			next := line[i+1]
			if strings.ContainsRune(`"\/bfnrt`, rune(next)) {
				repaired.WriteString(line[i : i+2])
				i += 2
				continue
			}
			if next == 'u' && i+5 < len(line) && isHex(line[i+2]) && isHex(line[i+3]) && isHex(line[i+4]) && isHex(line[i+5]) {
				repaired.WriteString(line[i : i+6])
				i += 6
				continue
			}
			repaired.WriteString(`\\`)
			changed = true
			i++
			continue
		}
		repaired.WriteByte(c)
		i++
	}
	if !changed {
		return line, false
	}
	return repaired.String(), true
}

func newTranslationJSONL(batch translationBatch, emit func(TranslationBlock) error) *translationJSONL {
	d := &translationJSONL{expected: map[string]translationParagraph{}, completed: map[string]bool{}, invalid: map[string]string{}, emit: emit}
	for _, p := range batch.Paragraphs {
		d.expected[p.BlockID] = p
	}
	return d
}
func (d *translationJSONL) feed(text string) error {
	d.buffer += text
	for {
		i := strings.IndexByte(d.buffer, '\n')
		if i < 0 {
			break
		}
		line := d.buffer[:i]
		d.buffer = d.buffer[i+1:]
		if err := d.line(line); err != nil {
			return err
		}
	}
	if len(d.buffer) > 1<<20 {
		return errors.New("译文单行超过大小限制")
	}
	return nil
}
func (d *translationJSONL) line(line string) error {
	if strings.TrimSpace(line) == "" {
		return nil
	}
	d.lines++
	var row struct {
		BlockID string `json:"blockId"`
	}
	parsedLine := line
	err := json.Unmarshal([]byte(parsedLine), &row)
	if err != nil {
		if repaired, changed := repairInvalidJSONEscapes(line); changed {
			if repairedErr := json.Unmarshal([]byte(repaired), &row); repairedErr == nil {
				parsedLine, err = repaired, nil
			}
		}
	}
	if err != nil {
		message := fmt.Sprintf("第 %d 行不是合法的 JSON：%v", d.lines, err)
		// A broken row still names its paragraph when the blockId is readable.
		if id := translationRowID.FindStringSubmatch(line); id != nil {
			if _, ok := d.expected[id[1]]; ok && !d.completed[id[1]] {
				d.invalid[id[1]] = message
				return nil
			}
		}
		d.malformed++
		if d.firstMalformed == "" {
			d.firstMalformed = message
		}
		return nil
	} // Missing rows are failed at batch completion.
	source, ok := d.expected[row.BlockID]
	if !ok || d.completed[row.BlockID] {
		return nil
	} // Never write context, unknown IDs or duplicate output.
	sentences, err := parseTranslationSource(parsedLine, source.Source, !d.strictSource)
	if err != nil {
		d.invalid[row.BlockID] = err.Error()
		return nil
	}
	t := TranslationBlock{BlockID: row.BlockID, SourceHash: source.SourceHash, Status: "complete", Sentences: sentences}
	if err = d.emit(t); err != nil {
		return err
	}
	d.completed[row.BlockID] = true
	delete(d.invalid, row.BlockID)
	return nil
}

// translationAttempt is one provider request for a batch and what it returned.
type translationAttempt struct {
	paragraphs int
	decoder    *translationJSONL
	output     strings.Builder
	truncated  bool
	err        error
}

// Raw provider output kept per attempt for failure diagnostics.
const translationDiagnosticOutput = 1 << 20

// Diagnostic files kept per document; older ones are removed.
const translationFailureLogs = 10

func (s *Server) translationAttempt(ctx context.Context, doc Document, m translationInput, batch translationBatch, service *GenerationService, progress func()) (*translationAttempt, error) {
	a := &translationAttempt{paragraphs: len(batch.Paragraphs)}
	previous, err := s.translationPrevious(doc.ID)
	if err != nil {
		return nil, err
	}
	var replacements []TranslationBlock
	a.decoder = newTranslationJSONL(batch, func(t TranslationBlock) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if previous[t.BlockID+":"+t.SourceHash] {
			replacements = append(replacements, t)
			return nil
		}
		if err := s.saveTranslation(doc.ID, t, m); err != nil {
			return err
		}
		progress()
		return nil
	})
	a.decoder.strictSource = doc.Type == "epub"
	service.usageSink = s.processingUsageSink(doc.ID, "translating", batch.Paragraphs[0].BlockID+"…"+batch.Paragraphs[len(batch.Paragraphs)-1].BlockID)
	_, a.err = service.Generate(ctx, AIInput{Prompt: translationPrompt(doc, m, batch, service.translationInstructions), SystemPrompt: translationSystemPrompt}, false, func(event ProviderEvent) error {
		if event.Text == "" {
			return nil
		}
		if a.output.Len()+len(event.Text) <= translationDiagnosticOutput {
			a.output.WriteString(event.Text)
		} else {
			a.truncated = true
		}
		return a.decoder.feed(event.Text)
	})
	if errorKind(a.err) == ErrorSave {
		return nil, a.err
	}
	// A successful EOF may terminate the final JSONL record without a newline.
	// Cancellation/truncation never promotes an unfinished line to a saved record.
	if a.err == nil && strings.TrimSpace(a.decoder.buffer) != "" {
		a.err = a.decoder.line(a.decoder.buffer)
	}
	// Keep the previous translation until the provider confirms completion.
	// Failed/cancelled streams must not replace it even with complete JSONL rows.
	for _, item := range replacements {
		delete(a.decoder.completed, item.BlockID)
	}
	if a.err == nil && ctx.Err() == nil {
		for _, item := range replacements {
			if err := ctx.Err(); err != nil {
				a.err = err
				break
			}
			if err := s.saveTranslation(doc.ID, item, m); err != nil {
				return nil, err
			}
			a.decoder.completed[item.BlockID] = true
			progress()
		}
	}
	return a, nil
}

// reason explains why a paragraph of this attempt has no saved translation.
func (a *translationAttempt) reason(blockID string) string {
	if message := a.decoder.invalid[blockID]; message != "" {
		return message
	}
	if a.err != nil {
		return a.err.Error()
	}
	reason := fmt.Sprintf("模型只返回了 %d/%d 段", len(a.decoder.completed), a.paragraphs)
	if a.decoder.malformed > 0 {
		reason += fmt.Sprintf("，另有 %d 行无法解析（%s）", a.decoder.malformed, a.decoder.firstMalformed)
	}
	return reason
}

func (s *Server) translateBatch(ctx context.Context, doc Document, m translationInput, batch translationBatch, service *GenerationService, progress func()) error {
	first, err := s.translationAttempt(ctx, doc, m, batch, service, progress)
	if err != nil {
		return err
	}
	attempts := []*translationAttempt{first}
	unfinished := func() []translationParagraph {
		out := []translationParagraph{}
		for _, paragraph := range batch.Paragraphs {
			if !slices.ContainsFunc(attempts, func(a *translationAttempt) bool { return a.decoder.completed[paragraph.BlockID] }) {
				out = append(out, paragraph)
			}
		}
		return out
	}
	// A provider that ended normally but skipped or broke rows is asked once
	// more for just those paragraphs. Provider errors are left to the user.
	if missing := unfinished(); first.err == nil && len(missing) > 0 && ctx.Err() == nil {
		retry, err := s.translationAttempt(ctx, doc, m, translationBatch{Before: batch.Before, Paragraphs: missing, After: batch.After}, service, progress)
		if err != nil {
			return err
		}
		attempts = append(attempts, retry)
	}
	last := attempts[len(attempts)-1]
	failed := []TranslationBlock{}
	for _, paragraph := range unfinished() {
		t := TranslationBlock{BlockID: paragraph.BlockID, SourceHash: paragraph.SourceHash, Status: "failed", Sentences: []TranslationSentence{}, Error: last.reason(paragraph.BlockID)}
		if len(attempts) > 1 {
			t.Error = "补译后仍未完成：" + t.Error
		}
		if ctx.Err() != nil {
			t.Status = "pending"
			t.Error = ""
		}
		if err := s.saveTranslation(doc.ID, t, m); err != nil {
			return err
		}
		if t.Status == "failed" {
			failed = append(failed, t)
			reason := "missing_output"
			if last.err != nil {
				reason = "provider_error"
			} else if message := last.decoder.invalid[t.BlockID]; message != "" {
				reason = "invalid_output"
				if strings.Contains(message, "原文句子未完整对应") {
					reason = "source_mismatch"
				}
			}
			s.diagnosticEvent(slog.LevelError, "translation.item_failed", "documentId", doc.ID, "blockId", t.BlockID, "phase", "text", "reasonCode", reason)
		}
	}
	if len(failed) > 0 {
		s.recordTranslationFailure(doc.ID, batch, attempts, failed)
	}
	return ctx.Err()
}

// recordTranslationFailure keeps the raw provider output of a batch that left
// paragraphs failed, so a failure can be attributed after the fact.
func (s *Server) recordTranslationFailure(documentID string, batch translationBatch, attempts []*translationAttempt, failed []TranslationBlock) {
	span := batch.Paragraphs[0].BlockID + "…" + batch.Paragraphs[len(batch.Paragraphs)-1].BlockID
	log.Printf("translation %s %s: %d/%d paragraphs failed after %d attempt(s): %s", documentID, span, len(failed), len(batch.Paragraphs), len(attempts), failed[0].Error)
	var b strings.Builder
	fmt.Fprintf(&b, "time: %s\nbatch: %s (%d paragraphs)\n", time.Now().UTC().Format(time.RFC3339), span, len(batch.Paragraphs))
	for _, t := range failed {
		fmt.Fprintf(&b, "failed %s: %s\n", t.BlockID, t.Error)
	}
	for i, a := range attempts {
		fmt.Fprintf(&b, "\n=== attempt %d: %d paragraphs requested, %d saved, %d output lines, %d unparsable\n", i+1, a.paragraphs, len(a.decoder.completed), a.decoder.lines, a.decoder.malformed)
		if a.err != nil {
			fmt.Fprintf(&b, "provider error: %v\n", a.err)
		}
	}
	// Keep trusted diagnostic metadata before a single untrusted output section.
	// Export removes everything after this marker, including forged delimiters.
	b.WriteString("--- raw output ---\n")
	for i, a := range attempts {
		fmt.Fprintf(&b, "=== raw attempt %d ===\n", i+1)
		b.WriteString(a.output.String())
		if a.truncated {
			fmt.Fprintf(&b, "\n--- output truncated at %d bytes ---", translationDiagnosticOutput)
		}
		b.WriteString("\n")
	}
	dir := filepath.Join(s.Store.Root, "cache", documentID, "translation-failures")
	name := time.Now().UTC().Format("20060102T150405.000000000Z") + "-" + translationFileID.ReplaceAllString(batch.Paragraphs[0].BlockID, "_") + ".txt"
	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Printf("cannot record translation failure: %v", err)
		return
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(b.String()), 0o600); err != nil {
		log.Printf("cannot record translation failure: %v", err)
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	// Names start with a UTC timestamp, so directory order is oldest first.
	for i := 0; i < len(entries)-translationFailureLogs; i++ {
		_ = os.Remove(filepath.Join(dir, entries[i].Name()))
	}
}

var translationFileID = regexp.MustCompile(`[^A-Za-z0-9_-]`)

func (s *Server) settleTranslations(ctx context.Context, p *Processing, m translationInput) error {
	options, err := s.retranslationOptions(p)
	if err != nil {
		return err
	}
	doc, err := s.Store.Document(p.DocumentID)
	if err != nil {
		return err
	}
	s.processingMu.Lock()
	items, err := s.textTranslations(p.DocumentID, m)
	if err == nil {
		for i := range items {
			if items[i].Status == "running" {
				items[i].Status = "pending"
				if err = s.saveTranslation(p.DocumentID, items[i]); err != nil {
					break
				}
			}
		}
	}
	s.processingMu.Unlock()
	if err != nil {
		return err
	}
	for {
		if err = ctx.Err(); err != nil {
			return err
		}
		items, err = s.textTranslations(p.DocumentID, m)
		if err != nil {
			return err
		}
		if err = s.refreshTranslationCounts(p, m); err != nil {
			return err
		}
		if len(items) > 0 {
			p.Phase = "translating"
			p.Detail = fmt.Sprintf("正在翻译正文 · %d / %d 段", p.TranslationsDone, p.TranslationsTotal)
			if err = s.Store.saveProcessing(*p); err != nil {
				return err
			}
		}
		batches := translationBatches(m, items, translationBatchCharacters)
		if len(batches) == 0 {
			return nil
		}
		config := options.apply(s.aiConfig())
		if !validAgent(config.Primary) || !(primaryCapable(config, taskTranslation) || capable(config, "text-api", false)) {
			s.configMu.Lock()
			config = options.apply(s.readAIConfig())
			if !validAgent(config.Primary) || !(primaryCapable(config, taskTranslation) || capable(config, "text-api", false)) {
				s.processingMu.Lock()
				p.Status = "waiting"
				p.Detail = "请选择主 Agent 并完成文字能力测试，随后继续翻译"
				err = s.Store.saveProcessing(*p)
				s.processingMu.Unlock()
				s.configMu.Unlock()
				return err
			}
			s.configMu.Unlock()
		}
		var progressMu sync.Mutex
		progress := func() {
			progressMu.Lock()
			defer progressMu.Unlock()
			if err := s.refreshTranslationCounts(p, m); err != nil {
				log.Printf("cannot read translation progress: %v", err)
				return
			}
			p.Detail = fmt.Sprintf("正在翻译正文 · %d / %d 段", p.TranslationsDone, p.TranslationsTotal)
			if err := s.Store.saveProcessing(*p); err != nil {
				log.Printf("cannot save translation progress: %v", err)
			}
		}
		jobs := make(chan translationBatch)
		failures := make(chan error, translationBatchConcurrency)
		work, cancel := context.WithCancel(ctx)
		var workers sync.WaitGroup
		for i := 0; i < min(translationBatchConcurrency, len(batches)); i++ {
			workers.Add(1)
			go func() {
				defer workers.Done()
				service, session := s.translationService(config)
				defer session.close()
				for batch := range jobs {
					if work.Err() != nil {
						return
					}
					s.processingMu.Lock()
					var startErr error
					for _, paragraph := range batch.Paragraphs {
						startErr = s.saveTranslation(doc.ID, TranslationBlock{BlockID: paragraph.BlockID, SourceHash: paragraph.SourceHash, Status: "running", Sentences: []TranslationSentence{}})
						if startErr != nil {
							break
						}
					}
					s.processingMu.Unlock()
					if startErr == nil {
						startErr = s.translateBatch(work, doc, m, batch, service, progress)
					}
					if startErr != nil {
						failures <- startErr
						cancel()
						return
					}
				}
			}()
		}
	send:
		for _, batch := range batches {
			select {
			case jobs <- batch:
			case <-work.Done():
				break send
			}
		}
		close(jobs)
		workers.Wait()
		cancel()
		close(failures)
		for failure := range failures {
			if failure != nil {
				return failure
			}
		}
	}
}

// Text batches never reset or count the concurrently converted formula records.
func (s *Server) textTranslations(documentID string, m translationInput) ([]TranslationBlock, error) {
	items, err := s.translations(documentID, m)
	textIDs := map[string]bool{}
	for _, p := range m.translationParagraphs() {
		textIDs[p.BlockID] = true
	}
	out := []TranslationBlock{}
	for _, t := range items {
		if textIDs[t.BlockID] {
			out = append(out, t)
		}
	}
	return out, err
}

func (s *Server) refreshTranslationCounts(p *Processing, m translationInput) error {
	items, err := s.translations(p.DocumentID, m)
	if err != nil {
		return err
	}
	p.TranslationsDone, p.TranslationsTotal = translationCounts(items)
	return nil
}

// Idle paragraphs were never requested and do not count toward progress.
func translationCounts(items []TranslationBlock) (done, total int) {
	for _, item := range items {
		if item.Status == "idle" {
			continue
		}
		total++
		if item.Status == "complete" {
			done++
		}
	}
	return done, total
}
