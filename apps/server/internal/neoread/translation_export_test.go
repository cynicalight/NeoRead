package neoread

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func saveExportTranslation(t *testing.T, s *Server, b PDFBlock, target string) {
	t.Helper()
	item := newTranslation(b)
	item.Status = "complete"
	item.Sentences = []TranslationSentence{{Source: b.Text, Target: target}}
	if err := s.saveTranslation("doc", item); err != nil {
		t.Fatal(err)
	}
}

func TestTranslationExportUsesSavedResultsAndMarksGaps(t *testing.T) {
	s, _, m := translationFixture(t)
	saveExportTranslation(t, s, m.Blocks[0], "**第一句**包含 $x^2$。\n\n| 项目 | 值 |\n| --- | --- |\n| 甲 | 1 |")
	partial := newTranslation(m.Blocks[1])
	partial.Status = "running"
	partial.Sentences = []TranslationSentence{{Target: "未完成的临时输出"}}
	if err := s.saveTranslation("doc", partial); err != nil {
		t.Fatal(err)
	}
	m.ParsedPages = []int{1}
	m.IncompletePages = []int{1}
	decoration := m.Blocks[0]
	decoration.ID, decoration.Label, decoration.Text = "p1-b3", "header", "不要导出页眉"
	m.Blocks = append(m.Blocks, decoration)
	if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), []byte(jsonText(m)), 0600); err != nil {
		t.Fatal(err)
	}
	before, _ := s.Store.processing("doc")
	w := request(t, s, "GET", "/api/documents/doc/translations/export", nil)
	if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/markdown") {
		t.Fatal(w.Code, w.Body.String())
	}
	text := w.Body.String()
	for _, want := range []string{"**第一句**包含 $x^2$。", "| 甲 | 1 |", "已完成 1 / 2", "此段尚未翻译", "## 第 2 页\n\n> 此页尚未解析"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in %s", want, text)
		}
	}
	for _, unwanted := range []string{"未完成的临时输出", "不要导出页眉", "test-secret", "First sentence", "此页解析不完整"} {
		if strings.Contains(text, unwanted) {
			t.Fatalf("leaked %q", unwanted)
		}
	}
	after, _ := s.Store.processing("doc")
	if jsonText(before) != jsonText(after) {
		t.Fatal("export changed processing state")
	}
}

func TestTranslationExportRejectsEmptyStaleAndUnauthorized(t *testing.T) {
	s, _, m := translationFixture(t)
	if w := request(t, s, "GET", "/api/documents/doc/translations/export", nil); w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	saveExportTranslation(t, s, m.Blocks[0], "旧来源的译文")
	m.Blocks[0].Text = "Changed source text."
	if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), []byte(jsonText(m)), 0600); err != nil {
		t.Fatal(err)
	}
	if w := request(t, s, "GET", "/api/documents/doc/translations/export", nil); w.Code != 409 || strings.Contains(w.Body.String(), "旧来源的译文") {
		t.Fatal(w.Code, w.Body.String())
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1/api/documents/doc/translations/export", nil))
	if w.Code != 401 {
		t.Fatal("unauthorized export", w.Code)
	}
	for path, status := range map[string]int{
		"/api/documents/doc/translations/export?format=pdf": 400,
		"/api/documents/missing/translations/export":        404,
	} {
		if w := request(t, s, "GET", path, nil); w.Code != status {
			t.Fatal(path, w.Code)
		}
	}
}

