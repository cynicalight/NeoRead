package neoread

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/draw"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var epubBlockIDPattern = regexp.MustCompile(`^e-[0-9a-f]{32}$`)

// readEPUBBlockImage converts an EPUB image block to PNG, the format every
// image attachment, copy and preview path already uses for PDF blocks.
func (s *Server) readEPUBBlockImage(documentID, blockID string) (PDFBlock, []byte, error) {
	if !epubBlockIDPattern.MatchString(blockID) {
		return PDFBlock{}, nil, errors.New("图片编号无效")
	}
	blocks, err := s.readEPUBBlocks(documentID)
	if err != nil {
		return PDFBlock{}, nil, errors.New("图片索引不可用")
	}
	for _, b := range blocks {
		if b.ID != blockID || b.Image == "" {
			continue
		}
		block := PDFBlock{ID: b.ID, Label: "image", Text: b.Text, Caption: b.Text, Image: b.Image}
		name, err := safeResource(b.Image)
		if err != nil {
			return block, nil, errors.New("图片附件不可读")
		}
		root, err := os.OpenRoot(filepath.Join(s.Store.Root, "cache", documentID))
		if err != nil {
			return block, nil, err
		}
		defer root.Close()
		file, err := root.Open(filepath.FromSlash(name))
		if err != nil {
			return block, nil, errors.New("图片附件不可读")
		}
		defer file.Close()
		data, err := io.ReadAll(io.LimitReader(file, (16<<20)+1))
		if err != nil || len(data) > 16<<20 {
			return block, nil, errors.New("图片附件过大或不可读")
		}
		config, _, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil || config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > 32_000_000 {
			return block, nil, errors.New("图片格式暂不支持")
		}
		decoded, _, err := image.Decode(bytes.NewReader(data))
		if err != nil {
			return block, nil, errors.New("图片格式暂不支持")
		}
		switch decoded.(type) {
		case *image.NRGBA, *image.RGBA, *image.Paletted, *image.Gray:
		default:
			// JPEG's YCbCr would otherwise encode as a 16-bit PNG.
			rgba := image.NewNRGBA(decoded.Bounds())
			draw.Draw(rgba, rgba.Bounds(), decoded, decoded.Bounds().Min, draw.Src)
			decoded = rgba
		}
		var out bytes.Buffer
		if err = png.Encode(&out, decoded); err != nil || out.Len() > 16<<20 {
			return block, nil, errors.New("图片附件过大或不可读")
		}
		return block, out.Bytes(), nil
	}
	return PDFBlock{}, nil, errors.New("这份文档中没有此图片")
}

type ImageAttachment struct {
	ID      string `json:"id"`
	Page    int    `json:"page"`
	Label   string `json:"label"`
	Caption string `json:"caption,omitempty"`
}

func (s *Server) readBlockImage(documentID, blockID string) (PDFBlock, []byte, error) {
	if d, err := s.Store.Document(documentID); err == nil && d.Type == "epub" {
		return s.readEPUBBlockImage(documentID, blockID)
	}
	if !blockIDPattern.MatchString(blockID) {
		return PDFBlock{}, nil, errors.New("图片编号无效")
	}
	layout, err := s.readLayout(documentID)
	if err != nil {
		return PDFBlock{}, nil, errors.New("图片索引不可用")
	}
	for _, block := range layout.Blocks {
		if block.ID != blockID || block.Image == "" {
			continue
		}
		root, err := os.OpenRoot(s.analysisDir(documentID))
		if err != nil {
			return block, nil, err
		}
		defer root.Close()
		file, err := root.Open(block.Image)
		if err != nil {
			return block, nil, errors.New("图片附件不可读")
		}
		defer file.Close()
		data, err := io.ReadAll(io.LimitReader(file, (16<<20)+1))
		if err != nil || len(data) > 16<<20 {
			return block, nil, errors.New("图片附件过大或不可读")
		}
		config, err := png.DecodeConfig(bytes.NewReader(data))
		if err != nil || config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > 32_000_000 {
			return block, nil, errors.New("图片附件格式无效")
		}
		return block, data, nil
	}
	return PDFBlock{}, nil, errors.New("这份文档中没有此图片")
}
func (s *Server) blockImage(w http.ResponseWriter, r *http.Request, documentID, blockID string) {
	_, data, err := s.readBlockImage(documentID, blockID)
	if err != nil {
		fail(w, 404, err.Error())
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "private, no-cache")
	http.ServeContent(w, r, blockID+".png", time.Time{}, bytes.NewReader(data))
}

