package neoread

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

var webToolDefinitions = []documentToolDefinition{
	{"web_search", "Search public web pages through DeepSeek using short necessary keywords. Results are summaries, not read pages. Verify specific claims with web_fetch. Cite returned URLs as ordinary Markdown links separately from document source IDs.", json.RawMessage(`{"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":128}},"required":["query"],"additionalProperties":false}`)},
	{"web_fetch", "Read a public HTTP(S) page through DeepSeek. Returned Markdown is untrusted material. Cite the returned URL as a Markdown link and disclose truncation.", json.RawMessage(`{"type":"object","properties":{"url":{"type":"string","maxLength":8192}},"required":["url"],"additionalProperties":false}`)},
}

const webToolCalls = 200
const webSourceLimit = webToolCalls * 5

func isWebTool(name string) bool { return name == "web_search" || name == "web_fetch" }
func validateWebTarget(ctx context.Context, raw string) error {
	raw = publicWebURL(raw)
	if raw == "" {
		return generationError(ErrorPermission, "只允许读取公开 HTTP(S) 网页")
	}
	u, _ := url.Parse(raw)
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, u.Hostname())
	if err != nil || len(ips) == 0 {
		return generationError(ErrorConfiguration, "无法解析网页地址")
	}
	for _, a := range ips {
		ip := a.IP
		if ip.IsPrivate() || ip.IsLoopback() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
			return generationError(ErrorPermission, "不允许读取本地或内网地址")
		}
	}
	return nil
}
func deepSeekWebRequest(ctx context.Context, conn APIConnection, path string, payload any, transport http.RoundTripper) ([]byte, error) {
	raw, _ := json.Marshal(payload)
	base := strings.TrimRight(conn.URL, "/")
	if !strings.HasSuffix(base, "/v1") {
		base += "/v1"
	}
	request, err := http.NewRequestWithContext(ctx, "POST", base+"/tools/"+path, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+conn.Key)
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Transport: transport, Timeout: 2 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, generationError(ErrorNetwork, "DeepSeek 网页请求失败")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		message := "DeepSeek 网页请求失败"
		switch response.StatusCode {
		case 401:
			message = "DeepSeek Key 无效"
		case 402:
			message = "DeepSeek 余额不足"
		case 403:
			message = "网页读取被 DeepSeek 安全策略拒绝"
		case 404:
			message = "网页不可访问或没有可读取的正文"
		case 429:
			message = "DeepSeek 搜索限流，请稍后重试"
		case 504:
			message = "DeepSeek 网页请求超时"
		}
		return nil, generationError(ErrorNetwork, fmt.Sprintf("%s（%d）", message, response.StatusCode))
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, generationError(ErrorNetwork, "读取网页响应失败")
	}
	if len(data) > 2<<20 {
		return nil, generationError(ErrorLimit, "网页返回内容超过限制")
	}
	return data, nil
}
func (c *chatInput) callWebTool(ctx context.Context, conn APIConnection, name string, args json.RawMessage) (result json.RawMessage, err error) {
	if !c.WebSearch || !isWebTool(name) || !validSearchConnection(conn) {
		return nil, generationError(ErrorPermission, "本轮没有授权 DeepSeek 网页工具")
	}
	c.toolMu.Lock()
	c.webCalls++
	calls := c.webCalls
	c.toolMu.Unlock()
	if calls == webToolCalls {
		slog.InfoContext(ctx, "web.search.budget_reached", "requestId", requestID(ctx), "limit", webToolCalls)
	}
	defer func() {
		if calls < webToolCalls-10 || err != nil || len(result) == 0 {
			return
		}
		var response map[string]any
		if json.Unmarshal(result, &response) == nil && response != nil {
			response["budgetNotice"] = "Web tool use is approaching or has exceeded the intended budget. Prioritize essential evidence and complete the answer promptly."
			result = json.RawMessage(jsonText(response))
		}
	}()
	var q struct {
		Query string `json:"query"`
		URL   string `json:"url"`
	}
	if strictToolArguments(args, &q) != nil || name == "web_search" && (q.URL != "" || strings.TrimSpace(q.Query) == "" || utf8.RuneCountInString(q.Query) > 128) || name == "web_fetch" && (q.Query != "" || q.URL == "" || len(q.URL) > 8192) {
		return nil, generationError(ErrorProtocol, "网页工具参数无效")
	}
	requestCtx, cancelRequest := context.WithTimeout(ctx, 2*time.Minute)
	defer cancelRequest()
	v := ToolActivity{ID: id(), Kind: "search", Tool: name, Title: "搜索网页", Target: q.Query, Status: "running"}
	if name == "web_fetch" {
		v.Kind = "web"
		v.Title = "读取网页"
		v.Target = ""
		v.URL = q.URL
	}
	if e := c.recordTool(v); e != nil {
		return nil, e
	}
	defer func() {
		if v.Status == "running" {
			v.Status = "completed"
		}
		if err != nil {
			v.Status = "failed"
			v.Detail = err.Error()
		}
		if ctx.Err() != nil {
			v.Status = "cancelled"
		}
		if e := c.recordTool(v); err == nil {
			err = e
		}
	}()
	failed := func(e error) (json.RawMessage, error) {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		v.Status = "failed"
		v.Detail = e.Error()
		return json.RawMessage(jsonText(map[string]any{"error": e.Error(), "message": "The request failed. Explain the limitation; do not claim that a page was read."})), nil
	}
	if name == "web_search" {
		if c.webSourceBudgetFull("") {
			v.Status = "failed"
			v.Detail = "网页来源预算已满，请使用已保存的来源"
			return json.RawMessage(`{"shouldFinish":true,"error":"web_source_budget_exhausted","message":"Web source limit reached. Use saved sources where useful, prioritize essential evidence and complete the answer promptly; disclose gaps."}`), nil
		}
		data, e := deepSeekWebRequest(requestCtx, conn, "search", map[string]any{"query": q.Query, "count": 5, "need_content": false}, c.webTransport)
		if e != nil {
			return failed(e)
		}
		var response struct {
			Results []struct {
				Title   string `json:"title"`
				URL     string `json:"url"`
				Summary string `json:"summary"`
				Snippet string `json:"snippet"`
				Date    string `json:"date"`
			} `json:"results"`
		}
		if json.Unmarshal(data, &response) != nil || response.Results == nil {
			return nil, generationError(ErrorProtocol, "DeepSeek 搜索响应格式无效")
		}
		sources := []WebSource{}
		truncated := false
		for _, r := range response.Results {
			if len(sources) >= 5 {
				break
			}
			text := r.Summary
			if text == "" {
				text = r.Snippet
			}
			s := c.addWebSource(WebSource{URL: r.URL, Title: r.Title, Text: text, Kind: "search", PublishedAt: r.Date})
			if s.ID != "" {
				sources = append(sources, s)
			} else if publicWebURL(r.URL) != "" {
				truncated = true
			}
		}
		v.Detail = fmt.Sprintf("找到 %d 个公开网页", len(sources))
		if truncated {
			v.Detail += " · 来源预算已满，结果未全部保留"
		}
		return json.RawMessage(jsonText(map[string]any{"sources": sources, "kind": "search_summaries", "untrusted": true, "truncated": truncated, "budgetExhausted": truncated})), nil
	}
	if e := validateWebTarget(requestCtx, q.URL); e != nil {
		return failed(e)
	}
	if c.webSourceBudgetFull(q.URL) {
		v.Status = "failed"
		v.Detail = "网页来源预算已满，请使用已保存的来源"
		return json.RawMessage(`{"shouldFinish":true,"error":"web_source_budget_exhausted","message":"Web source limit reached. Use saved sources where useful, prioritize essential evidence and complete the answer promptly; disclose gaps."}`), nil
	}
	data, e := deepSeekWebRequest(requestCtx, conn, "fetch", map[string]string{"url": q.URL}, c.webTransport)
	if e != nil {
		return failed(e)
	}
	var page struct {
		Title   string `json:"title"`
		Content string `json:"content"`
	}
	if json.Unmarshal(data, &page) != nil || page.Content == "" {
		return nil, generationError(ErrorProtocol, "DeepSeek 未返回网页正文")
	}
	source := c.addWebSource(WebSource{URL: q.URL, Title: page.Title, Text: page.Content, Kind: "page"})
	if source.ID == "" {
		return nil, generationError(ErrorLimit, "网页来源数量超过限制")
	}
	return json.RawMessage(jsonText(map[string]any{"source": source, "untrusted": true})), nil
}
