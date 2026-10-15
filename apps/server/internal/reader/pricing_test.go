package reader

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPricingSnapshotInheritanceAndHistory(t *testing.T) {
	s, _ := processingFixture(t)
	var config AIConfig
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			fmt.Fprint(w, `{"data":[{"id":"same"}]}`)
			return
		}
		var changed AIConfig
		json.Unmarshal([]byte(`{"apiProviders":[{"id":"p","name":"Renamed","connection":{},"models":[],"pricing":{"currency":"USD","input":999}}]}`), &changed)
		if err := s.writeAIConfig(changed); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"model\":\"returned-alias\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"}}],\"usage\":{\"prompt_tokens\":1000,\"completion_tokens\":100,\"total_tokens\":1100,\"prompt_tokens_details\":{\"cached_tokens\":200}}}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	json.Unmarshal([]byte(fmt.Sprintf(`{"primary":"api","models":{"api":"p::same"},"apiProviders":[{"id":"p","name":"P","connection":{"url":%q},"models":["same"],"pricing":{"currency":"CNY","input":2,"output":8,"cacheRead":0.5,"cacheWrite":2},"modelOverrides":{"same":{"pricing":{"output":0}}}}]}`, upstream.URL)), &config)
	passModels(&config, map[string]bool{"p::same": true})
	g := &GenerationService{primary: "api", usageSink: s.processingUsageSink("doc", "chat", "q"), connections: map[string]generationConnection{"api": {VerifiedText: true, Adapter: s.apiAgentAdapter(config, taskChat)}}}
	if _, err := g.Generate(t.Context(), AIInput{Prompt: "price"}, false, nil); err != nil {
		t.Fatal(err)
	}
	report, err := s.Store.scopedUsageReport("doc", true)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(report)
	var payload struct {
		Calls []struct {
			Price struct {
				Currency string
				Model    string
				Output   *float64
			}
			Models []struct {
				Cost struct {
					Amount   *float64
					Status   string
					Currency string
				}
			}
		}
		Cost struct {
			Currencies []struct {
				Currency string
				Amount   float64
			}
		}
	}
	json.Unmarshal(raw, &payload)
	if len(payload.Calls) != 1 || payload.Calls[0].Price.Currency != "CNY" || payload.Calls[0].Price.Model != "same" || payload.Calls[0].Price.Output == nil || *payload.Calls[0].Price.Output != 0 {
		t.Fatalf("missing immutable effective price: %s", raw)
	}
	cost := payload.Calls[0].Models[0].Cost
	if cost.Amount == nil || math.Abs(*cost.Amount-0.0017) > 1e-10 || cost.Status != "complete" {
		t.Fatalf("wrong estimated cost: %s", raw)
	}
	if len(payload.Cost.Currencies) != 1 || payload.Cost.Currencies[0].Currency != "CNY" {
		t.Fatalf("currency aggregate: %s", raw)
	}
	reopened, err := OpenStore(s.Store.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.DB.Close()
	historical, err := reopened.scopedUsageReport("doc", true)
	if err != nil {
		t.Fatal(err)
	}
	historicalRaw, _ := json.Marshal(historical)
	if string(raw) != string(historicalRaw) {
		t.Fatal("historical estimate changed")
	}
}

