package neoread

import (
	"errors"
	"strings"
)

// WebSearchConfig is independent of the model connection and is never sent to a
// model or worker. Only Go uses its key to execute the selected search protocol.
type WebSearchConfig struct {
	CLIEnabled bool   `json:"cliEnabled"`
	Provider   string `json:"provider"`
	URL        string `json:"url"`
	Key        string `json:"key,omitempty"`
	HasKey     bool   `json:"hasKey"`
}

const defaultSearchURL = "https://api.deepseek.com"

// Keenable has a fixed address and works without a key; a key only lifts rate limits.
const keenableSearchURL = "https://api.keenable.ai"

func mergeWebSearchConfig(c, old *WebSearchConfig) error {
	c.URL = strings.TrimRight(strings.TrimSpace(c.URL), "/")
	c.Key = strings.TrimSpace(c.Key)
	switch c.Provider {
	case "", "deepseek":
	case "keenable":
		c.URL = keenableSearchURL
	default:
		return errors.New("暂不支持此搜索 API")
	}
	if c.URL == "" {
		c.URL = defaultSearchURL
	}
	if err := validateAPIURL(c.URL); err != nil {
		return err
	}
	if c.Key == "" && c.HasKey && old != nil {
		if c.URL != strings.TrimRight(old.URL, "/") {
			return errors.New("搜索 API 地址已更改，请重新填写 API Key")
		}
		c.Key = old.Key
	}
	c.HasKey = false
	if len(c.Key) > 8192 || strings.ContainsAny(c.Key, "\r\n") {
		return errors.New("搜索 API Key 格式无效")
	}
	return nil
}

func searchAPIConnection(c AIConfig) APIConnection {
	if c.WebSearch == nil {
		return APIConnection{}
	}
	switch c.WebSearch.Provider {
	case "deepseek":
		return APIConnection{URL: c.WebSearch.URL, Key: c.WebSearch.Key}
	case "keenable":
		return APIConnection{Protocol: "keenable", URL: keenableSearchURL, Key: c.WebSearch.Key}
	}
	return APIConnection{}
}

func validSearchConnection(c APIConnection) bool {
	if c.Protocol == "keenable" {
		return c.URL == keenableSearchURL
	}
	return c.Key != "" && validateAPIURL(c.URL) == nil
}

func webSearchEnabled(c AIConfig, provider string) bool {
	if c.WebSearch == nil {
		return false
	}
	if provider == "codex" {
		return c.WebSearch.CLIEnabled
	}
	return provider == "api" && validSearchConnection(searchAPIConnection(c))
}
