package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type creator struct {
	Given  string `json:"given"`
	Family string `json:"family"`
	Name   string `json:"name"`
}
type metadata struct {
	ItemType        string    `json:"itemType"`
	TranslatedTitle string    `json:"translatedTitle"`
	Creators        []creator `json:"creators"`
	Date            string    `json:"date"`
	Venue           string    `json:"venue"`
	DOI             string    `json:"doi"`
	ArXiv           string    `json:"arxiv"`
	ISBN            string    `json:"isbn"`
	URL             string    `json:"url"`
	Abstract        string    `json:"abstract"`
	Remark          string    `json:"remark"`
}
type document struct {
	ID                string   `json:"id"`
	Type              string   `json:"type"`
	Title             string   `json:"title"`
	Author            string   `json:"author"`
	Library           string   `json:"library"`
	Tags              []string `json:"tags"`
	Folders           []string `json:"folders"`
	ReadingStatus     string   `json:"readingStatus"`
	Percentage        float64  `json:"percentage"`
	NoteCount         int      `json:"noteCount"`
	HighlightCount    int      `json:"highlightCount"`
	OpenQuestionCount int      `json:"openQuestionCount"`
	CreatedAt         string   `json:"createdAt"`
	Metadata          metadata `json:"metadata"`
}

func (d document) short() string { return d.ID[:min(8, len(d.ID))] }
func (d document) authors() string {
	names := []string{}
	for _, c := range d.Metadata.Creators {
		switch {
		case c.Name != "":
			names = append(names, c.Name)
		case c.Given != "" && c.Family != "":
			names = append(names, c.Given+" "+c.Family)
		default:
			names = append(names, c.Given+c.Family)
		}
	}
	if len(names) == 0 && d.Author != "" {
		return d.Author
	}
	if len(names) > 3 {
		return strings.Join(names[:3], ", ") + " 等"
	}
	return strings.Join(names, ", ")
}
func (d document) year() string {
	if len(d.Metadata.Date) >= 4 {
		return d.Metadata.Date[:4]
	}
	return ""
}

func writeJSON(out io.Writer, v any) error {
	e := json.NewEncoder(out)
	e.SetEscapeHTML(false)
	e.SetIndent("", "  ")
	return e.Encode(v)
}

func (c *client) documents() ([]document, error) {
	docs := []document{}
	return docs, c.get("/api/documents", nil, &docs)
}

// resolve accepts an ID, a unique ID prefix or a unique piece of a title.
func (c *client) resolve(ref string) (document, error) {
	docs, err := c.documents()
	if err != nil {
		return document{}, err
	}
	ref = strings.TrimSpace(ref)
	lower := strings.ToLower(ref)
	var byID, byTitle []document
	for _, d := range docs {
		if d.ID == ref {
			return d, nil
		}
		if len(ref) >= 4 && strings.HasPrefix(d.ID, lower) {
			byID = append(byID, d)
		}
		if strings.Contains(strings.ToLower(d.Title), lower) || strings.Contains(strings.ToLower(d.Metadata.TranslatedTitle), lower) {
			byTitle = append(byTitle, d)
		}
	}
	for _, matches := range [][]document{byID, byTitle} {
		if len(matches) == 1 {
			return matches[0], nil
		}
		if len(matches) > 1 {
			lines := []string{fmt.Sprintf("%q 对应 %d 份文档，请改用 ID：", ref, len(matches))}
			for i, d := range matches {
				if i == 10 {
					lines = append(lines, "  …")
					break
				}
				lines = append(lines, "  "+d.short()+"  "+d.Title)
			}
			return document{}, exitError{1, strings.Join(lines, "\n")}
		}
	}
	return document{}, exitError{1, fmt.Sprintf("没有找到文档 %q，运行 reader list 查看全部文档", ref)}
}

func runStatus(c *client, f *options, args []string, out io.Writer) error {
	docs, err := c.documents()
	if err != nil {
		return err
	}
	if f.json {
		return writeJSON(out, map[string]any{"running": true, "url": c.base, "version": c.version, "library": c.library, "documents": len(docs)})
	}
	fmt.Fprintf(out, "Reader %s 正在运行（%s）\n书库：%s\n文档：%d 份\n", c.version, c.base, c.library, len(docs))
	return nil
}

