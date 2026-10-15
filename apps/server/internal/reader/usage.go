package reader

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"sync"
	"time"
)

// Input includes cache tokens; output includes reasoning. Subsets are not added twice.
type TokenCounts struct {
	InputTokens           int64  `json:"inputTokens"`
	OutputTokens          int64  `json:"outputTokens"`
	TotalTokens           int64  `json:"totalTokens"`
	CachedInputTokens     *int64 `json:"cachedInputTokens"`
	CacheWriteInputTokens *int64 `json:"cacheWriteInputTokens"`
	ReasoningOutputTokens *int64 `json:"reasoningOutputTokens"`
}
type ModelTokens struct {
	Cost   *UsageCost   `json:"cost,omitempty"`
	Model  string       `json:"model"`
	Tokens *TokenCounts `json:"tokens"`
}

func tokenCount(n int64) *int64   { return &n }
func validOptional(n *int64) bool { return n == nil || *n >= 0 }
func validTokens(t *TokenCounts) bool {
	return t != nil && t.InputTokens >= 0 && t.OutputTokens >= 0 && t.TotalTokens >= 0 && validOptional(t.CachedInputTokens) && validOptional(t.CacheWriteInputTokens) && validOptional(t.ReasoningOutputTokens)
}
func emitMetrics(callbacks []func([]ModelTokens), metrics []ModelTokens) {
	for _, callback := range callbacks {
		if callback != nil {
			callback(metrics)
		}
	}
}

// Metadata is a cumulative snapshot, never a delta.
func mergeModelTokens(old, updates []ModelTokens) []ModelTokens {
	if len(old) == 1 && old[0].Tokens == nil && len(updates) > 0 && updates[0].Model != "" && updates[0].Tokens != nil {
		old = nil
	}
	for _, update := range updates {
		if update.Model == "" && len(old) == 1 {
			update.Model = old[0].Model
		}
		if update.Model != "" && len(old) == 1 && old[0].Model == "" {
			old[0].Model = update.Model
		}
		found := false
		for i := range old {
			if old[i].Model == update.Model {
				if validTokens(update.Tokens) {
					t := *update.Tokens
					old[i].Tokens = &t
				}
				found = true
				break
			}
		}
		if !found {
			if !validTokens(update.Tokens) {
				update.Tokens = nil
			}
			old = append(old, update)
		}
	}
	return old
}