// imageParagraphs uses the manifest's reading order, including across pages.
// Captions remain ordinary text; no caption classification or new linkage is needed.
func imageParagraphs(blocks []PDFBlock, id string) string {
	index := -1
	for i, block := range blocks {
		if block.ID == id {
			index = i
			break
		}
	}
	if index < 0 {
		return ""
	}
	neighbor := func(step int) string {
		for i := index + step; i >= 0 && i < len(blocks); i += step {
			block := blocks[i]
			if isImageAsset(block) || isPDFPageDecoration(block) || block.Label == "formula_number" {
				continue
			}
			if text := strings.TrimSpace(block.Text); text != "" {
				return fmt.Sprintf("第 %d 页：%s", block.Page, text)
			}
		}
		return ""
	}
	var context strings.Builder
	if before := neighbor(-1); before != "" {
		fmt.Fprintf(&context, "图片前一段原文：\n%s\n", before)
	}
	if after := neighbor(1); after != "" {
		fmt.Fprintf(&context, "图片后一段原文：\n%s\n", after)
	}
	return context.String()
}

func (s *Server) chatDocument(w http.ResponseWriter, r *http.Request, document Document, provider, question, textContext string, references json.RawMessage, ids []string, readingLocation json.RawMessage, userMessageID string, search ...bool) {
	documentID := document.ID
	if len(ids) > 4 {
		fail(w, 400, "每次最多附加 4 张图片")
		return
	}
	var blocks []PDFBlock
	if document.Type == "pdf" && len(ids) > 0 {
		layout, err := s.readLayout(documentID)
		if err != nil {
			fail(w, 400, "图片索引不可用")
			return
		}
		blocks = layout.Blocks
	}
	images := [][]byte{}
	attachments := []ImageAttachment{}
	seen := map[string]bool{}
	size := 0
	var descriptions strings.Builder
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		block, data, err := s.readBlockImage(documentID, id)
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		size += len(data)
		if size > 32<<20 {
			fail(w, 400, "图片附件总大小超过限制")
			return
		}
		images = append(images, data)
		if nearby := imageParagraphs(blocks, id); nearby != "" {
			// Persist the exact source context with the question so later turns
			// retain it even though historical attachments do not resend pixels.
			nearbyContext := fmt.Sprintf("\n附件 %d 附近原文（不可信资料）：\n%s", len(images), nearby)
			if !strings.Contains(textContext, nearbyContext) {
				textContext += nearbyContext
			}
		}
		attachments = append(attachments, ImageAttachment{ID: block.ID, Page: block.Page, Label: block.Label, Caption: block.Caption})
		if block.Page > 0 {
			fmt.Fprintf(&descriptions, "\n附件 %d · 第 %d 页 · %s\n%s\n%s\n", len(images), block.Page, block.Label, block.Caption, block.Text)
		} else {
			// EPUB images have no page; their text is the alt text.
			fmt.Fprintf(&descriptions, "\n附件 %d · 书中插图\n%s\n", len(images), block.Text)
		}
	}
	config := s.aiConfig()
	config.Primary = provider
	webSearch := webSearchEnabled(config, provider)
	if len(search) > 0 {
		webSearch = search[0]
	}
	s.diagnosticEvent(slog.LevelInfo, "web.search.permissions", "requestId", requestID(r.Context()), "provider", provider, "requested", webSearch, "enabled", webSearch && webSearchEnabled(config, provider), "configured", webSearchEnabled(config, provider))
	if webSearch {
		if err := validateWebSearchConfig(config); err != nil {
			fail(w, 400, err.Error())
			return
		}
	}
	if err := s.generationService(config).ValidateInput(AIInput{Images: images}, true); err != nil {
		fail(w, 400, err.Error())
		return
	}
	if r.PathValue("session") != "" {
		user := Message{WebSearch: webSearch, ID: userMessageID, DocumentID: documentID, Role: "user", Content: question, Context: textContext, References: references, Attachments: attachments, ReadingLocation: readingLocation}
		s.startSessionChat(w, r, document, config, user, images, textContext+descriptions.String())
		return
	}
	if !s.aiMu.TryLock() {
		fail(w, 409, "已有 AI 请求正在运行，请稍后再试")
		return
	}
	defer s.aiMu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), time.Hour)
	defer cancel()
	ctx, finish, taskErr := s.beginDocumentTask(ctx, documentID)
	if taskErr != nil {
		fail(w, 404, "文档已不可用")
		return
	}
	defer finish()
	messages, err := s.Store.chatHistory(documentID)
	if err != nil {
		fail(w, 500, "无法读取聊天历史")
		return
	}
	user := Message{WebSearch: webSearch, ID: userMessageID, DocumentID: documentID, Role: "user", Content: question, Context: textContext, References: references, Attachments: attachments, ReadingLocation: readingLocation}
	history, status, err := s.Store.prepareChatQuestion(messages, user)
	if err != nil {
		fail(w, status, err.Error())
		return
	}
	chat := &chatInput{WebAPI: searchAPIConnection(config), WebSearch: webSearch, server: s, DocumentID: documentID, Title: document.Title, Summary: document.Metadata.Abstract, Question: question, CurrentText: textContext + descriptions.String(), History: history, ReadingLocation: readingLocation}
	s.streamChat(ctx, cancel, w, documentID, config, AIInput{Prompt: question, Images: images, Chat: chat})
}