func listFlags(fs *flag.FlagSet, f *options) {
	fs.StringVar(&f.library, "library", "", "只列出论文库（papers）或图书库（books）")
	fs.StringVar(&f.docType, "type", "", "只列出 pdf 或 epub")
	fs.StringVar(&f.tag, "tag", "", "只列出带这个标签的文档")
	fs.StringVar(&f.folder, "folder", "", "只列出这个分类（含子分类）中的文档")
	fs.StringVar(&f.status, "status", "", "阅读状态：unread、reading 或 read")
	fs.StringVar(&f.query, "query", "", "标题、作者、出处或 DOI 中包含的文字")
	fs.IntVar(&f.limit, "limit", 0, "最多列出几份，0 表示全部")
}
func runList(c *client, f *options, args []string, out io.Writer) error {
	if len(args) > 0 {
		return usageError("list 不接受参数；用 --query 按文字筛选")
	}
	if f.library != "" && f.library != "papers" && f.library != "books" {
		return usageError("--library 只能是 papers 或 books")
	}
	docs, err := c.documents()
	if err != nil {
		return err
	}
	query := strings.ToLower(f.query)
	selected := []document{}
	for _, d := range docs {
		if (f.library != "" && d.Library != f.library) || (f.docType != "" && d.Type != f.docType) || (f.status != "" && d.ReadingStatus != f.status) {
			continue
		}
		if f.tag != "" && !containsFold(d.Tags, f.tag) {
			continue
		}
		if f.folder != "" && !inFolder(d.Folders, f.folder) {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(strings.Join([]string{d.Title, d.Metadata.TranslatedTitle, d.authors(), d.Metadata.Venue, d.Metadata.DOI, d.Metadata.ArXiv}, "\n")), query) {
			continue
		}
		selected = append(selected, d)
		if f.limit > 0 && len(selected) == f.limit {
			break
		}
	}
	if f.json {
		return writeJSON(out, selected)
	}
	for _, d := range selected {
		details := []string{}
		for _, part := range []string{d.authors(), d.year(), d.Metadata.Venue} {
			if part != "" {
				details = append(details, part)
			}
		}
		line := fmt.Sprintf("%s  %-4s  %s", d.short(), strings.ToUpper(d.Type), d.Title)
		if len(details) > 0 {
			line += "（" + strings.Join(details, "，") + "）"
		}
		for _, tag := range d.Tags {
			line += "  #" + tag
		}
		fmt.Fprintln(out, line)
	}
	fmt.Fprintf(out, "共 %d 份\n", len(selected))
	return nil
}
func containsFold(values []string, want string) bool {
	for _, v := range values {
		if strings.EqualFold(v, want) {
			return true
		}
	}
	return false
}
func inFolder(folders []string, want string) bool {
	want = strings.Trim(want, "/")
	for _, f := range folders {
		if strings.EqualFold(f, want) || strings.HasPrefix(strings.ToLower(f), strings.ToLower(want)+"/") {
			return true
		}
	}
	return false
}

func runShow(c *client, f *options, args []string, out io.Writer) error {
	ref, err := oneDocument(args, "show")
	if err != nil {
		return err
	}
	d, err := c.resolve(ref)
	if err != nil {
		return err
	}
	if f.json {
		return writeJSON(out, d)
	}
	fmt.Fprintln(out, d.Title)
	rows := [][2]string{
		{"ID", d.ID},
		{"译名", d.Metadata.TranslatedTitle},
		{"类型", strings.ToUpper(d.Type) + "，" + map[string]string{"papers": "论文库", "books": "图书库"}[d.Library]},
		{"作者", d.authors()},
		{"日期", d.Metadata.Date},
		{"出处", d.Metadata.Venue},
		{"DOI", d.Metadata.DOI},
		{"arXiv", d.Metadata.ArXiv},
		{"ISBN", d.Metadata.ISBN},
		{"链接", d.Metadata.URL},
		{"标签", strings.Join(d.Tags, "，")},
		{"分类", strings.Join(d.Folders, "，")},
		{"阅读", fmt.Sprintf("%s，%.0f%%", map[string]string{"unread": "未读", "reading": "在读", "read": "已读"}[d.ReadingStatus], d.Percentage*100)},
		{"批注", fmt.Sprintf("%d 条高亮，%d 条笔记，%d 个待回答的问题", d.HighlightCount, d.NoteCount, d.OpenQuestionCount)},
		{"备注", d.Metadata.Remark},
	}
	for _, row := range rows {
		if strings.Trim(row[1], "，% 0") != "" {
			fmt.Fprintf(out, "  %s：%s\n", row[0], row[1])
		}
	}
	if abstract := trimLines(d.Metadata.Abstract); abstract != "" {
		fmt.Fprintf(out, "\n摘要\n%s\n", abstract)
	}
	return nil
}

