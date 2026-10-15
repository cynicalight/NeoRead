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

func validatePricing(p *APIPricing) error {
	if p == nil {
		return nil
	}
	if p.Currency != "CNY" && p.Currency != "USD" {
		return errors.New("价格币种必须为 CNY 或 USD")
	}
	for _, rate := range []*float64{p.Input, p.Output, p.CacheRead, p.CacheWrite} {
		if rate != nil && (*rate < 0 || math.IsNaN(*rate) || math.IsInf(*rate, 0)) {
			return errors.New("价格必须为非负有限数值")
		}
	}
	return nil
}

// Runtime pricing belongs exclusively to the selected provider/model record.
func effectiveAPIPrice(p APIProvider, model string) *PriceSnapshot {
	price := p.ModelOverrides[model].Pricing
	if price == nil || price.Currency == "" {
		return nil
	}
	result := clonePrice(&PriceSnapshot{APIPricing: *price, Model: model})
	for field, rate := range map[string]*float64{"input": price.Input, "output": price.Output, "cacheRead": price.CacheRead, "cacheWrite": price.CacheWrite} {
		if rate != nil {
			result.Sources[field] = "model"
		}
	}
	return result
}

// Upgrade the short-lived provider-default format once. Only IDs already stored
// in configuration are eligible; fetching a catalog never assigns prices.
// The normalized config drops LegacyPricing and is persisted on the next save.
func migrateAPIModelPricing(c *AIConfig) {
	for i := range c.APIProviders {
		p := &c.APIProviders[i]
		if p.LegacyPricing == nil {
			continue
		}
		known := map[string]bool{}
		for _, ids := range [][]string{p.Models, p.EnabledModels} {
			for _, model := range ids {
				known[model] = true
			}
		}
		settings := make(map[string]APIModelOverride, len(p.ModelOverrides))
		for model, value := range p.ModelOverrides {
			known[model] = true
			settings[model] = value
		}
		for _, choices := range []map[string]string{c.Models, c.TranslationModels, c.VisionModels} {
			if ref := choices["api"]; ref != "" {
				provider, model := splitAPIModelRef(ref)
				if provider == p.ID {
					known[model] = true
				}
			}
		}
		for model := range known {
			setting := settings[model]
			price := *p.LegacyPricing
			if prior := setting.Pricing; prior != nil {
				if prior.Currency != "" && prior.Currency != price.Currency {
					price = APIPricing{Currency: prior.Currency}
				}
				for _, pair := range [][2]**float64{{&price.Input, &prior.Input}, {&price.Output, &prior.Output}, {&price.CacheRead, &prior.CacheRead}, {&price.CacheWrite, &prior.CacheWrite}} {
					if *pair[1] != nil {
						*pair[0] = *pair[1]
					}
				}
			}
			frozen := clonePrice(&PriceSnapshot{APIPricing: price})
			setting.Pricing = &frozen.APIPricing
			settings[model] = setting
		}
		p.ModelOverrides = settings
		p.LegacyPricing = nil
	}
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
