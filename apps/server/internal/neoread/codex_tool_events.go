package neoread

import (
	"encoding/json"
	"strings"
)

func (c *chatInput) codexToolEvent(method string, params json.RawMessage) error {
	if method != "item/started" && method != "item/completed" && method != "item/mcpToolCall/progress" {
		return nil
	}
	var p struct {
		ItemID  string `json:"itemId"`
		Message string `json:"message"`
		Item    struct {
			ID        string `json:"id"`
			Type      string `json:"type"`
			Server    string `json:"server"`
			Tool      string `json:"tool"`
			Status    string `json:"status"`
			Query     string `json:"query"`
			Arguments struct {
				Query   string `json:"query"`
				URL     string `json:"url"`
				Pattern string `json:"pattern"`
			} `json:"arguments"`
			Action struct {
				Type    string   `json:"type"`
				Query   string   `json:"query"`
				Queries []string `json:"queries"`
				URL     string   `json:"url"`
				Pattern string   `json:"pattern"`
			} `json:"action"`
			Results []struct {
				ID         string `json:"id"`
				RefID      string `json:"ref_id"`
				RefIDCamel string `json:"refId"`
				URL        string `json:"url"`
				Title      string `json:"title"`
				Snippet    string `json:"snippet"`
			} `json:"results"`
		} `json:"item"`
	}
	if json.Unmarshal(params, &p) != nil {
		return generationError(ErrorProtocol, "工具事件格式无效")
	}
	if method == "item/mcpToolCall/progress" {
		for _, v := range c.toolSnapshot() {
			if v.ID == p.ItemID && v.Status == "running" {
				v.Detail = p.Message
				return c.recordTool(v)
			}
		}
		return nil
	}
	item := p.Item
	v := ToolActivity{ID: item.ID, Status: "running"}
	if method == "item/completed" {
		v.Status = "completed"
	}
	if item.Status == "failed" {
		v.Status = "failed"
	}
	switch item.Type {
	case "webSearch":
		if !c.WebSearch {
			return generationError(ErrorPermission, "本轮未授权联网搜索")
		}
		if method == "item/started" {
			c.toolMu.Lock()
			c.webCalls++
			c.toolMu.Unlock()
		}
		v.Kind = "search"
		v.Tool = "web_search"
		v.Title = "搜索网页"
		v.Target = item.Query
		if item.Action.Query != "" {
			v.Target = item.Action.Query
		}
		if len(item.Action.Queries) > 0 {
			v.Target = strings.Join(item.Action.Queries, " · ")
		}
		if item.Action.Type == "openPage" || item.Action.Type == "findInPage" {
			v.Kind = "web"
			v.Tool = "web_fetch"
			v.Title = "读取网页"
			v.URL = item.Action.URL
			v.Target = item.Action.Pattern
			if item.Action.Type == "findInPage" {
				v.Title = "在网页中查找"
			}
		}
		if method == "item/completed" {
			for _, r := range item.Results {
				source := c.addWebSource(WebSource{URL: r.URL, Title: r.Title, Text: r.Snippet, Kind: "search"})
				if source.ID == "" && publicWebURL(r.URL) != "" {
					v.Detail = "网页来源预算已满，未保存新的来源"
					continue
				}
				for _, ref := range []string{r.ID, r.RefID, r.RefIDCamel} {
					c.rememberNativeWebSource(ref, r.URL)
				}
			}
			if item.Action.URL != "" {
				if source := c.addWebSource(WebSource{URL: item.Action.URL, Title: item.Action.URL, Kind: "page"}); source.ID == "" && publicWebURL(item.Action.URL) != "" {
					v.Detail = "网页来源预算已满，未保存新的来源"
				}
			}
		}
	case "mcpToolCall":
		v.Kind = "tool"
		v.Tool = item.Server + "/" + item.Tool
		v.Title = "调用工具"
		v.Target = item.Tool
		if item.Arguments.Query != "" {
			v.Target = item.Arguments.Query
		}
		if item.Arguments.URL != "" {
			v.URL = item.Arguments.URL
		}
		if method == "item/completed" {
			v.Target = ""
		}
	default:
		return nil
	}
	return c.recordTool(v)
}