func TestPricingValidation(t *testing.T) {
	for _, pricing := range []string{`{"currency":"EUR","input":1}`, `{"currency":"CNY","input":-1}`, `{"input":2}`} {
		t.Run(pricing, func(t *testing.T) {
			s := testServer(t)
			payload := fmt.Sprintf(`{"apiProviders":[{"id":"p","name":"P","connection":{},"models":[],"pricing":%s}]}`, pricing)
			w := request(t, s, "PUT", "/api/ai/config", jsonReader(json.RawMessage(payload)))
			if w.Code != 400 {
				t.Fatalf("invalid price accepted: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func priceNumber(v float64) *float64 { return &v }
func TestPricingCacheAndUnknownBoundaries(t *testing.T) {
	p := &PriceSnapshot{APIPricing: APIPricing{Currency: "CNY", Input: priceNumber(2), Output: priceNumber(8), CacheRead: priceNumber(.5), CacheWrite: priceNumber(3)}}
	full := TokenCounts{InputTokens: 1000, OutputTokens: 100, TotalTokens: 1100, CachedInputTokens: tokenCount(200), CacheWriteInputTokens: tokenCount(100), ReasoningOutputTokens: tokenCount(70)}
	for _, tc := range []struct {
		name     string
		price    *PriceSnapshot
		tokens   *TokenCounts
		complete bool
		status   string
		amount   *float64
	}{
		{"cache subsets and reasoning charged once", p, &full, true, "complete", priceNumber(.0026)},
		{"failed retains known cost", p, &full, false, "partial", priceNumber(.0026)},
		{"missing usage", p, nil, true, "unknown", nil},
		{"historical price absent", nil, &full, true, "unknown", nil},
		{"missing cache splits", p, &TokenCounts{InputTokens: 1000, OutputTokens: 100, TotalTokens: 1100}, true, "partial", priceNumber(.0008)},
		{"invalid cache subsets", p, &TokenCounts{InputTokens: 10, OutputTokens: 100, TotalTokens: 110, CachedInputTokens: tokenCount(11)}, true, "partial", priceNumber(.0008)},
		{"input price unknown", &PriceSnapshot{APIPricing: APIPricing{Currency: "USD", Output: priceNumber(8)}}, &full, true, "partial", priceNumber(.0008)},
		{"zero explicit", &PriceSnapshot{APIPricing: APIPricing{Currency: "USD", Input: priceNumber(0), Output: priceNumber(0), CacheRead: priceNumber(0), CacheWrite: priceNumber(0)}}, &full, true, "complete", priceNumber(0)},
		{"absent is not zero", &PriceSnapshot{APIPricing: APIPricing{Currency: "USD"}}, &full, true, "unknown", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := estimateCost(tc.price, tc.tokens, tc.complete)
			if got.Status != tc.status || (got.Amount == nil) != (tc.amount == nil) || got.Amount != nil && math.Abs(*got.Amount-*tc.amount) > 1e-12 {
				t.Fatalf("got %+v want %s %v", got, tc.status, tc.amount)
			}
		})
	}
}

func TestPricingCurrencyInheritanceAndSnapshotOwnership(t *testing.T) {
	p := APIProvider{Pricing: &APIPricing{Currency: "CNY", Input: priceNumber(2), Output: priceNumber(8)}, ModelOverrides: map[string]APIModelOverride{"m": {Pricing: &APIPricing{Currency: "USD", Output: priceNumber(0)}}}}
	got := effectiveAPIPrice(p, "m")
	if got.Currency != "USD" || got.Input != nil || got.Output == nil || *got.Output != 0 || got.Sources["output"] != "model" {
		t.Fatalf("mixed currencies: %+v", got)
	}
	*p.ModelOverrides["m"].Pricing.Output = 5
	if *got.Output != 0 {
		t.Fatal("price retained mutable rate pointer")
	}
	copy := clonePrice(got)
	*got.Output = 9
	got.Sources["output"] = "changed"
	if *copy.Output != 0 || copy.Sources["output"] != "model" {
		t.Fatal("snapshot retained mutable fields")
	}
	for _, rate := range []float64{-1, math.Inf(1), math.NaN()} {
		if validatePricing(&APIPricing{Currency: "CNY", Input: &rate}, false) == nil {
			t.Fatal("invalid finite price accepted")
		}
	}
}

func TestPricingAggregatesHistoricalCallsOnce(t *testing.T) {
	s, _ := processingFixture(t)
	sink := s.processingUsageSink("doc", "chat", "q")
	// A historical multi-model call is one unknown call, not two.
	if err := sink(UsageCall{ID: "historical", Status: "complete", Models: []ModelTokens{{Model: "one"}, {Model: "two"}}}); err != nil {
		t.Fatal(err)
	}
	report, err := s.Store.scopedUsageReport("doc", true)
	if err != nil {
		t.Fatal(err)
	}
	if report.Cost.UnknownCalls != 1 {
		t.Fatalf("unknown call counted per model: %+v", report.Cost)
	}
}

func TestPricingStructuredRoundsAndCompaction(t *testing.T) {
	s, a := prepareConversationFixture(t)
	requests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		var payload struct {
			Messages []toolCompletionMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
			return
		}
		first, _ := payload.Messages[0].Content.(string)
		if strings.Contains(first, "整理对话检查点") {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"model\":\"alias\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"checkpoint\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":8,\"completion_tokens\":2,\"total_tokens\":10}}\n\ndata: [DONE]\n\n")
		} else if requests == 1 {
			writeToolReply(w, "get_outline", "{}")
		} else {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"model\":\"alias\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"answer\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":8,\"completion_tokens\":2,\"total_tokens\":10}}\n\ndata: [DONE]\n\n")
		}
	}))
	defer upstream.Close()
	p := APIProvider{ID: "p", Name: "P", Pricing: &APIPricing{Currency: "USD", Input: priceNumber(2), Output: priceNumber(8), CacheRead: priceNumber(2), CacheWrite: priceNumber(2)}}
	req := completionRequest{Model: "same", ProviderID: p.ID, ProviderName: p.Name, Tools: true, Price: effectiveAPIPrice(p, "same")}
	sink := s.processingUsageSink("doc", "chat", "question")
	a.provider = "api"
	a.usageSink = sink
	_, err := streamAPIDocumentChat(t.Context(), APIConnection{URL: upstream.URL}, req, AIInput{Prompt: "outline", Chat: &chatInput{Agent: a}, UsageSink: sink}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if requests != 2 {
		t.Fatalf("expected tool round plus answer, got %d", requests)
	}
	a.contextTokens = 8192
	a.needsCompaction = true
	messages := []toolCompletionMessage{{Role: "system", Content: "rules"}, {Role: "user", Content: strings.Repeat("旧", 4096)}, {Role: "assistant", Content: "earlier answer"}, {Role: "user", Content: "current question"}}
	a.conversation = &documentConversation{Messages: messages}
	_, err = compactAPIConversation(t.Context(), APIConnection{URL: upstream.URL}, req, a, messages)
	if err != nil {
		t.Fatal(err)
	}
	if requests < 3 {
		t.Fatal("compact never requested")
	}
	report, err := s.Store.scopedUsageReport("doc", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Calls) != requests {
		t.Fatalf("double count: %d vs %d", len(report.Calls), requests)
	}
	for _, call := range report.Calls {
		if call.Price == nil || call.Price.Model != "same" || call.ProviderID != "p" || len(call.Models) != 1 || call.Models[0].Cost.Status != "complete" || math.Abs(*call.Models[0].Cost.Amount-.000032) > 1e-12 {
			t.Fatalf("missing round or compact pricing: %+v", call)
		}
	}
	if len(report.Cost.Currencies) != 1 || report.Cost.Currencies[0].Currency != "USD" || report.Cost.UnknownCalls != 0 {
		t.Fatal(report.Cost)
	}
}

func TestPricingTranslationVisionAndFailedStreams(t *testing.T) {
	for _, kind := range []string{"translation", "vision", "failed", "no-usage"} {
		t.Run(kind, func(t *testing.T) {
			s, _ := processingFixture(t)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					fmt.Fprint(w, `{"data":[{"id":"same"}]}`)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: {\"model\":\"alias\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"answer\"}}]}\n\n")
				if kind != "no-usage" {
					fmt.Fprint(w, "data: {\"model\":\"alias\",\"choices\":[],\"usage\":{\"prompt_tokens\":1000,\"completion_tokens\":100,\"total_tokens\":1100}}\n\n")
				}
				if kind != "failed" {
					fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
				}
			}))
			defer upstream.Close()
			c := AIConfig{Primary: "api", Models: map[string]string{"api": "p::same"}, VisionModels: map[string]string{"api": "p::same"}, TranslationModels: map[string]string{"api": "p::same"}, APIProviders: []APIProvider{{ID: "p", Name: "P", Connection: APIConnection{URL: upstream.URL}, Models: []string{"same"}, Pricing: &APIPricing{Currency: "CNY", Input: priceNumber(2), Output: priceNumber(8), CacheRead: priceNumber(2), CacheWrite: priceNumber(2)}}}}
			passModels(&c, map[string]bool{"p::same": true})
			var adapter Adapter = s.apiAgentAdapter(c, taskChat)
			if kind == "translation" {
				adapter = &apiTranslationSession{apiAgentAdapter: s.apiAgentAdapter(c, taskTranslation)}
			}
			// Original config pointers must not reach the adapter snapshot.
			*c.APIProviders[0].Pricing.Input = 999
			g := &GenerationService{primary: "api", usageSink: s.processingUsageSink("doc", "chat", kind), connections: map[string]generationConnection{"api": {VerifiedText: true, VerifiedVision: true, Adapter: adapter}}}
			in := AIInput{Prompt: "hello"}
			if kind == "vision" {
				in.Image = []byte{1, 2, 3}
			}
			_, err := g.Generate(t.Context(), in, false, nil)
			if (err != nil) != (kind == "failed") {
				t.Fatalf("unexpected stream outcome: %v", err)
			}
			report, err := s.Store.scopedUsageReport("doc", true)
			if err != nil {
				t.Fatal(err)
			}
			if len(report.Calls) != 1 || report.Calls[0].Price == nil || report.Calls[0].ProviderID != "p" {
				t.Fatalf("missing snapshot: %+v", report.Calls)
			}
			cost := report.Calls[0].Models[0].Cost
			status := "complete"
			if kind == "failed" {
				status = "partial"
			}
			if kind == "no-usage" {
				status = "unknown"
			}
			if cost.Status != status {
				t.Fatalf("cost status: %+v", cost)
			}
			if kind == "no-usage" {
				if cost.Amount != nil {
					t.Fatal("unknown silently zero")
				}
			} else if cost.Amount == nil || math.Abs(*cost.Amount-.0028) > 1e-12 {
				t.Fatalf("wrong captured price: %+v", cost)
			}
		})
	}
}