func TestTranslationExportRetainsPreviousResultsDuringRetranslation(t *testing.T) {
	s, _, _ := completedTranslationFixture(t)
	assistanceRequest(t, s, "retranslate")
	w := request(t, s, "GET", "/api/documents/doc/translations/export", nil)
	if w.Code != 200 || strings.Count(w.Body.String(), "旧译文") != 2 || strings.Contains(w.Body.String(), "此段尚未翻译") {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestTranslationExportCombinesSelectedNotesWithoutSavingThem(t *testing.T) {
	s, _, m := translationFixture(t)
	saveExportTranslation(t, s, m.Blocks[0], "正文译文")
	const notes = "## 论文笔记\n\n所选笔记\n\n## 批注\n\n> 所选摘录\n\n批注内容"
	body := jsonText(map[string]string{"notesMarkdown": notes})
	for _, format := range []string{"markdown", "zip"} {
		w := request(t, s, "POST", "/api/documents/doc/translations/export?format="+format, strings.NewReader(body))
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		text := w.Body.String()
		if format == "zip" {
			text = unzipExport(t, w.Body.Bytes())["translation.md"]
		}
		if !strings.Contains(text, "正文译文") || !strings.HasSuffix(text, "---\n\n"+notes+"\n") || strings.Count(text, "# test\n") != 1 {
			t.Fatal("selected content missing or repeated", text)
		}
	}
	var count int
	if err := s.Store.DB.QueryRow("SELECT COUNT(*) FROM document_notes WHERE document_id='doc'").Scan(&count); err != nil || count != 0 {
		t.Fatal("download changed notes", count, err)
	}
	w := request(t, s, "POST", "/api/documents/doc/translations/export", strings.NewReader(`{"unknown":true}`))
	if w.Code != 400 {
		t.Fatal("accepted unknown export fields", w.Code)
	}
}

func unzipExport(t *testing.T, data []byte) map[string]string {
	t.Helper()
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	for _, entry := range z.File {
		r, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(r)
		r.Close()
		if err != nil {
			t.Fatal(err)
		}
		files[entry.Name] = string(b)
	}
	return files
}

func TestTranslationExportBundlesImagesAndPreservesFormulaAndCode(t *testing.T) {
	s, _, m := translationFixture(t)
	saveExportTranslation(t, s, m.Blocks[0], "正文译文")
	image := m.Blocks[0]
	image.ID, image.Label, image.Image, image.Text, image.Caption = "p1-b3", "chart", "assets/p1-b3.png", "", "Figure [one]"
	saveExportTranslation(t, s, image, "图一：结果")
	formula := m.Blocks[0]
	formula.ID, formula.Label, formula.Image = "p1-b4", "display_formula", "assets/p1-b4.png"
	f := newTranslation(formula)
	f.Status, f.FormulaMarkdown = "complete", "$$\nx^2\n$$"
	if err := s.saveTranslation("doc", f); err != nil {
		t.Fatal(err)
	}
	algorithm := m.Blocks[0]
	algorithm.ID, algorithm.Label, algorithm.Text = "p1-b5", "algorithm", "if x: print(```)"
	reference := m.Blocks[0]
	reference.ID, reference.Label, reference.Text = "p1-b6", "reference_content", "[1] Original reference."
	m.Blocks = append(m.Blocks, image, formula, algorithm, reference)
	if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), []byte(jsonText(m)), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), image.Image), []byte("image data"), 0600); err != nil {
		t.Fatal(err)
	}
	w := request(t, s, "GET", "/api/documents/doc/translations/export?format=zip", nil)
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/zip" {
		t.Fatal(w.Code, w.Body.String())
	}
	files := unzipExport(t, w.Body.Bytes())
	if len(files) != 2 || files["assets/image-0001.png"] != "image data" {
		t.Fatal(files)
	}
	text := files["translation.md"]
	for _, want := range []string{"![Figure \\[one\\]](assets/image-0001.png)", "图一：结果", "$$\nx^2\n$$", "````text\nif x: print(```)\n````", "[1] Original reference."} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in %s", want, text)
		}
	}
	if strings.Index(text, "正文译文") > strings.Index(text, "图一：结果") {
		t.Fatal("reading order changed")
	}
	if w := request(t, s, "GET", "/api/documents/doc/translations/export", nil); w.Code != 200 || !strings.Contains(w.Body.String(), "data:image/png;base64,aW1hZ2UgZGF0YQ==") || strings.Contains(w.Body.String(), "图片未包含") {
		t.Fatal("standalone markdown did not embed image", w.Code)
	}
	if err := os.Remove(filepath.Join(s.analysisDir("doc"), image.Image)); err != nil {
		t.Fatal(err)
	}
	if w := request(t, s, "GET", "/api/documents/doc/translations/export?format=zip", nil); w.Code != 500 || w.Header().Get("Content-Disposition") != "" {
		t.Fatal("missing image produced download", w.Code)
	}
	if w := request(t, s, "GET", "/api/documents/doc/translations/export", nil); w.Code != 500 || w.Header().Get("Content-Disposition") != "" {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestTranslationExportEPUBReadingOrderAndLocalImages(t *testing.T) {
	s, _ := epubRangeFixture(t, nil)
	cache := filepath.Join(s.Store.Root, "cache", "doc")
	if err := os.WriteFile(filepath.Join(cache, "a.xhtml"), []byte(`<html><body><h1>Title</h1><p>Paragraph.</p><img src="figure.png" alt="Figure"/><img src="figure.png" alt="Again"/></body></html>`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, "figure.png"), []byte("EPUB image"), 0600); err != nil {
		t.Fatal(err)
	}
	m, err := s.readEPUBBlocks("doc")
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range m.translationItems() {
		item.Status = "complete"
		item.Sentences = []TranslationSentence{{Target: "译文 " + item.BlockID}}
		if err := s.saveTranslation("doc", item); err != nil {
			t.Fatal(err)
		}
	}
	w := request(t, s, "GET", "/api/documents/doc/translations/export?format=zip", nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	files := unzipExport(t, w.Body.Bytes())
	text := files["translation.md"]
	if len(files) != 2 || files["assets/image-0001.png"] != "EPUB image" || strings.Count(text, "(assets/image-0001.png)") != 2 {
		t.Fatal(files)
	}
	if strings.Contains(text, "## 第 1 页") || !strings.Contains(text, "### 译文 "+m[0].ID) || strings.Index(text, m[1].ID) > strings.Index(text, m[len(m)-1].ID) {
		t.Fatal("lost EPUB reading order", text)
	}
}

func TestTranslationArchiveRejectsEscapingImages(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "private.png")
	if err := os.WriteFile(outside, []byte("private contents"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape.png")); err != nil {
		t.Skip(err)
	}
	for _, source := range []string{outside, "../private.png", "escape.png"} {
		if _, err := inlineTranslationImages(root, "![image](assets/image.png)", []translationExportAsset{{source, "assets/image.png"}}); err == nil {
			t.Fatal("inline export escaped document root", source)
		}
		var out bytes.Buffer
		if err := writeTranslationArchive(&out, root, "text", []translationExportAsset{{source, "assets/image.png"}}); err == nil || bytes.Contains(out.Bytes(), []byte("private contents")) {
			t.Fatal("escaped document root", source, err)
		}
	}
}