type completionUsage struct {
	Input        *int64 `json:"prompt_tokens"`
	Output       *int64 `json:"completion_tokens"`
	Total        *int64 `json:"total_tokens"`
	InputDetails struct {
		Cached *int64 `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	OutputDetails struct {
		Reasoning *int64 `json:"reasoning_tokens"`
	} `json:"completion_tokens_details"`
}

func completionTokens(u *completionUsage) *TokenCounts {
	if u == nil || u.Input == nil || u.Output == nil || u.Total == nil {
		return nil
	}
	t := &TokenCounts{InputTokens: *u.Input, OutputTokens: *u.Output, TotalTokens: *u.Total, CachedInputTokens: u.InputDetails.Cached, ReasoningOutputTokens: u.OutputDetails.Reasoning}
	if !validTokens(t) {
		return nil
	}
	return t
}
func reportClaudeMetrics(raw []byte, callbacks []func([]ModelTokens)) {
	var event struct {
		Type       string `json:"type"`
		Subtype    string `json:"subtype"`
		Model      string `json:"model"`
		ModelUsage map[string]struct {
			Input      *int64 `json:"inputTokens"`
			Output     *int64 `json:"outputTokens"`
			CacheRead  *int64 `json:"cacheReadInputTokens"`
			CacheWrite *int64 `json:"cacheCreationInputTokens"`
		} `json:"modelUsage"`
	}
	if json.Unmarshal(raw, &event) != nil {
		return
	}
	if event.Type == "system" && event.Subtype == "init" {
		emitMetrics(callbacks, []ModelTokens{{Model: event.Model}})
	}
	if event.Type != "result" || len(event.ModelUsage) == 0 {
		return
	}
	names := []string{}
	for name := range event.ModelUsage {
		names = append(names, name)
	}
	sort.Strings(names)
	metrics := []ModelTokens{}
	for _, name := range names {
		u := event.ModelUsage[name]
		if u.Input == nil || u.Output == nil || !validOptional(u.CacheRead) || !validOptional(u.CacheWrite) {
			metrics = append(metrics, ModelTokens{Model: name})
			continue
		}
		input := *u.Input
		if u.CacheRead != nil {
			input += *u.CacheRead
		}
		if u.CacheWrite != nil {
			input += *u.CacheWrite
		}
		t := &TokenCounts{InputTokens: input, OutputTokens: *u.Output, TotalTokens: input + *u.Output, CachedInputTokens: u.CacheRead, CacheWriteInputTokens: u.CacheWrite}
		if validTokens(t) {
			metrics = append(metrics, ModelTokens{Model: name, Tokens: t})
		}
	}
	emitMetrics(callbacks, metrics)
}

type UsageCall struct {
	Price        *PriceSnapshot `json:"price,omitempty"`
	ProviderID   string         `json:"providerId,omitempty"`
	ProviderName string         `json:"providerName,omitempty"`
	ID           string         `json:"id"`
	Stage        string         `json:"stage"`
	Target       string         `json:"target"`
	Provider     string         `json:"provider"`
	StartedAt    string         `json:"startedAt"`
	FinishedAt   string         `json:"finishedAt,omitempty"`
	Status       string         `json:"status"`
	Models       []ModelTokens  `json:"models"`
}
type UsageGroup struct {
	Cost         CostSummary `json:"cost"`
	ProviderID   string      `json:"providerId,omitempty"`
	ProviderName string      `json:"providerName,omitempty"`
	Stage        string      `json:"stage"`
	Provider     string      `json:"provider"`
	Model        string      `json:"model"`
	Calls        int         `json:"calls"`
	UnknownCalls int         `json:"unknownCalls"`
	Tokens       TokenCounts `json:"tokens"`
}
type StageUsage struct {
	Stage      string `json:"stage"`
	DurationMs int64  `json:"durationMs"`
}
type UsageReport struct {
	Cost            CostSummary  `json:"cost"`
	HistoryComplete bool         `json:"historyComplete"`
	Total           TokenCounts  `json:"total"`
	Calls           []UsageCall  `json:"calls"`
	Groups          []UsageGroup `json:"groups"`
	Stages          []StageUsage `json:"stages"`
	UnknownCalls    int          `json:"unknownCalls"`
	FailedCalls     int          `json:"failedCalls"`
	PartialCalls    int          `json:"partialCalls"`
	ElapsedMs       int64        `json:"elapsedMs"`
}

func (s *Server) processingUsageSink(documentID, stage, target string) func(UsageCall) error {
	return func(call UsageCall) error {
		call.Stage = stage
		call.Target = target
		body, err := json.Marshal(call)
		if err != nil {
			return err
		}
		_, err = s.Store.DB.Exec("INSERT INTO processing_usage(id,document_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", call.ID, documentID, body)
		return err
	}
}
func (s *Server) startUsageStage(documentID, stage string) (func() error, error) {
	key := id()
	_, err := s.Store.DB.Exec("INSERT INTO processing_intervals(id,document_id,stage,started_at) VALUES(?,?,?,?)", key, documentID, stage, now())
	if err != nil {
		return nil, err
	}
	var once sync.Once
	var finishErr error
	return func() error {
		once.Do(func() {
			_, finishErr = s.Store.DB.Exec("UPDATE processing_intervals SET finished_at=? WHERE id=?", now(), key)
		})
		return finishErr
	}, nil
}
func elapsedMilliseconds(start, end string) int64 {
	a, err := time.Parse(time.RFC3339Nano, start)
	if err != nil {
		return 0
	}
	b, err := time.Parse(time.RFC3339Nano, end)
	if err != nil {
		return 0
	}
	if b.Before(a) {
		return 0
	}
	return b.Sub(a).Milliseconds()
}
func addOptional(a **int64, b *int64) {
	if b == nil {
		return
	}
	if *a == nil {
		*a = tokenCount(*b)
	} else {
		**a += *b
	}
}
func addTokens(a *TokenCounts, b TokenCounts) {
	a.InputTokens += b.InputTokens
	a.OutputTokens += b.OutputTokens
	a.TotalTokens += b.TotalTokens
	addOptional(&a.CachedInputTokens, b.CachedInputTokens)
	addOptional(&a.CacheWriteInputTokens, b.CacheWriteInputTokens)
	addOptional(&a.ReasoningOutputTokens, b.ReasoningOutputTokens)
}
func (s *Store) usageReport(documentID string) (UsageReport, error) {
	return s.scopedUsageReport(documentID, false)
}
func (s *Store) scopedUsageReport(documentID string, chat bool) (UsageReport, error) {
	report := UsageReport{Cost: CostSummary{Currencies: []CurrencyCost{}}, Calls: []UsageCall{}, Groups: []UsageGroup{}, Stages: []StageUsage{{Stage: "learning"}, {Stage: "settling"}, {Stage: "translating"}}}
	if chat {
		report.Stages = []StageUsage{{Stage: "chat"}}
		report.HistoryComplete = true
		err := s.DB.QueryRow("SELECT history_complete FROM chat_usage_coverage WHERE document_id=?", documentID).Scan(&report.HistoryComplete)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return report, err
		}
	} else {
		p, err := s.processing(documentID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return report, err
		}
		report.HistoryComplete = p.UsageTracked || errors.Is(err, sql.ErrNoRows)
		end := p.CompletedAt
		if end == "" {
			end = now()
			if p.Status != "running" && p.Status != "queued" {
				end = p.UpdatedAt
			}
		}
		report.ElapsedMs = elapsedMilliseconds(p.StartedAt, end)
	}
	rows, err := s.DB.Query("SELECT body FROM processing_usage WHERE document_id=? ORDER BY rowid", documentID)
	if err != nil {
		return report, err
	}
	for rows.Next() {
		var body string
		var call UsageCall
		if err = rows.Scan(&body); err == nil {
			err = json.Unmarshal([]byte(body), &call)
		}
		if err != nil {
			rows.Close()
			return report, err
		}
		if (call.Stage == "chat") != chat {
			continue
		}
		if chat {
			finish := call.FinishedAt
			if finish == "" && call.Status == "running" {
				finish = now()
			}
			report.ElapsedMs += elapsedMilliseconds(call.StartedAt, finish)
		}
		report.Calls = append(report.Calls, call)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return report, err
	}
	for _, call := range report.Calls {
		callCost := CostSummary{}
		unknown := false
		if call.Status != "complete" && call.Status != "running" {
			report.FailedCalls++
		}
		hasUsage := false
		for _, model := range call.Models {
			i := 0
			for i < len(report.Groups) {
				g := report.Groups[i]
				if g.Stage == call.Stage && g.Provider == call.Provider && g.ProviderID == call.ProviderID && g.Model == model.Model {
					break
				}
				i++
			}
			if i == len(report.Groups) {
				report.Groups = append(report.Groups, UsageGroup{Stage: call.Stage, Provider: call.Provider, ProviderID: call.ProviderID, ProviderName: call.ProviderName, Model: model.Model})
			}
			report.Groups[i].Calls++
			addCost(&report.Groups[i].Cost, model.Cost)
			addCost(&callCost, model.Cost)
			if model.Tokens == nil {
				unknown = true
				report.Groups[i].UnknownCalls++
			} else {
				hasUsage = true
				addTokens(&report.Groups[i].Tokens, *model.Tokens)
				addTokens(&report.Total, *model.Tokens)
			}
		}
		addCallCost(&report.Cost, callCost, len(call.Models))
		if unknown || len(call.Models) == 0 {
			report.UnknownCalls++
		}
		if hasUsage && call.Status != "complete" {
			report.PartialCalls++
		}
	}
	if chat {
		report.Stages[0].DurationMs = report.ElapsedMs
		return report, nil
	}
	rows, err = s.DB.Query("SELECT stage,started_at,COALESCE(finished_at,'') FROM processing_intervals WHERE document_id=?", documentID)
	if err != nil {
		return report, err
	}
	defer rows.Close()
	for rows.Next() {
		var stage, start, finish string
		if err = rows.Scan(&stage, &start, &finish); err != nil {
			return report, err
		}
		if finish == "" {
			finish = now()
		}
		for i := range report.Stages {
			if report.Stages[i].Stage == stage {
				report.Stages[i].DurationMs += elapsedMilliseconds(start, finish)
			}
		}
	}
	return report, rows.Err()
}
func (s *Server) processingUsage(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("id")
	if _, err := s.Store.Document(key); err != nil {
		fail(w, 404, "文档不存在")
		return
	}
	report, err := s.Store.usageReport(key)
	if err != nil {
		fail(w, 500, "无法读取处理统计")
		return
	}
	respond(w, 200, report)
}
func (s *Server) chatUsage(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("id")
	if _, err := s.Store.Document(key); err != nil {
		fail(w, 404, "文档不存在")
		return
	}
	report, err := s.Store.scopedUsageReport(key, true)
	if err != nil {
		fail(w, 500, "无法读取聊天统计")
		return
	}
	respond(w, 200, report)
}
func (s *Store) recoverUsage() error {
	rows, err := s.DB.Query("SELECT id,body FROM processing_usage")
	if err != nil {
		return err
	}
	var calls []UsageCall
	for rows.Next() {
		var key, body string
		var call UsageCall
		if err = rows.Scan(&key, &body); err == nil {
			err = json.Unmarshal([]byte(body), &call)
		}
		if err != nil {
			rows.Close()
			return err
		}
		if call.Status == "running" {
			call.ID = key
			calls = append(calls, call)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, call := range calls {
		call.Status = "interrupted"
		body, _ := json.Marshal(call)
		if _, err = s.DB.Exec("UPDATE processing_usage SET body=? WHERE id=?", body, call.ID); err != nil {
			return err
		}
	}
	// Crash end time is unknown; exclude downtime from stage duration.
	_, err = s.DB.Exec("UPDATE processing_intervals SET finished_at=started_at WHERE finished_at IS NULL")
	return err
}

func codexTokens(raw json.RawMessage) *TokenCounts {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return nil
	}
	for _, key := range []string{"inputTokens", "outputTokens", "totalTokens"} {
		value, ok := fields[key]
		if !ok || string(value) == "null" {
			return nil
		}
	}
	var result TokenCounts
	if json.Unmarshal(raw, &result) != nil || !validTokens(&result) {
		return nil
	}
	return &result
}

// One lifecycle for a model call, whether a normal generation or an Agent round.
func trackModelUsage(call UsageCall, sink func(UsageCall) error, emit func(ProviderEvent) error, run func(func(ProviderEvent) error) (GenerateResult, error)) (GenerateResult, error) {
	if call.ID == "" {
		call.ID = id()
	}
	call.StartedAt = now()
	call.Status = "running"
	call.Price = clonePrice(call.Price)
	call.Models = []ModelTokens{{Model: priceModel(call.Price)}}
	save := func() error {
		priceUsageCall(&call)
		if sink != nil {
			return sink(call)
		}
		return nil
	}
	if err := save(); err != nil {
		return GenerateResult{}, generationError(ErrorSave, "无法保存调用统计")
	}
	var mu sync.Mutex
	result, err := run(func(event ProviderEvent) error {
		if len(event.Metrics) > 0 || event.ProviderID != "" {
			mu.Lock()
			if call.Price == nil && event.Price != nil {
				call.Price = clonePrice(event.Price)
			}
			if event.ProviderID != "" {
				call.ProviderID = event.ProviderID
				call.ProviderName = event.ProviderName
			}
			// One API request may report an alias before its later usage frame.
			// Only replace that request placeholder; CLI multi-model metadata stays intact.
			if call.ProviderID != "" && len(call.Models) == 1 && call.Models[0].Tokens == nil && len(event.Metrics) == 1 && event.Metrics[0].Model != "" {
				call.Models = nil
			}
			call.Models = mergeModelTokens(call.Models, event.Metrics)
			saveErr := save()
			mu.Unlock()
			if saveErr != nil {
				return generationError(ErrorSave, "无法保存调用统计")
			}
		}
		if emit != nil {
			return emit(event)
		}
		return nil
	})
	mu.Lock()
	defer mu.Unlock()
	call.FinishedAt = now()
	call.Status = "complete"
	if err != nil {
		call.Status = "failed"
		if errors.Is(err, context.Canceled) {
			call.Status = "cancelled"
		}
	}
	if saveErr := save(); saveErr != nil {
		return GenerateResult{}, generationError(ErrorSave, "无法保存调用统计")
	}
	return result, err
}