func TestPricingCurrencyTotalsRemainSeparate(t *testing.T) {
	s, _ := processingFixture(t)
	sink := s.processingUsageSink("doc", "chat", "q")
	for _, currency := range []string{"CNY", "USD"} {
		call := UsageCall{ID: currency, Provider: "api", ProviderID: "p", Status: "complete", Price: &PriceSnapshot{APIPricing: APIPricing{Currency: currency, Input: priceNumber(2), Output: priceNumber(8), CacheRead: priceNumber(2), CacheWrite: priceNumber(2)}}, Models: []ModelTokens{{Model: "same", Tokens: &TokenCounts{InputTokens: 1000, OutputTokens: 100, TotalTokens: 1100}}}}
		priceUsageCall(&call)
		if err := sink(call); err != nil {
			t.Fatal(err)
		}
	}
	report, err := s.Store.scopedUsageReport("doc", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Cost.Currencies) != 2 || len(report.Groups) != 1 || len(report.Groups[0].Cost.Currencies) != 2 {
		t.Fatalf("currency amounts mixed: %+v", report)
	}
	for _, cost := range report.Cost.Currencies {
		if math.Abs(cost.Amount-.0028) > 1e-12 {
			t.Fatal(cost)
		}
	}
}

func TestPricingAliasDoesNotDiscardCLIUnknownModels(t *testing.T) {
	var saved UsageCall
	_, err := trackModelUsage(UsageCall{Provider: "claude"}, func(call UsageCall) error { saved = call; return nil }, nil, func(emit func(ProviderEvent) error) (GenerateResult, error) {
		if err := emit(ProviderEvent{Metrics: []ModelTokens{{Model: "one"}}}); err != nil {
			return GenerateResult{}, err
		}
		if err := emit(ProviderEvent{Metrics: []ModelTokens{{Model: "two"}}}); err != nil {
			return GenerateResult{}, err
		}
		return GenerateResult{}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.Models) != 2 || saved.Models[0].Model != "one" || saved.Models[1].Model != "two" {
		t.Fatalf("CLI unknown model discarded as API alias: %+v", saved.Models)
	}
}
