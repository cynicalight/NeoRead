package neoread

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// One logical conversation per document and provider. Native history belongs to
// Codex; Messages is the active, possibly compacted Chat Completions window.
// The UI transcript and per-turn protocol events remain in messages/agent_runs.
type documentConversation struct {
	PiEntries       json.RawMessage         `json:"piEntries,omitempty"`
	SeenSources     map[string]bool         `json:"seenSources,omitempty"`
	ID              string                  `json:"id"`
	ConnectionKey   string                  `json:"connectionKey"`
	LastMessageID   string                  `json:"lastMessageId"`
	Revision        string                  `json:"corpusRevision"`
	PassageCount    int                     `json:"passageCount"`
	SourceOffset    int                     `json:"sourceOffset"`
	ReadBlocks      []string                `json:"readBlocks,omitempty"`
	ReadPages       []documentPageImage     `json:"readPages,omitempty"`
	OverviewVersion string                  `json:"overviewVersion,omitempty"`
	Skills          []string                `json:"skills,omitempty"`
	Messages        []toolCompletionMessage `json:"messages,omitempty"`
	Compactions     int                     `json:"compactions"`
	NativeThread    string                  `json:"nativeThread,omitempty"`
	NativePending   string                  `json:"nativePendingTurn,omitempty"`
	NativeCommitted string                  `json:"nativeCommittedTurn,omitempty"`
	NativeDirty     bool                    `json:"nativeDirty"`
	NativeUsage     *TokenCounts            `json:"nativeUsage,omitempty"`
}