type searchHit struct {
	DocumentID string `json:"documentId"`
	Title      string `json:"title"`
	Type       string `json:"type"`
	Unit       int    `json:"unit"`
	Href       string `json:"href,omitempty"`
	BlockID    string `json:"blockId"`
	Side       string `json:"side"`
	Excerpt    string `json:"excerpt"`
}

func searchFlags(fs *flag.FlagSet, f *options) {
	fs.StringVar(&f.doc, "doc", "", "只在这份文档中搜索")
	fs.StringVar(&f.library, "library", "", "只搜索论文库（papers）或图书库（books）")
	fs.IntVar(&f.limit, "limit", 20, "最多返回几条（1–200）")
}
func runSearch(c *client, f *options, args []string, out io.Writer) error {
	q := strings.TrimSpace(strings.Join(args, " "))
	if q == "" {
		return usageError("用法：reader search <关键词…>")
	}
	query := url.Values{"q": {q}, "limit": {strconv.Itoa(f.limit)}}
	if f.library != "" {
		query.Set("library", f.library)
	}
	if f.doc != "" {
		d, err := c.resolve(f.doc)
		if err != nil {
			return err
		}
		query.Set("document", d.ID)
	}
	hits := []searchHit{}
	if err := c.get("/api/search", query, &hits); err != nil {
		return err
	}
	if f.json {
		return writeJSON(out, hits)
	}
	for _, h := range hits {
		side := ""
		if h.Side == "translation" {
			side = "  [译文]"
		}
		fmt.Fprintf(out, "%s  %s  %s%s\n    %s\n", h.DocumentID[:min(8, len(h.DocumentID))], h.Title, unitName(h.Type, h.Unit), side, h.Excerpt)
	}
	fmt.Fprintf(out, "共 %d 条", len(hits))
	if len(hits) == f.limit {
		fmt.Fprint(out, "（已达上限，可用 --limit 调大）")
	}
	fmt.Fprintln(out, "\n只搜索已解析版面的 PDF 和 EPUB。")
	return nil
}
func unitName(docType string, unit int) string {
	if docType == "epub" {
		return fmt.Sprintf("第 %d 章", unit)
	}
	return fmt.Sprintf("第 %d 页", unit)
}

type textBlock struct {
	ID          string `json:"id"`
	Unit        int    `json:"unit"`
	Href        string `json:"href,omitempty"`
	Label       string `json:"label"`
	Text        string `json:"text"`
	Translation string `json:"translation,omitempty"`
}
type documentText struct {
	DocumentID  string      `json:"documentId"`
	Title       string      `json:"title"`
	Type        string      `json:"type"`
	Units       int         `json:"units"`
	Parsed      bool        `json:"parsed"`
	ParsedPages []int       `json:"parsedPages,omitempty"`
	Blocks      []textBlock `json:"blocks"`
}

func readFlags(fs *flag.FlagSet, f *options) {
	fs.StringVar(&f.pages, "pages", "", "PDF 页码范围，如 3 或 3-5")
	fs.StringVar(&f.chapters, "chapters", "", "EPUB 章节范围（按阅读顺序），如 2 或 2-4")
	fs.StringVar(&f.side, "side", "source", "source（原文）、translation（译文）或 both（对照）")
}

// parseRange reads "3" or "3-5"; an open end such as "3-" reads to the end.
func parseRange(raw string) (from, to int, err error) {
	start, end, ranged := strings.Cut(strings.TrimSpace(raw), "-")
	if from, err = strconv.Atoi(start); err != nil || from < 1 {
		return 0, 0, usageError("范围 %q 无效，应为 3 或 3-5", raw)
	}
	if !ranged {
		return from, from, nil
	}
	if end == "" {
		return from, 0, nil
	}
	if to, err = strconv.Atoi(end); err != nil || to < from {
		return 0, 0, usageError("范围 %q 无效，应为 3 或 3-5", raw)
	}
	return from, to, nil
}

