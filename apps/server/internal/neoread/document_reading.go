package neoread

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
)

// A tool-local failure can be reported to the model. A cancelled or invalidated
// document attempt must still end so that stale evidence is never saved.
func (a *documentAgent) toolFailure(ctx context.Context, err error) (json.RawMessage, error) {
	if err == nil {
		return nil, nil
	}
	a.mu.Lock()
	fatal := a.fatal
	a.mu.Unlock()
	if ctx.Err() != nil || a.ctx.Err() != nil || fatal != nil {
		return nil, err
	}
	slog.WarnContext(ctx, "document.tool.failed", "requestId", requestID(ctx), "errorCode", errorKind(err))
	return json.RawMessage(jsonText(map[string]any{"error": "tool_failed", "kind": errorKind(err), "message": "This tool failed. Consider another approach or answer using available evidence, and disclose missing information."})), nil
}

// Suggested thresholds for model feedback; they do not disable tools.
const documentToolCalls = 128
const documentReadingRounds = 64

// Transport ceiling, independent of the estimated token allowance.
const documentEvidenceBytes = 2 << 20

var errDocumentReadingBudget = generationError(ErrorLimit, "本轮检索已收束，请基于已有资料回答")
var errDocumentToolContext = generationError(ErrorLimit, "API 工具上下文超过限制")
var errDocumentAttemptEnded = generationError(ErrorCanceled, "文档工具尝试已结束")

func (a *documentAgent) stopReading(reason string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.readingStop == "" {
		a.readingStop = reason
	}
}

func (a *documentAgent) readingStopped() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.readingStop != ""
}

// Callers hold a.mu. Feedback is included before item sizing and refreshed
// after reads so the model can decide when to finish.
func (a *documentAgent) readingBudget() any {
	remaining := max(0, a.sourceTokenLimit()-a.evidenceTokens)
	if a.continuous {
		remaining = max(0, a.sourceTokenLimit())
	}
	budget := map[string]any{
		"recommendedRemainingCalls": max(0, documentToolCalls-a.calls),
		"remainingEvidenceBytes":    max(0, documentEvidenceBytes-a.bytes),
		"estimatedRemainingTokens":  remaining,
		"contextSource":             a.contextSource,
		"runtimeUsedTokens":         a.runtimeUsedTokens,
		"contextWindowTokens":       a.contextTokens,
		"shouldFinish":              a.repeatedCalls >= 2 || a.calls >= documentToolCalls-2 || (!a.continuous && a.bytes >= documentEvidenceBytes-2400) || remaining < 1024 || a.readingRounds >= documentReadingRounds-2,
	}
	if a.readingRounds > 0 {
		budget["recommendedRemainingModelRounds"] = max(0, documentReadingRounds-a.readingRounds)
	}
	return budget
}

// The disclosure is application-owned and emitted only after the final model
// completes. It travels through the same stream and saved answer, so it cannot
// be lost when a model overlooks the coverage instruction.
func (a *documentAgent) finishDocumentAnswer(ctx context.Context, result GenerateResult, emit func(ProviderEvent) error) (GenerateResult, error) {
	if err := a.check(ctx); err != nil {
		return GenerateResult{}, err
	}
	a.mu.Lock()
	reason, read, total := a.readingStop, len(a.Evidence), len(a.corpus.Passages)
	if a.continuous {
		read = len(a.turnRead)
	}
	viewed := 0
	for _, ev := range a.Evidence {
		if ev.PageImage != nil && (!a.continuous || a.turnRead[ev.SourceID]) {
			read--
			viewed++
		}
	}
	partial := a.corpus.Coverage.Status != "ready"
	overviewOnly := len(a.Evidence) == 0 && a.overview != nil
	providedSources := a.providedSources
	a.mu.Unlock()
	if reason == "" && !overviewOnly && !partial {
		return result, nil
	}
	notice := fmt.Sprintf("\n\n阅读范围：本次依据 %d 段已读原文作答，可检索原文共 %d 段。", read, total)
	if reason != "" {
		notice += "本轮因" + reason + "结束阅读。"
	}
	if overviewOnly {
		notice = "\n\n依据已保存的文档概要作答，本轮未逐段核对原文。"
		if providedSources {
			notice = "\n\n本轮提供了文档概要和原文摘录，未通过工具补读原文。"
		}
		if reason != "" {
			notice += "本轮因" + reason + "结束阅读。"
		}
	} else if read < total {
		notice += "尚未覆盖全部可检索原文。"
	}
	if partial {
		notice += "文档还存在无法检索的原文范围。"
	}
	if viewed > 0 {
		notice += fmt.Sprintf("本轮另查看了 %d 页图像。", viewed)
	}
	if emit != nil {
		if err := emit(ProviderEvent{Text: notice}); err != nil {
			return GenerateResult{}, err
		}
	}
	result.Text += notice
	return result, nil
}

func (a *documentAgent) prepareReading(ctx context.Context, in AIInput) error {
	overview, err := a.server.currentOverview(ctx, a.corpus)
	if err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.overview = overview
	a.providedSources = in.Chat != nil && in.Chat.CurrentText != ""
	a.contextOverride = a.server.documentContextOverride()
	a.contextTokens, a.contextSource = resolveDocumentContext(0, a.contextOverride, "")
	a.reservedTokens = estimateDocumentTokens(in.Prompt) + estimateDocumentTokens(jsonText(a.overviewContext())) + 2048
	a.sourceTokens = max(0, documentSourceBudget(a.contextTokens)-a.reservedTokens)
	a.prepared = true
	return nil
}
func (a *documentAgent) sourceTokenLimit() int {
	if a.prepared {
		return a.sourceTokens
	}
	return documentSourceBudget(defaultDocumentContextTokens) - 2048
}
func (a *documentAgent) inputTokenLimit() int {
	if a.contextTokens > 0 {
		return documentSourceBudget(a.contextTokens)
	}
	return documentSourceBudget(defaultDocumentContextTokens)
}
func (a *documentAgent) overviewContext() any {
	if a.overview == nil {
		return nil
	}
	return map[string]any{"kind": "generated_overview", "corpusRevision": a.overview.Revision, "content": a.overview.Content, "coverage": a.overview.Coverage, "compiledPassages": a.overview.CompiledPassages, "totalPassages": a.overview.TotalPassages}
}
func (a *documentAgent) overviewCoverage() any {
	if a.overview == nil {
		return nil
	}
	return map[string]any{"status": a.overview.Status, "compiledPassages": a.overview.CompiledPassages, "totalPassages": a.overview.TotalPassages, "sourceCoverage": a.overview.Coverage.Status}
}

func (a *documentAgent) updateContextWindow(window, used int, source string) {
	if validContextWindow(window) == 0 {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.contextTokens, a.contextSource = resolveDocumentContext(window, a.contextOverride, source)
	a.sourceTokens = max(0, documentSourceBudget(a.contextTokens)-a.reservedTokens)
	a.runtimeUsedTokens = max(0, used)
}
