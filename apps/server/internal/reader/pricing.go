package reader

import (
	"errors"
	"math"
)

// Rates are per million tokens. A nil rate is unknown, while zero is free.
type APIPricing struct {
	Currency   string   `json:"currency,omitempty"`
	Input      *float64 `json:"input,omitempty"`
	Output     *float64 `json:"output,omitempty"`
	CacheRead  *float64 `json:"cacheRead,omitempty"`
	CacheWrite *float64 `json:"cacheWrite,omitempty"`
}
type PriceSnapshot struct {
	APIPricing
	Model   string            `json:"model"`
	Sources map[string]string `json:"sources"`
}
type UsageCost struct {
	Currency string   `json:"currency,omitempty"`
	Amount   *float64 `json:"amount"`
	Status   string   `json:"status"`
}
type CurrencyCost struct {
	Currency string  `json:"currency"`
	Amount   float64 `json:"amount"`
}
type CostSummary struct {
	Currencies   []CurrencyCost `json:"currencies"`
	UnknownCalls int            `json:"unknownCalls"`
	PartialCalls int            `json:"partialCalls"`
}

func validatePricing(p *APIPricing, override bool) error {
	if p == nil {
		return nil
	}
	if p.Currency != "CNY" && p.Currency != "USD" && !(override && p.Currency == "") {
		return errors.New("价格币种必须为 CNY 或 USD")
	}
	for _, rate := range []*float64{p.Input, p.Output, p.CacheRead, p.CacheWrite} {
		if rate != nil && (*rate < 0 || math.IsNaN(*rate) || math.IsInf(*rate, 0)) {
			return errors.New("价格必须为非负有限数值")
		}
	}
	return nil
}
func effectiveAPIPrice(p APIProvider, model string) *PriceSnapshot {
	result := &PriceSnapshot{Model: model, Sources: map[string]string{}}
	base, override := p.Pricing, p.ModelOverrides[model].Pricing
	if base != nil {
		result.Currency = base.Currency
	}
	if override != nil && override.Currency != "" {
		result.Currency = override.Currency
	}
	if result.Currency == "" {
		return nil
	}
	for _, entry := range []struct {
		name           string
		target         **float64
		base, override *float64
	}{
		{"input", &result.Input, nil, nil}, {"output", &result.Output, nil, nil}, {"cacheRead", &result.CacheRead, nil, nil}, {"cacheWrite", &result.CacheWrite, nil, nil},
	} {
		if base != nil && base.Currency == result.Currency {
			entry.base = map[string]*float64{"input": base.Input, "output": base.Output, "cacheRead": base.CacheRead, "cacheWrite": base.CacheWrite}[entry.name]
		}
		if override != nil {
			entry.override = map[string]*float64{"input": override.Input, "output": override.Output, "cacheRead": override.CacheRead, "cacheWrite": override.CacheWrite}[entry.name]
		}
		rate, source := entry.base, "provider"
		if entry.override != nil {
			rate, source = entry.override, "model"
		}
		if rate != nil {
			value := *rate
			*entry.target = &value
			result.Sources[entry.name] = source
		}
	}
	return result
}
func clonePrice(p *PriceSnapshot) *PriceSnapshot {
	if p == nil {
		return nil
	}
	result := *p
	result.Sources = map[string]string{}
	for k, v := range p.Sources {
		result.Sources[k] = v
	}
	for _, pair := range [][2]**float64{{&result.Input, &p.Input}, {&result.Output, &p.Output}, {&result.CacheRead, &p.CacheRead}, {&result.CacheWrite, &p.CacheWrite}} {
		if *pair[1] != nil {
			value := **pair[1]
			*pair[0] = &value
		}
	}
	return &result
}
func estimateCost(p *PriceSnapshot, t *TokenCounts, complete bool) *UsageCost {
	cost := &UsageCost{Status: "unknown"}
	if p == nil {
		return cost
	}
	cost.Currency = p.Currency
	if !validTokens(t) {
		return cost
	}
	amount, known, unknown := 0.0, false, false
	add := func(tokens int64, rate *float64) {
		if tokens == 0 {
			return
		}
		if rate == nil {
			unknown = true
			return
		}
		part := float64(tokens) / 1e6 * *rate
		if math.IsInf(part, 0) || math.IsNaN(part) || math.IsInf(amount+part, 0) {
			unknown = true
			return
		}
		amount += part
		known = true
	}
	add(t.OutputTokens, p.Output)
	read, write := int64(0), int64(0)
	if t.CachedInputTokens != nil {
		read = *t.CachedInputTokens
	}
	if t.CacheWriteInputTokens != nil {
		write = *t.CacheWriteInputTokens
	}
	if read > t.InputTokens || write > t.InputTokens-read {
		unknown = true
	} else {
		add(read, p.CacheRead)
		add(write, p.CacheWrite)
		remaining := t.InputTokens - read - write
		same := func(a, b *float64) bool { return a != nil && b != nil && *a == *b }
		if remaining > 0 && ((t.CachedInputTokens == nil && !same(p.Input, p.CacheRead)) || (t.CacheWriteInputTokens == nil && !same(p.Input, p.CacheWrite))) {
			unknown = true
		} else {
			add(remaining, p.Input)
		}
	}
	if t.InputTokens == 0 && t.OutputTokens == 0 {
		known = true
	}
	if known {
		cost.Amount = &amount
		cost.Status = "complete"
		if unknown || !complete {
			cost.Status = "partial"
		}
	}
	return cost
}
func priceUsageCall(call *UsageCall) {
	for i := range call.Models {
		// API aliases use the captured request price. Never look up response IDs in current settings.
		price := call.Price
		if len(call.Models) > 1 && call.Models[i].Model != priceModel(price) {
			price = nil
		}
		call.Models[i].Cost = estimateCost(price, call.Models[i].Tokens, call.Status == "complete")
	}
}
func priceModel(p *PriceSnapshot) string {
	if p == nil {
		return ""
	}
	return p.Model
}
func addCost(summary *CostSummary, cost *UsageCost) {
	if summary.Currencies == nil {
		summary.Currencies = []CurrencyCost{}
	}
	if cost == nil || cost.Status == "unknown" {
		summary.UnknownCalls++
		return
	}
	if cost.Status == "partial" {
		summary.PartialCalls++
	}
	if cost.Amount == nil || cost.Currency == "" {
		return
	}
	for i := range summary.Currencies {
		if summary.Currencies[i].Currency == cost.Currency {
			summary.Currencies[i].Amount += *cost.Amount
			return
		}
	}
	summary.Currencies = append(summary.Currencies, CurrencyCost{Currency: cost.Currency, Amount: *cost.Amount})
}

func addCallCost(summary *CostSummary, call CostSummary, models int) {
	for _, entry := range call.Currencies {
		value := entry.Amount
		addCost(summary, &UsageCost{Currency: entry.Currency, Amount: &value, Status: "complete"})
	}
	if models == 0 || call.UnknownCalls == models {
		summary.UnknownCalls++
	} else if call.UnknownCalls > 0 || call.PartialCalls > 0 {
		summary.PartialCalls++
	}
}