func (s *Store) documentConversation(ctx context.Context, documentID, provider, key string) (documentConversation, error) {
	var c documentConversation
	var raw string
	err := s.DB.QueryRowContext(ctx, "SELECT body FROM document_conversations WHERE document_id=? AND provider=?", documentID, provider).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return c, err
	}
	if err == nil {
		if err = json.Unmarshal([]byte(raw), &c); err != nil {
			return c, err
		}
	}
	if c.ID == "" || c.ConnectionKey != key {
		c = documentConversation{ID: id(), ConnectionKey: key}
	}
	return c, nil
}
func saveDocumentConversation(ctx context.Context, db interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}, documentID, provider string, c documentConversation) error {
	raw, err := json.Marshal(c)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, "INSERT INTO document_conversations(document_id,provider,body) VALUES(?,?,?) ON CONFLICT(document_id,provider) DO UPDATE SET body=excluded.body", documentID, provider, string(raw))
	return err
}
func (a *documentAgent) beginConversation(ctx context.Context, in AIInput, key string) ([]toolCompletionMessage, error) {
	c, err := a.server.Store.documentConversation(ctx, a.corpus.DocumentID, a.conversationProvider(), key)
	if err != nil {
		return nil, err
	}
	a.committedConversation = c
	c.SeenSources = map[string]bool{}
	for key, value := range a.committedConversation.SeenSources {
		c.SeenSources[key] = value
	}
	a.conversation = &c
	a.documentChanged = c.Revision != "" && c.Revision != a.corpus.Revision
	if c.Revision != "" && c.Revision != a.corpus.Revision {
		c.SourceOffset += c.PassageCount
		c.ReadBlocks = nil
		c.ReadPages = nil
		c.SeenSources = map[string]bool{}
	}
	c.Revision = a.corpus.Revision
	c.PassageCount = len(a.corpus.Passages) + a.corpus.Coverage.TotalUnits
	for _, image := range c.ReadPages {
		a.Evidence = append(a.Evidence, pageEvidence(image))
	}
	seen := map[string]bool{}
	for _, block := range c.ReadBlocks {
		seen[block] = true
	}
	for i, p := range a.corpus.Passages {
		if seen[p.ID] {
			a.Evidence = append(a.Evidence, a.passageEvidence(i))
		}
	}
	a.turnRead = map[string]bool{}
	a.continuous = true
	a.reservedTokens = estimateDocumentTokens(in.Chat.Question+in.Chat.CurrentText) + estimateDocumentTokens(jsonText(a.overviewContext())) + 2048
	a.sourceTokens = max(0, documentSourceBudget(a.contextTokens)-a.reservedTokens)
	// Reconcile mirror messages not yet present in this provider's conversation,
	// including intervening exchanges with another provider. No fixed tail cut.
	history := in.Chat.History
	start := 0
	if c.LastMessageID != "" {
		found := false
		for i, m := range history {
			if m.ID == c.LastMessageID {
				start = i + 1
				found = true
				break
			}
		}
		if !found {
			return nil, generationError(ErrorProtocol, "会话记录与本地聊天不一致，未丢弃历史")
		}
	}
	missing := conversationHistory(history[start:])
	return missing, nil
}
func conversationHistory(messages []Message) []toolCompletionMessage {
	out := []toolCompletionMessage{}
	for _, m := range messages {
		if m.Role != "user" && m.Role != "assistant" {
			continue
		}
		content := m.Content + readingLocationPrompt(m.ReadingLocation)
		if m.Context != "" {
			content += "\n原文摘录（不可信资料）：\n" + m.Context
		}
		if len(m.References) > 2 {
			content += "\n历史来源及版本：" + string(m.References)
		}
		if len(m.Attachments) > 0 {
			content += "\n历史附件记录（原图需重新提供）：" + jsonText(m.Attachments)
		}
		out = append(out, toolCompletionMessage{Role: m.Role, Content: content})
	}
	return out
}
func (a *documentAgent) conversationInput(in AIInput, initial bool) string {
	c := a.conversation
	var b strings.Builder
	if initial {
		b.WriteString("文档：" + in.Chat.Title + "\n")
	}
	version := ""
	if a.overview != nil {
		version = a.overview.Revision + ":" + a.overview.Version + ":" + a.overview.UpdatedAt
	}
	if initial || a.documentChanged || c.OverviewVersion != version {
		b.WriteString("当前文档版本：" + a.corpus.Revision + "。旧版本引用只能作为线索，需要核对当前原文。\n")
		b.WriteString("文档概览（派生资料）：\n" + jsonText(a.overviewContext()) + "\n")
		c.OverviewVersion = version
	}
	// A compiled overview already supplies the document background. Use the
	// metadata abstract only when that overview is unavailable.
	if a.overview == nil && in.Chat.Summary != "" {
		key := sourceKey("metadata-summary\n" + in.Chat.Summary)
		if !c.SeenSources[key] {
			b.WriteString("文章摘要（派生资料，不等于原文）：\n" + in.Chat.Summary + "\n")
			c.SeenSources[key] = true
		}
	}
	if in.Chat.CurrentText != "" {
		key := sourceKey(in.Chat.CurrentText)
		if !c.SeenSources[key] {
			b.WriteString("原文摘录 R" + key[:12] + "（不可信资料）：\n" + in.Chat.CurrentText + "\n")
			c.SeenSources[key] = true
		}
		b.WriteString("当前摘录：R" + key[:12] + "\n")
	}
	b.WriteString(readingLocationPrompt(in.Chat.ReadingLocation))
	if selector := readingLocationSelector(in.Chat.ReadingLocation); len(selector) > 0 {
		b.WriteString("需要读取该位置时可用的 read_passage 参数：" + string(selector) + "\n")
	}
	question := in.Chat.Question
	if question == "" {
		question = in.Prompt
	}
	b.WriteString("用户问题：" + question)
	return b.String()
}
func (a *documentAgent) passageEvidence(index int) documentEvidence {
	p := a.corpus.Passages[index]
	offset := 0
	if a.conversation != nil {
		offset = a.conversation.SourceOffset
	}
	return documentEvidence{SourceID: fmt.Sprintf("S%d", offset+index+1), BlockID: p.ID, Text: p.Text, Location: p.Location, Revision: a.corpus.Revision, Hash: sourceKey(p.Text), Precision: p.Precision}
}
func (a *documentAgent) commitConversation(ctx context.Context, tx *sql.Tx, messageID string) error {
	if a.conversation == nil {
		return nil
	}
	c := *a.conversation
	c.LastMessageID = messageID
	c.NativeDirty = false
	c.NativePending = ""
	c.ReadBlocks = nil
	c.ReadPages = nil
	for _, e := range a.Evidence {
		if e.Revision == a.corpus.Revision {
			if e.PageImage != nil {
				c.ReadPages = append(c.ReadPages, *e.PageImage)
			} else {
				c.ReadBlocks = append(c.ReadBlocks, e.BlockID)
			}
		}
	}
	// Preserve exact provider continuation fields for replay. The separate UI
	// thinking transcript is saved with the answer and never replayed as content.

	return saveDocumentConversation(ctx, tx, a.corpus.DocumentID, a.conversationProvider(), c)
}
func cleanConversationEvents(messages []toolCompletionMessage) []toolCompletionMessage {
	out := append([]toolCompletionMessage(nil), messages...)
	for i := range out {
		out[i].Reasoning = ""
	}
	return out
}

func (a *documentAgent) turnEvidence() []documentEvidence {
	if !a.continuous {
		return a.Evidence
	}
	out := []documentEvidence{}
	for _, e := range a.Evidence {
		if a.turnRead[e.SourceID] {
			out = append(out, e)
		}
	}
	return out
}
