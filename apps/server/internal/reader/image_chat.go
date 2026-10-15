package reader

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type ImageAttachment struct {
	ID      string `json:"id"`
	Page    int    `json:"page"`
	Label   string `json:"label"`
	Caption string `json:"caption,omitempty"`
}

func (s *Server) readBlockImage(documentID, blockID string) (PDFBlock, []byte, error) {
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
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeContent(w, r, blockID+".png", time.Time{}, bytes.NewReader(data))
}
func (s *Server) chatDocument(w http.ResponseWriter, r *http.Request, document Document, provider, question, textContext string, references json.RawMessage, ids []string, readingLocation json.RawMessage) {
	documentID := document.ID
	if len(ids) > 4 {
		fail(w, 400, "每次最多附加 4 张图片")
		return
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
		attachments = append(attachments, ImageAttachment{ID: block.ID, Page: block.Page, Label: block.Label, Caption: block.Caption})
		fmt.Fprintf(&descriptions, "\n附件 %d · 第 %d 页 · %s\n%s\n%s\n", len(images), block.Page, block.Label, block.Caption, block.Text)
	}
	config := s.aiConfig()
	config.Primary = provider
	if err := s.generationService(config).ValidateInput(AIInput{Images: images}, true); err != nil {
		fail(w, 400, err.Error())
		return
	}
	if !s.aiMu.TryLock() {
		fail(w, 409, "已有 AI 请求正在运行，请稍后再试")
		return
	}
	defer s.aiMu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), apiOuterTimeout(config, 10*time.Minute))
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
	chat := &chatInput{DocumentID: documentID, Title: document.Title, Summary: document.Metadata.Abstract, Question: question, CurrentText: textContext + descriptions.String(), History: messages, ReadingLocation: readingLocation}
	if err := s.Store.saveMessage(Message{DocumentID: documentID, Role: "user", Content: question, Context: textContext, References: references, Attachments: attachments, ReadingLocation: readingLocation}); err != nil {
		fail(w, 500, "无法保存对话")
		return
	}
	s.streamChat(ctx, cancel, w, documentID, config, AIInput{Prompt: question, Images: images, Chat: chat})
}