func runRead(c *client, f *options, args []string, out io.Writer) error {
	ref, err := oneDocument(args, "read")
	if err != nil {
		return err
	}
	if f.side != "source" && f.side != "translation" && f.side != "both" {
		return usageError("--side 只能是 source、translation 或 both")
	}
	d, err := c.resolve(ref)
	if err != nil {
		return err
	}
	raw := f.pages
	if d.Type == "epub" {
		if f.pages != "" {
			return usageError("EPUB 没有页码，请用 --chapters")
		}
		raw = f.chapters
	} else if f.chapters != "" {
		return usageError("PDF 按页读取，请用 --pages")
	}
	query := url.Values{"side": {f.side}}
	if raw != "" {
		from, to, err := parseRange(raw)
		if err != nil {
			return err
		}
		query.Set("from", strconv.Itoa(from))
		if to > 0 {
			query.Set("to", strconv.Itoa(to))
		}
	}
	var text documentText
	if err = c.get("/api/documents/"+url.PathEscape(d.ID)+"/text", query, &text); err != nil {
		return err
	}
	text.Title = d.Title
	if f.json {
		return writeJSON(out, text)
	}
	if !text.Parsed {
		return exitError{1, "这份 PDF 还没有完成版面解析，暂时读不到正文。论文导入后会自动解析，请等待解析完成；解析失败时可在 Reader 中重试。"}
	}
	fmt.Fprintf(out, "# %s\n", d.Title)
	unit, untranslated := 0, 0
	for _, b := range text.Blocks {
		body := b.Text
		if f.side == "translation" {
			body = b.Translation
		}
		if body == "" {
			untranslated++
			continue
		}
		if b.Unit != unit {
			unit = b.Unit
			fmt.Fprintf(out, "\n## %s\n", unitName(text.Type, unit))
		}
		fmt.Fprintf(out, "\n%s\n", formatBlock(b.Label, body))
		if f.side == "both" {
			switch strings.TrimSpace(b.Translation) {
			case "":
				untranslated++
			case strings.TrimSpace(b.Text):
				// Names, emails and code come back unchanged; don't print them twice.
			default:
				fmt.Fprintf(out, "\n译：%s\n", b.Translation)
			}
		}
	}
	if len(text.Blocks) == 0 {
		fmt.Fprintln(out, "\n（这个范围内没有正文）")
	}
	if f.side != "source" && untranslated > 0 {
		fmt.Fprintf(out, "\n（%d 段尚未翻译）\n", untranslated)
	}
	if len(text.ParsedPages) > 0 {
		fmt.Fprintf(out, "\n（这本书只解析了 %d 页；在 Reader 中翻译对应章节后可读到更多）\n", len(text.ParsedPages))
	}
	return nil
}

// formatBlock renders a layout block as Markdown-like text.
func formatBlock(label, text string) string {
	switch label {
	case "doc_title", "paragraph_title":
		return "### " + text
	case "chart", "image", "table", "seal":
		return "[" + map[string]string{"chart": "图表", "image": "图片", "table": "表格", "seal": "印章"}[label] + "] " + text
	case "display_formula":
		return "[公式] " + text
	case "algorithm":
		return "[算法]\n" + text
	}
	return text
}

type annotation struct {
	ID        string          `json:"id"`
	Kind      string          `json:"kind"`
	Location  json.RawMessage `json:"location"`
	Quote     string          `json:"quote"`
	Note      string          `json:"note"`
	Color     string          `json:"color"`
	CreatedAt string          `json:"createdAt"`
	AnswerID  string          `json:"answerId,omitempty"`
	Resolved  bool            `json:"resolved,omitempty"`
	Tags      []string        `json:"tags,omitempty"`
	// Answer is the chat reply that answers a question, added by this command.
	Answer string `json:"answer,omitempty"`
}

func annotationFlags(fs *flag.FlagSet, f *options) {
	fs.StringVar(&f.kind, "kind", "", "只列出一种：highlight、underline、note、question 或 bookmark")
}
func runAnnotations(c *client, f *options, args []string, out io.Writer) error {
	ref, err := oneDocument(args, "annotations")
	if err != nil {
		return err
	}
	d, err := c.resolve(ref)
	if err != nil {
		return err
	}
	all := []annotation{}
	if err = c.get("/api/documents/"+url.PathEscape(d.ID)+"/annotations", nil, &all); err != nil {
		return err
	}
	list := []annotation{}
	answers := false
	for _, a := range all {
		if f.kind == "" || a.Kind == f.kind {
			list = append(list, a)
			answers = answers || a.AnswerID != ""
		}
	}
	if answers {
		messages := []struct {
			ID      string `json:"id"`
			Content string `json:"content"`
		}{}
		if err = c.get("/api/documents/"+url.PathEscape(d.ID)+"/messages", nil, &messages); err != nil {
			return err
		}
		content := map[string]string{}
		for _, m := range messages {
			content[m.ID] = m.Content
		}
		for i := range list {
			list[i].Answer = content[list[i].AnswerID]
		}
	}
	if f.json {
		return writeJSON(out, list)
	}
	names := map[string]string{"highlight": "高亮", "underline": "下划线", "note": "笔记", "question": "问题", "bookmark": "书签"}
	for _, a := range list {
		fmt.Fprintf(out, "[%s] %s\n", names[a.Kind], locationName(a.Location))
		if quote := trimLines(a.Quote); quote != "" {
			fmt.Fprintf(out, "  > %s\n", strings.ReplaceAll(quote, "\n", "\n  > "))
		}
		if note := trimLines(a.Note); note != "" {
			fmt.Fprintf(out, "  %s\n", strings.ReplaceAll(note, "\n", "\n  "))
		}
		if a.Answer != "" {
			fmt.Fprintf(out, "  回答：%s\n", strings.ReplaceAll(trimLines(a.Answer), "\n", "\n  "))
		}
		fmt.Fprintln(out)
	}
	fmt.Fprintf(out, "共 %d 条\n", len(list))
	return nil
}
func locationName(raw json.RawMessage) string {
	var l struct {
		Type string `json:"type"`
		Page int    `json:"page"`
		Href string `json:"href"`
	}
	_ = json.Unmarshal(raw, &l)
	if l.Type == "pdf" && l.Page > 0 {
		return fmt.Sprintf("第 %d 页", l.Page)
	}
	return l.Href
}

