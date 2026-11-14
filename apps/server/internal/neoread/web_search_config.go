package neoread

import (
	"errors"
	"strings"
)

// WebSearchConfig is independent of the model connection and is never sent to a
// model or worker. Only Go uses its key to execute the selected search protocol.
type WebSearchConfig struct {
	Provider string `json:"provider"`
	URL      string `json:"url"`
	Key      string `json:"key,omitempty"`
	HasKey   bool   `json:"hasKey"`
}

const defaultSearchURL = "https://api.deepseek.com"

func mergeWebSearchConfig(c, old *WebSearchConfig) error {
	c.URL = strings.TrimRight(strings.TrimSpace(c.URL), "/")
	c.Key = strings.TrimSpace(c.Key)
	if c.Provider != "" && c.Provider != "deepseek" {
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
	if c.WebSearch == nil || c.WebSearch.Provider != "deepseek" {
		return APIConnection{}
	}
	return APIConnection{URL: c.WebSearch.URL, Key: c.WebSearch.Key}
}

func validSearchConnection(c APIConnection) bool {
	return c.Key != "" && validateAPIURL(c.URL) == nil
}

func webSearchEnabled(c AIConfig, provider string) bool {
	if c.WebSearch == nil {
		return false
	}
	return validAgent(provider) && validSearchConnection(searchAPIConnection(c))
}