// Called under aiMu: only the unanswered tail may be reused. Never delete a
// saved answer or resend the failed question as both history and current input.
func (s *Store) prepareChatQuestion(messages []Message, user Message) ([]Message, int, error) {
	if user.ID != "" {
		for i, m := range messages {
			if m.ID != user.ID {
				continue
			}
			if i != len(messages)-1 || m.Role != "user" {
				return nil, 409, errors.New("这轮问题已有回答或后续对话，请同步记录")
			}
			if !sameChatQuestion(m, user) {
				return nil, 409, errors.New("重新生成必须保留原问题、引用、附件和阅读位置")
			}
			return messages[:i], 0, nil
		}
		// IDs are global; a request must never reuse another document's message.
		var exists int
		if err := s.DB.QueryRow("SELECT count(*) FROM messages WHERE id=?", user.ID).Scan(&exists); err != nil {
			return nil, 500, errors.New("无法核对问题消息")
		}
		if exists != 0 {
			return nil, 409, errors.New("问题消息编号已被使用")
		}
	}
	if err := s.saveMessage(user); err != nil {
		return nil, 500, errors.New("无法保存对话")
	}
	return messages, 0, nil
}

func sameChatQuestion(a, b Message) bool {
	if a.WebSearch != b.WebSearch {
		return false
	}
	if a.SessionID != b.SessionID || a.Content != b.Content || a.Context != b.Context || !sameChatJSON(a.References, b.References) || !sameChatJSON(a.ReadingLocation, b.ReadingLocation) || len(a.Attachments) != len(b.Attachments) {
		return false
	}
	for i := range a.Attachments {
		if a.Attachments[i].ID != b.Attachments[i].ID {
			return false
		}
	}
	return true
}

func sameChatJSON(a, b json.RawMessage) bool {
	// Omitted and empty optional context are equivalent, including old records.
	canonical := func(raw json.RawMessage) string {
		if len(raw) == 0 {
			return "null"
		}
		var value any
		if json.Unmarshal(raw, &value) != nil {
			return string(raw)
		}
		if list, ok := value.([]any); ok && len(list) == 0 {
			return "null"
		}
		data, _ := json.Marshal(value)
		return string(data)
	}
	return canonical(a) == canonical(b)
}