func runNote(c *client, f *options, args []string, out io.Writer) error {
	ref, err := oneDocument(args, "note")
	if err != nil {
		return err
	}
	d, err := c.resolve(ref)
	if err != nil {
		return err
	}
	var note struct {
		Body      string `json:"body"`
		UpdatedAt string `json:"updatedAt,omitempty"`
	}
	if err = c.get("/api/documents/"+url.PathEscape(d.ID)+"/note", nil, &note); err != nil {
		return err
	}
	if f.json {
		return writeJSON(out, note)
	}
	if strings.TrimSpace(note.Body) == "" {
		fmt.Fprintln(out, "（这份文档还没有笔记）")
		return nil
	}
	fmt.Fprintln(out, trimLines(note.Body))
	return nil
}

func importFlags(fs *flag.FlagSet, f *options) {
	fs.StringVar(&f.library, "library", "papers", "导入论文库（papers）或图书库（books）")
	fs.BoolVar(&f.allowLarge, "allow-large", false, "超过 100 页或 100 MB 的 PDF 仍导入论文库")
}

type importResult struct {
	File     string    `json:"file"`
	Status   string    `json:"status"`
	Document *document `json:"document,omitempty"`
	Error    string    `json:"error,omitempty"`
}

func runImport(c *client, f *options, args []string, out io.Writer) error {
	if len(args) == 0 {
		return usageError("用法：reader import <文件…>")
	}
	if f.library != "papers" && f.library != "books" {
		return usageError("--library 只能是 papers 或 books")
	}
	results := []importResult{}
	failed := 0
	for _, path := range args {
		result := importResult{File: path}
		ext := strings.ToLower(filepath.Ext(path))
		info, statErr := os.Stat(path)
		switch {
		case statErr != nil:
			result.Status, result.Error = "failed", "无法读取文件"
		case info.IsDir():
			result.Status, result.Error = "failed", "这是一个目录"
		case ext != ".pdf" && ext != ".epub":
			result.Status, result.Error = "failed", "只支持 PDF 和 EPUB"
		default:
			var d document
			status, err := c.upload(path, f.library, f.allowLarge, &d)
			var api apiError
			switch {
			case errors.As(err, &api) && api.Body["code"] == "large-paper":
				result.Status, result.Error = "failed", fmt.Sprintf("%v（%v 页）。加 --allow-large 仍导入论文库，或用 --library books 导入图书库", api, api.Body["pages"])
			case err != nil:
				var exit exitError
				if errors.As(err, &exit) {
					return err
				}
				result.Status, result.Error = "failed", err.Error()
			case status == 201:
				result.Status, result.Document = "imported", &d
			default:
				result.Status, result.Document = "existing", &d
			}
		}
		if result.Status == "failed" {
			failed++
		}
		results = append(results, result)
		if !f.json {
			switch result.Status {
			case "imported":
				fmt.Fprintf(out, "已导入  %s  %s\n", result.Document.short(), result.Document.Title)
			case "existing":
				fmt.Fprintf(out, "已存在  %s  %s（%s）\n", result.Document.short(), result.Document.Title, map[string]string{"papers": "论文库", "books": "图书库"}[result.Document.Library])
			default:
				fmt.Fprintf(out, "失败    %s：%s\n", path, result.Error)
			}
		}
	}
	if f.json {
		if err := writeJSON(out, results); err != nil {
			return err
		}
	}
	if failed > 0 {
		return exitError{1, fmt.Sprintf("%d 个文件导入失败", failed)}
	}
	return nil
}
