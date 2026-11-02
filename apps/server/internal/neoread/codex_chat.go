package neoread

import (
	"context"
	"neoread.local/server/internal/runtimeenv"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Keep at most one text chat connection. SQLite remains the authority for
// committed history; failed, canceled or unsaved turns must never be reused.
type codexChatCache struct {
	mu     sync.Mutex
	entry  *codexChatEntry
	closed bool
}
type codexChatEntry struct {
	session                      *codexSession
	work, key, document, savedID string
	seen                         map[string]bool
	pending                      *chatInput
	turns, sourceBytes           int
	timer                        *time.Timer
}

func (c *codexChatCache) discardLocked() {
	if e := c.entry; e != nil {
		c.entry = nil
		if e.timer != nil {
			e.timer.Stop()
		}
		e.session.close()
		_ = os.RemoveAll(e.work)
	}
}
func (c *codexChatCache) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	c.discardLocked()
}
func (c *codexChatCache) acquire(ctx context.Context, root, model string, in AIInput) (*codexSession, AIInput, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, in, generationError(ErrorCanceled, "服务已关闭")
	}
	chat := in.Chat
	executable, _ := runtimeenv.LookPath(ctx, "codex")
	key := executable + "\x00" + model + "\x00" + in.Effort + "\x00" + chat.Title
	if chat.WebSearch {
		key += "\x00web"
	}
	e := c.entry
	// A reused session keeps every source it has seen, so count this turn's new
	// sources too; a fresh session receives only the budgeted list.
	unseen := 0
	if e != nil {
		for _, source := range chat.Sources {
			if !e.seen[source.ID] {
				unseen += len(source.Text)
			}
		}
	}
	if e != nil && (e.key != key || e.document != chat.DocumentID || e.savedID != chat.PriorID || e.pending != nil || e.turns >= 64 || e.sourceBytes+unseen > chatSourceBytes) {
		c.discardLocked()
		e = nil
	}
	if e == nil {
		work, err := os.MkdirTemp(filepath.Join(root, "ai-work"), "chat-")
		if err != nil {
			return nil, in, err
		}
		session, err := isolatedDocumentCodex(ctx, work, model, "", "", chat.WebSearch)
		if err != nil {
			_ = os.RemoveAll(work)
			return nil, in, err
		}
		session.finalMessagesOnly = true
		e = &codexChatEntry{session: session, work: work, key: key, document: chat.DocumentID, seen: map[string]bool{}}
		c.entry = e
	} else {
		if e.timer != nil {
			e.timer.Stop()
		}
		in.Prompt = chat.incremental(e.seen)
	}
	e.pending = chat
	return e.session, in, nil
}
func (c *codexChatCache) finish(chat *chatInput, savedID string, successful bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.entry
	if chat == nil || e == nil || e.pending != chat {
		return
	}
	if !successful || !e.session.usageComplete {
		c.discardLocked()
		return
	}
	e.savedID = savedID
	e.pending = nil
	e.turns++
	for _, source := range chat.Sources {
		if !e.seen[source.ID] {
			e.sourceBytes += len(source.Text)
			e.seen[source.ID] = true
		}
	}
	committedTurns := e.turns
	e.timer = time.AfterFunc(10*time.Minute, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.entry == e && e.pending == nil && e.turns == committedTurns {
			c.discardLocked()
		}
	})
}
func (c *codexChatCache) reset() { c.mu.Lock(); defer c.mu.Unlock(); c.discardLocked() }

func codexUsageDelta(total, prior *TokenCounts) *TokenCounts {
	if total == nil {
		return nil
	}
	if prior == nil {
		return total
	}
	d := *total
	d.InputTokens -= prior.InputTokens
	d.OutputTokens -= prior.OutputTokens
	d.TotalTokens -= prior.TotalTokens
	sub := func(a, b *int64) *int64 {
		if a == nil || b == nil {
			return nil
		}
		return tokenCount(*a - *b)
	}
	d.CachedInputTokens = sub(total.CachedInputTokens, prior.CachedInputTokens)
	d.CacheWriteInputTokens = sub(total.CacheWriteInputTokens, prior.CacheWriteInputTokens)
	d.ReasoningOutputTokens = sub(total.ReasoningOutputTokens, prior.ReasoningOutputTokens)
	if !validTokens(&d) {
		return nil
	}
	return &d
}

type codexChatAdapter struct {
	configuredCLIAdapter
	cache *codexChatCache
}

func (a codexChatAdapter) Stream(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
	if req.Input.Chat != nil && req.Input.Chat.Agent != nil && len(req.Input.images()) == 0 {
		a.cache.reset()
		return a.streamWith(ctx, req, emit, func(cli cliAdapter, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
			return streamCodexDocumentChat(ctx, cli.root, cli.model, req.Input, emit)
		})
	}
	if req.Input.Chat == nil || len(req.Input.images()) > 0 {
		return a.configuredCLIAdapter.Stream(ctx, req, emit)
	}
	return a.streamWith(ctx, req, emit, func(cli cliAdapter, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
		session, in, err := a.cache.acquire(ctx, cli.root, cli.model, req.Input)
		if err != nil {
			return GenerateResult{}, err
		}
		child, cancel := context.WithCancel(ctx)
		defer cancel()
		var emitErr error
		send := func(e ProviderEvent) {
			if emitErr == nil && emit != nil {
				emitErr = emit(e)
				if emitErr != nil {
					cancel()
				}
			}
		}
		text, err := session.generate(child, in, func(part string) { send(ProviderEvent{Text: part}) }, func(metrics []ModelTokens) { send(ProviderEvent{Metrics: metrics}) })
		if emitErr != nil {
			err = emitErr
		}
		if err != nil {
			a.cache.finish(in.Chat, "", false)
			return GenerateResult{}, err
		}
		return GenerateResult{Text: text, FinishReason: "stop"}, nil
	})
}
func (s *Server) Close() {
	s.documentMu.Lock()
	s.documentClosed = true
	var tasks []*documentTask
	for _, group := range s.documentTasks {
		for task := range group {
			task.cancel()
			tasks = append(tasks, task)
		}
	}
	s.documentMu.Unlock()
	s.codexChat.close()
	s.documentCodex.close()
	for _, task := range tasks {
		<-task.done
	}
}

func (c *codexChatCache) deleteDocument(document string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entry != nil && c.entry.document == document {
		c.discardLocked()
	}
}
