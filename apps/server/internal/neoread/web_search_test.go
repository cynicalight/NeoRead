package neoread

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type webRoundTrip func(*http.Request) (*http.Response, error)

func (f webRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func webJSON(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}
}
func TestDeepSeekWebPermissionSourcesAndFailure(t *testing.T) {
	conn := APIConnection{URL: "https://api.deepseek.com/v1", Key: "test-secret"}
	calls := 0
	c := &chatInput{WebSearch: true, webTransport: webRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != "https://api.deepseek.com/v1/tools/search" || r.Header.Get("Authorization") != "Bearer test-secret" {
			t.Fatal("wrong destination or credential")
		}
		data, _ := io.ReadAll(r.Body)
		if strings.Contains(string(data), "ori_question") || strings.Contains(string(data), "PRIVATE_DOCUMENT") {
			t.Fatal("private context sent")
		}
		return webJSON(200, `{"results":[{"title":"Official","url":"https://example.com/article","summary":"Search summary","date":"2026-10-23"},{"title":"local","url":"http://127.0.0.1/private"}]}`), nil
	})}
	raw, err := c.callWebTool(t.Context(), conn, "web_search", json.RawMessage(`{"query":"official documentation"}`))
	if err != nil || !strings.Contains(string(raw), "search_summaries") {
		t.Fatal(string(raw), err)
	}
	if calls != 1 || len(c.WebSources) != 1 || c.WebSources[0].Kind != "search" || c.WebSources[0].RetrievedAt == "" || c.Tools[0].Status != "completed" {
		t.Fatal(c.WebSources, c.Tools)
	}
	c.WebSearch = false
	if _, err = c.callWebTool(t.Context(), conn, "web_search", json.RawMessage(`{"query":"x"}`)); errorKind(err) != ErrorPermission || calls != 1 {
		t.Fatal("disabled tool made a request", err)
	}
	c.WebSearch = true
	c.webTransport = webRoundTrip(func(*http.Request) (*http.Response, error) { return webJSON(429, `{"error":"PRIVATE_SECRET"}`), nil })
	raw, err = c.callWebTool(t.Context(), conn, "web_search", json.RawMessage(`{"query":"x"}`))
	if err != nil || !strings.Contains(string(raw), "限流") || strings.Contains(string(raw), "PRIVATE_SECRET") || c.Tools[1].Status != "failed" {
		t.Fatal(string(raw), err, c.Tools)
	}
	c.webCalls = webToolCalls
	if raw, err = c.callWebTool(t.Context(), conn, "web_search", json.RawMessage(`{"query":"x"}`)); err != nil || !strings.Contains(string(raw), `"budgetNotice"`) {
		t.Fatal(string(raw), err)
	}
}
func TestDeepSeekWebFetchBoundsAndCancel(t *testing.T) {
	conn := APIConnection{URL: "https://api.deepseek.com", Key: "test"}
	c := &chatInput{WebSearch: true, webTransport: webRoundTrip(func(r *http.Request) (*http.Response, error) {
		return webJSON(200, jsonText(map[string]string{"title": "Page", "content": strings.Repeat("a", 9000)})), nil
	})}
	raw, err := c.callWebTool(t.Context(), conn, "web_fetch", json.RawMessage(`{"url":"https://1.1.1.1/page"}`))
	if err != nil || !strings.Contains(string(raw), `"truncated":true`) || len(c.WebSources) != 1 || c.WebSources[0].Kind != "page" {
		t.Fatal(err, string(raw))
	}
	for _, url := range []string{"file:///etc/passwd", "http://127.0.0.1/", "http://[::1]/", "http://192.168.1.1/", "http://169.254.169.254/", "https://user:pass@example.com/"} {
		if err := validateWebTarget(t.Context(), url); errorKind(err) != ErrorPermission {
			t.Fatal(url, err)
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	c.webTransport = webRoundTrip(func(r *http.Request) (*http.Response, error) { return nil, r.Context().Err() })
	if _, err = c.callWebTool(ctx, conn, "web_search", json.RawMessage(`{"query":"x"}`)); err == nil || c.Tools[len(c.Tools)-1].Status != "cancelled" {
		t.Fatal(err, c.Tools)
	}
}
func TestWebConnectionAndRedirectBoundaries(t *testing.T) {
	for _, raw := range []string{"https://api.deepseek.com.evil.test", "http://api.deepseek.com", "https://api.deepseek.com:8443", "https://u:p@api.deepseek.com", "https://api.deepseek.com/v1?token=x"} {
		if deepSeekSearchConnection(APIConnection{URL: raw, Key: "key"}) {
			t.Fatal(raw)
		}
	}
	transport := webRoundTrip(func(*http.Request) (*http.Response, error) {
		r := webJSON(302, "")
		r.Header.Set("Location", "https://other.example/leak")
		return r, nil
	})
	if _, err := deepSeekWebRequest(t.Context(), APIConnection{URL: defaultSearchURL, Key: "secret"}, "search", map[string]string{"query": "x"}, transport); err == nil {
		t.Fatal("redirect accepted")
	}
	if got := displayWebURL("https://example.com/page?token=private&q=reader#secret"); strings.Contains(got, "private") || strings.Contains(got, "secret") || !strings.Contains(got, "q=reader") {
		t.Fatal(got)
	}
}
func TestNativeToolActivitiesAreScopedAndPersistent(t *testing.T) {
	c := &chatInput{WebSearch: true}
	start := json.RawMessage(`{"item":{"id":"search-1","type":"webSearch","query":"official docs","action":{"type":"search","queries":["official docs"]}}}`)
	if err := c.codexToolEvent("item/started", start); err != nil {
		t.Fatal(err)
	}
	if err := c.codexToolEvent("item/completed", json.RawMessage(`{"item":{"id":"search-1","type":"webSearch","query":"official docs","results":[{"url":"https://example.com/docs","title":"Official"}]}}`)); err != nil {
		t.Fatal(err)
	}
	if len(c.Tools) != 1 || c.Tools[0].Status != "completed" || len(c.WebSources) != 1 {
		t.Fatal(c.Tools, c.WebSources)
	}
	c.recordTool(ToolActivity{ID: "mcp-1", Kind: "tool", Tool: "reader/read_passage", Title: "读取原文", Status: "running"})
	c.codexToolEvent("item/mcpToolCall/progress", json.RawMessage(`{"itemId":"mcp-1","message":"Reading chapter 2"}`))
	if c.Tools[1].Detail != "Reading chapter 2" {
		t.Fatal(c.Tools)
	}
	c.settleTools("cancelled")
	if c.Tools[1].Status != "cancelled" || c.Tools[0].Status != "completed" {
		t.Fatal(c.Tools)
	}
	c.WebSearch = false
	if err := c.codexToolEvent("item/started", start); errorKind(err) != ErrorPermission {
		t.Fatal("unauthorized native search", err)
	}
	s, a := originalDocumentFixture(t)
	a.chat = c
	if err := s.saveDocumentAgentAnswer(t.Context(), a, "Answer without document claims", "codex"); err != nil {
		t.Fatal(err)
	}
	history, err := s.Store.chatHistory("doc")
	if err != nil || len(history) != 1 || len(history[0].Tools) != 2 || len(history[0].WebSources) != 1 {
		t.Fatal(history, err)
	}
}

func TestPiDeepSeekWebToolsBridge(t *testing.T) {
	piTestRuntime(t)
	s, a := originalDocumentFixture(t)
	preload := filepath.Join(t.TempDir(), "mock-model.cjs")
	script := `globalThis.fetch=async function(url,init){
 if(new Headers(init.headers).get('authorization')!=='Bearer model-secret')throw new Error('model credential missing');
 const p=JSON.parse(init.body),tools=p.messages.filter(m=>m.role==='tool');
 if(init.body.includes('search-secret'))throw new Error('search key leaked to model');
 if(!p.tools?.some(t=>t.function.name==='web_search'))throw new Error('web tool missing');
 const call=tools.length===0?{name:'web_search',arguments:JSON.stringify({query:'official docs'})}:tools.length===1?{name:'web_fetch',arguments:JSON.stringify({url:'https://1.1.1.1/docs'})}:null;
 const delta=call?{tool_calls:[{index:0,id:'tool-'+tools.length,type:'function',function:call}]}:{content:'See [Official](https://1.1.1.1/docs).'};
 let out='';for(const choice of [{delta,finish_reason:null},{delta:{},finish_reason:call?'tool_calls':'stop'}])out+='data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',model:'test',choices:[{index:0,...choice}]})+'\n\n';
 return new Response(out+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
 };`
	if err := os.WriteFile(preload, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NODE_OPTIONS", "--require="+preload)
	calls := []string{}
	chat := &chatInput{server: s, DocumentID: "doc", SessionID: "", Question: "Find official docs", Agent: a, WebSearch: true, WebAPI: APIConnection{URL: "https://search.example/gateway/v1", Key: "search-secret"}, webTransport: webRoundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "search.example" || !strings.HasPrefix(r.URL.Path, "/gateway/v1/tools/") || r.Header.Get("Authorization") != "Bearer search-secret" {
			t.Fatal("search connection was mixed with the model connection")
		}
		calls = append(calls, r.URL.Path)
		if strings.HasSuffix(r.URL.Path, "search") {
			return webJSON(200, `{"results":[{"title":"Official","url":"https://1.1.1.1/docs","summary":"Search candidate"}]}`), nil
		}
		return webJSON(200, `{"title":"Official","content":"Verified public page text"}`), nil
	})}
	result, err := streamPiChat(t.Context(), APIConnection{URL: "https://model.example/v1", Key: "model-secret"}, completionRequest{Model: "test", Tools: true, ContextWindow: 64000}, AIInput{Prompt: chat.Question, Chat: chat}, nil)
	if err != nil || !strings.Contains(result.Text, "https://1.1.1.1/docs") || len(calls) != 2 || len(chat.Tools) != 2 || len(chat.WebSources) != 1 || chat.WebSources[0].Kind != "page" || chat.WebSources[0].Text != "Verified public page text" {
		t.Fatal(err, result.Text, calls, chat.Tools, chat.WebSources)
	}
	if err = s.saveDocumentAgentAnswer(t.Context(), a, result.Text, "api"); err != nil {
		t.Fatal(err)
	}
	history, err := s.Store.chatHistory("doc")
	if err != nil || len(history) != 1 || len(history[0].WebSources) != 1 || len(history[0].Tools) != 2 {
		t.Fatal(err, history)
	}
}

func TestNativeWebCitationsKeepDocumentValidationAndStreaming(t *testing.T) {
	c := &chatInput{WebSearch: true}
	c.rememberNativeWebSource("turn0search0", "https://example.com/docs")
	text := "Before citeturn0search0S2 after"
	want := "Before [网页来源](https://example.com/docs)[S2] after"
	stream := webCitationStream{normalize: c.normalizeWebCitations}
	out := ""
	for _, r := range text {
		out += stream.feed(string(r))
	}
	out += stream.finish()
	if out != want {
		t.Fatal(out)
	}
	ids, err := documentCitationSources(out)
	if err != nil || len(ids) != 1 || ids[0] != "S2" {
		t.Fatal(ids, err)
	}
	if got := c.normalizeWebCitations("citeturn1view0"); !strings.Contains(got, "引用未解析") {
		t.Fatal(got)
	}
	if _, err := documentCitationSources(c.normalizeWebCitations("citeunknown")); err == nil {
		t.Fatal("unknown source bypassed validator")
	}
	c.WebSearch = false
	if c.normalizeWebCitations(text) != text {
		t.Fatal("disabled mode changed validation")
	}
}

func TestSourceRefreshStillEnforcesSnapshotLimit(t *testing.T) {
	c := &chatInput{}
	first := c.addWebSource(WebSource{URL: "https://example.com/", Title: "Original", Text: "Summary", Kind: "search"})
	next := c.addWebSource(WebSource{URL: first.URL, Title: strings.Repeat("x", 500), Text: strings.Repeat("原文", 8000), Kind: "page"})
	if next.ID != first.ID || !next.Truncated || len(next.Text) > 8192 || len([]rune(next.Title)) > 161 || next.RetrievedAt == "" {
		t.Fatal(next.ID, next.Truncated, len(next.Text), len([]rune(next.Title)))
	}
	c.recordTool(ToolActivity{ID: "x", Kind: "tool", Title: "Read", Status: "completed"})
	c.recordTool(ToolActivity{ID: "x", Kind: "tool", Title: "Read", Status: "running"})
	if c.Tools[0].Status != "completed" {
		t.Fatal("late start reverted completion")
	}
}

func TestToolCompletionRetainsActualTargetAndProgress(t *testing.T) {
	c := &chatInput{}
	c.recordTool(ToolActivity{ID: "m", Kind: "tool", Tool: "reader/read_passage", Title: "调用工具", Target: "read_passage", Status: "running"})
	step := c.Tools[0]
	step.Target = "正在读取第 7 页"
	c.recordTool(step)
	c.codexToolEvent("item/mcpToolCall/progress", json.RawMessage(`{"itemId":"m","message":"已读取第 7 页"}`))
	c.codexToolEvent("item/completed", json.RawMessage(`{"item":{"id":"m","type":"mcpToolCall","server":"reader","tool":"read_passage","status":"completed","arguments":{"blockId":"p7-b1"}}}`))
	if c.Tools[0].Target != "正在读取第 7 页" || c.Tools[0].Detail != "已读取第 7 页" || c.Tools[0].Status != "completed" {
		t.Fatal(c.Tools)
	}
	s, a := originalDocumentFixture(t)
	a.chat = c
	if err := s.saveDocumentAgentAnswer(t.Context(), a, "Summary", "codex"); err != nil {
		t.Fatal(err)
	}
	messages, err := s.Store.chatHistory("doc")
	if err != nil || messages[0].Tools[0].Target != c.Tools[0].Target || messages[0].Tools[0].Detail != c.Tools[0].Detail {
		t.Fatal(messages, err)
	}
}
func TestWebSourceBudgetIsNotReportedAsNoResults(t *testing.T) {
	c := &chatInput{WebSearch: true}
	for i := 0; i < webSourceLimit-1; i++ {
		c.addWebSource(WebSource{URL: fmt.Sprintf("https://example.com/%d", i), Title: "Existing", Kind: "search"})
	}
	count := 0
	c.webTransport = webRoundTrip(func(*http.Request) (*http.Response, error) {
		count++
		return webJSON(200, `{"results":[{"title":"A","url":"https://example.com/a"},{"title":"B","url":"https://example.com/b"}]}`), nil
	})
	conn := APIConnection{URL: "https://api.deepseek.com", Key: "dummy"}
	raw, err := c.callWebTool(t.Context(), conn, "web_search", json.RawMessage(`{"query":"new docs"}`))
	if err != nil || !strings.Contains(string(raw), `"budgetExhausted":true`) || !strings.Contains(c.Tools[0].Detail, "预算已满") {
		t.Fatal(string(raw), c.Tools, err)
	}
	raw, err = c.callWebTool(t.Context(), conn, "web_search", json.RawMessage(`{"query":"other docs"}`))
	if err != nil || !strings.Contains(string(raw), `"shouldFinish":true`) || count != 1 || c.Tools[1].Status != "failed" {
		t.Fatal(string(raw), c.Tools, err, count)
	}
	err = c.codexToolEvent("item/completed", json.RawMessage(`{"item":{"id":"native","type":"webSearch","query":"other docs","results":[{"title":"New","url":"https://example.com/new"}]}}`))
	if err != nil || !strings.Contains(c.Tools[2].Detail, "预算已满") {
		t.Fatal(err, c.Tools)
	}
}

func TestPiWebBudgetLetsModelFinish(t *testing.T) {
	piTestRuntime(t)
	s, a := originalDocumentFixture(t)
	preload := filepath.Join(t.TempDir(), "mock-model.cjs")
	script := `globalThis.fetch=async function(url,init){
 if(new Headers(init.headers).get('authorization')!=='Bearer model-secret')throw new Error('model credential missing');
 const p=JSON.parse(init.body),tools=p.messages.filter(m=>m.role==='tool');
 if(init.body.includes('search-secret'))throw new Error('search key leaked to model');
 if(!p.tools?.some(t=>t.function.name==='web_search'))throw new Error('web tool missing');
 if(tools.length && !tools.at(-1).content.includes('budgetNotice'))throw new Error('missing budget notice');
 const call=tools.length===0?{name:'web_search',arguments:JSON.stringify({query:'official docs'})}:null;
 const delta=call?{tool_calls:[{index:0,id:'tool-'+tools.length,type:'function',function:call}]}:{content:'See [Official](https://1.1.1.1/docs).'};
 let out='';for(const choice of [{delta,finish_reason:null},{delta:{},finish_reason:call?'tool_calls':'stop'}])out+='data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',model:'test',choices:[{index:0,...choice}]})+'\n\n';
 return new Response(out+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
 };`
	if err := os.WriteFile(preload, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NODE_OPTIONS", "--require="+preload)
	calls := []string{}
	chat := &chatInput{server: s, DocumentID: "doc", SessionID: "", Question: "Find official docs", Agent: a, WebSearch: true, webCalls: 200, WebAPI: APIConnection{URL: "https://search.example/gateway/v1", Key: "search-secret"}, webTransport: webRoundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "search.example" || !strings.HasPrefix(r.URL.Path, "/gateway/v1/tools/") || r.Header.Get("Authorization") != "Bearer search-secret" {
			t.Fatal("search connection was mixed with the model connection")
		}
		calls = append(calls, r.URL.Path)
		if strings.HasSuffix(r.URL.Path, "search") {
			return webJSON(200, `{"results":[{"title":"Official","url":"https://1.1.1.1/docs","summary":"Search candidate"}]}`), nil
		}
		return webJSON(200, `{"title":"Official","content":"Verified public page text"}`), nil
	})}
	result, err := streamPiChat(t.Context(), APIConnection{URL: "https://model.example/v1", Key: "model-secret"}, completionRequest{Model: "test", Tools: true, ContextWindow: 64000}, AIInput{Prompt: chat.Question, Chat: chat}, nil)
	if err != nil || !strings.Contains(result.Text, "https://1.1.1.1/docs") || len(calls) != 1 {
		t.Fatal("model should finish after receiving budget notice", err, result.Text, calls)
	}
	if err := s.saveDocumentAgentAnswer(t.Context(), a, result.Text, "api"); err != nil {
		t.Fatal("final answer was not saved", err)
	}
	history, err := s.Store.chatHistory("doc")
	if err != nil || len(history) != 1 || !strings.Contains(history[0].Content, "Official") {
		t.Fatal("completed answer missing from history", history, err)
	}
}

func TestWebBudgetAllows200Requests(t *testing.T) {
	requests := 0
	c := &chatInput{WebSearch: true, webTransport: webRoundTrip(func(*http.Request) (*http.Response, error) {
		requests++
		return webJSON(200, `{"results":[{"title":"A","url":"https://example.com/a"}]}`), nil
	})}
	conn := APIConnection{URL: "https://api.deepseek.com", Key: "test"}
	for i := 0; i < webToolCalls+1; i++ {
		raw, err := c.callWebTool(t.Context(), conn, "web_search", json.RawMessage(`{"query":"test"}`))
		if err != nil || (i == webToolCalls && !strings.Contains(string(raw), `"budgetNotice"`)) {
			t.Fatalf("call %d: %s %v", i+1, raw, err)
		}
	}
	if requests != webToolCalls+1 {
		t.Fatalf("got %d upstream requests, want %d", requests, webToolCalls+1)
	}
}

func TestToolActivityBudgetDoesNotInterrupt(t *testing.T) {
	c := &chatInput{}
	for i := 0; i < 300; i++ {
		activity := ToolActivity{ID: fmt.Sprint(i), Title: "搜索网页", Status: "running"}
		if err := c.recordTool(activity); err != nil {
			t.Fatal(i, err)
		}
		activity.Status = "completed"
		if err := c.recordTool(activity); err != nil {
			t.Fatal(i, err)
		}
	}
	if len(c.Tools) != 256 || c.Tools[255].Status != "completed" {
		t.Fatal("record limit or retained activity state is incorrect", len(c.Tools))
	}
}

func TestPiToolRoundsFinishWithoutInterruption(t *testing.T) {
	piTestRuntime(t)
	s, a := originalDocumentFixture(t)
	preload := filepath.Join(t.TempDir(), "mock-model.cjs")
	script := `globalThis.fetch=async function(url,init){
 if(new Headers(init.headers).get('authorization')!=='Bearer model-secret')throw new Error('model credential missing');
 const p=JSON.parse(init.body),tools=p.messages.filter(m=>m.role==='tool');
 if(init.body.includes('search-secret'))throw new Error('search key leaked to model');
 if(!p.tools?.some(t=>t.function.name==='web_search'))throw new Error('web tool missing');
 const call=tools.length<64?{name:'web_search',arguments:JSON.stringify({query:'official docs'})}:null;
 const delta=call?{tool_calls:[{index:0,id:'tool-'+tools.length,type:'function',function:call}]}:{content:'See [Official](https://1.1.1.1/docs).'};
 let out='';for(const choice of [{delta,finish_reason:null},{delta:{},finish_reason:call?'tool_calls':'stop'}])out+='data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',model:'test',choices:[{index:0,...choice}]})+'\n\n';
 return new Response(out+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
 };`
	if err := os.WriteFile(preload, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NODE_OPTIONS", "--require="+preload)
	calls := []string{}
	chat := &chatInput{server: s, DocumentID: "doc", SessionID: "", Question: "Find official docs", Agent: a, WebSearch: true, WebAPI: APIConnection{URL: "https://search.example/gateway/v1", Key: "search-secret"}, webTransport: webRoundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "search.example" || !strings.HasPrefix(r.URL.Path, "/gateway/v1/tools/") || r.Header.Get("Authorization") != "Bearer search-secret" {
			t.Fatal("search connection was mixed with the model connection")
		}
		calls = append(calls, r.URL.Path)
		if strings.HasSuffix(r.URL.Path, "search") {
			return webJSON(200, `{"results":[{"title":"Official","url":"https://1.1.1.1/docs","summary":"Search candidate"}]}`), nil
		}
		return webJSON(200, `{"title":"Official","content":"Verified public page text"}`), nil
	})}
	result, err := streamPiChat(t.Context(), APIConnection{URL: "https://model.example/v1", Key: "model-secret"}, completionRequest{Model: "test", Tools: true, ContextWindow: 64000}, AIInput{Prompt: chat.Question, Chat: chat}, nil)
	if err != nil || !strings.Contains(result.Text, "https://1.1.1.1/docs") || len(calls) != 64 {
		t.Fatal("model should finish after receiving budget notice", err, result.Text, calls)
	}
	if err := s.saveDocumentAgentAnswer(t.Context(), a, result.Text, "api"); err != nil {
		t.Fatal("final answer was not saved", err)
	}
	history, err := s.Store.chatHistory("doc")
	if err != nil || len(history) != 1 || !strings.Contains(history[0].Content, "Official") {
		t.Fatal("completed answer missing from history", history, err)
	}
}

func TestPiRoundBudgetWarnsWithoutDisablingTools(t *testing.T) {
	piTestRuntime(t)
	s, a := originalDocumentFixture(t)
	preload := filepath.Join(t.TempDir(), "mock-model.cjs")
	script := `let round=0; globalThis.fetch=async function(url,init){
 if(new Headers(init.headers).get('authorization')!=='Bearer model-secret')throw new Error('model credential missing');
 const p=JSON.parse(init.body),tools=p.messages.filter(m=>m.role==='tool');
 if(init.body.includes('search-secret'))throw new Error('search key leaked to model');
 round++; if(round===256 && (!p.tools?.length || !JSON.stringify(p.messages).includes('预算')))throw new Error('tools disabled or budget warning missing');
 const call=round<=256?{name:'web_search',arguments:JSON.stringify({query:'official docs'})}:null;
 const delta=call?{tool_calls:[{index:0,id:'tool-'+tools.length,type:'function',function:call}]}:{content:'See [Official](https://1.1.1.1/docs).'};
 let out='';for(const choice of [{delta,finish_reason:null},{delta:{},finish_reason:call?'tool_calls':'stop'}])out+='data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',model:'test',choices:[{index:0,...choice}]})+'\n\n';
 return new Response(out+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
 };`
	if err := os.WriteFile(preload, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NODE_OPTIONS", "--require="+preload)
	calls := []string{}
	chat := &chatInput{server: s, DocumentID: "doc", SessionID: "", Question: "Find official docs", Agent: a, WebSearch: true, WebAPI: APIConnection{URL: "https://search.example/gateway/v1", Key: "search-secret"}, webTransport: webRoundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "search.example" || !strings.HasPrefix(r.URL.Path, "/gateway/v1/tools/") || r.Header.Get("Authorization") != "Bearer search-secret" {
			t.Fatal("search connection was mixed with the model connection")
		}
		calls = append(calls, r.URL.Path)
		if strings.HasSuffix(r.URL.Path, "search") {
			return webJSON(200, `{"results":[{"title":"Official","url":"https://1.1.1.1/docs","summary":"Search candidate"}]}`), nil
		}
		return webJSON(200, `{"title":"Official","content":"Verified public page text"}`), nil
	})}
	result, err := streamPiChat(t.Context(), APIConnection{URL: "https://model.example/v1", Key: "model-secret"}, completionRequest{Model: "test", Tools: true, ContextWindow: 64000}, AIInput{Prompt: chat.Question, Chat: chat}, nil)
	if err != nil || !strings.Contains(result.Text, "https://1.1.1.1/docs") || len(calls) != 256 {
		t.Fatal("model should finish after receiving budget notice", err, result.Text, calls)
	}
	if err := s.saveDocumentAgentAnswer(t.Context(), a, result.Text, "api"); err != nil {
		t.Fatal("final answer was not saved", err)
	}
	history, err := s.Store.chatHistory("doc")
	if err != nil || len(history) != 1 || !strings.Contains(history[0].Content, "Official") {
		t.Fatal("completed answer missing from history", history, err)
	}
}

func TestPiWebProtocolErrorLetsModelFinish(t *testing.T) {
	piTestRuntime(t)
	s, a := originalDocumentFixture(t)
	preload := filepath.Join(t.TempDir(), "mock-model.cjs")
	script := `globalThis.fetch=async function(url,init){
 if(new Headers(init.headers).get('authorization')!=='Bearer model-secret')throw new Error('model credential missing');
 const p=JSON.parse(init.body),tools=p.messages.filter(m=>m.role==='tool');
 if(init.body.includes('search-secret'))throw new Error('search key leaked to model');
 if(!p.tools?.some(t=>t.function.name==='web_search'))throw new Error('web tool missing');
 if(tools.length && !tools.at(-1).content.includes('web_tool_failed'))throw new Error('missing budget notice');
 const call=tools.length===0?{name:'web_search',arguments:JSON.stringify({query:'official docs'})}:null;
 const delta=call?{tool_calls:[{index:0,id:'tool-'+tools.length,type:'function',function:call}]}:{content:'See [Official](https://1.1.1.1/docs).'};
 let out='';for(const choice of [{delta,finish_reason:null},{delta:{},finish_reason:call?'tool_calls':'stop'}])out+='data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',model:'test',choices:[{index:0,...choice}]})+'\n\n';
 return new Response(out+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
 };`
	if err := os.WriteFile(preload, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NODE_OPTIONS", "--require="+preload)
	calls := []string{}
	chat := &chatInput{server: s, DocumentID: "doc", SessionID: "", Question: "Find official docs", Agent: a, WebSearch: true, WebAPI: APIConnection{URL: "https://search.example/gateway/v1", Key: "search-secret"}, webTransport: webRoundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "search.example" || !strings.HasPrefix(r.URL.Path, "/gateway/v1/tools/") || r.Header.Get("Authorization") != "Bearer search-secret" {
			t.Fatal("search connection was mixed with the model connection")
		}
		calls = append(calls, r.URL.Path)
		if strings.HasSuffix(r.URL.Path, "search") {
			return webJSON(200, `{}`), nil
		}
		return webJSON(200, `{"title":"Official","content":"Verified public page text"}`), nil
	})}
	result, err := streamPiChat(t.Context(), APIConnection{URL: "https://model.example/v1", Key: "model-secret"}, completionRequest{Model: "test", Tools: true, ContextWindow: 64000}, AIInput{Prompt: chat.Question, Chat: chat}, nil)
	if err != nil || !strings.Contains(result.Text, "https://1.1.1.1/docs") || len(calls) != 1 {
		t.Fatal("model should finish after receiving budget notice", err, result.Text, calls)
	}
	if err := s.saveDocumentAgentAnswer(t.Context(), a, result.Text, "api"); err != nil {
		t.Fatal("final answer was not saved", err)
	}
	history, err := s.Store.chatHistory("doc")
	if err != nil || len(history) != 1 || !strings.Contains(history[0].Content, "Official") {
		t.Fatal("completed answer missing from history", history, err)
	}
}

func TestWebToolUsesExtendedDeadline(t *testing.T) {
	c := &chatInput{WebSearch: true, webTransport: webRoundTrip(func(r *http.Request) (*http.Response, error) {
		deadline, ok := r.Context().Deadline()
		if !ok || time.Until(deadline) < 119*time.Second || time.Until(deadline) > 2*time.Minute {
			t.Errorf("unexpected web deadline %v", deadline)
		}
		return webJSON(200, `{"results":[]}`), nil
	})}
	if _, err := c.callWebTool(context.Background(), APIConnection{URL: "https://api.deepseek.com", Key: "test"}, "web_search", json.RawMessage(`{"query":"test"}`)); err != nil {
		t.Fatal(err)
	}
}

func TestPiOversizedToolArgumentsLetModelFinish(t *testing.T) {
	piTestRuntime(t)
	s, a := originalDocumentFixture(t)
	preload := filepath.Join(t.TempDir(), "mock-model.cjs")
	script := `globalThis.fetch=async function(url,init){
 if(new Headers(init.headers).get('authorization')!=='Bearer model-secret')throw new Error('model credential missing');
 const p=JSON.parse(init.body),tools=p.messages.filter(m=>m.role==='tool');
 if(init.body.includes('search-secret'))throw new Error('search key leaked to model');
 if(!p.tools?.some(t=>t.function.name==='web_search'))throw new Error('web tool missing');
 if(tools.length && !/validation|invalid|error/i.test(tools.at(-1).content))throw new Error('missing budget notice');
 const call=tools.length===0?{name:'web_search',arguments:JSON.stringify({query:'x'.repeat(5000)})}:null;
 const delta=call?{tool_calls:[{index:0,id:'tool-'+tools.length,type:'function',function:call}]}:{content:'See [Official](https://1.1.1.1/docs).'};
 let out='';for(const choice of [{delta,finish_reason:null},{delta:{},finish_reason:call?'tool_calls':'stop'}])out+='data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',model:'test',choices:[{index:0,...choice}]})+'\n\n';
 return new Response(out+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
 };`
	if err := os.WriteFile(preload, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NODE_OPTIONS", "--require="+preload)
	calls := []string{}
	chat := &chatInput{server: s, DocumentID: "doc", SessionID: "", Question: "Find official docs", Agent: a, WebSearch: true, WebAPI: APIConnection{URL: "https://search.example/gateway/v1", Key: "search-secret"}, webTransport: webRoundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "search.example" || !strings.HasPrefix(r.URL.Path, "/gateway/v1/tools/") || r.Header.Get("Authorization") != "Bearer search-secret" {
			t.Fatal("search connection was mixed with the model connection")
		}
		calls = append(calls, r.URL.Path)
		if strings.HasSuffix(r.URL.Path, "search") {
			return webJSON(200, `{}`), nil
		}
		return webJSON(200, `{"title":"Official","content":"Verified public page text"}`), nil
	})}
	result, err := streamPiChat(t.Context(), APIConnection{URL: "https://model.example/v1", Key: "model-secret"}, completionRequest{Model: "test", Tools: true, ContextWindow: 64000}, AIInput{Prompt: chat.Question, Chat: chat}, nil)
	if err != nil || !strings.Contains(result.Text, "https://1.1.1.1/docs") || len(calls) != 0 {
		t.Fatal("model should finish after receiving budget notice", err, result.Text, calls)
	}
	if err := s.saveDocumentAgentAnswer(t.Context(), a, result.Text, "api"); err != nil {
		t.Fatal("final answer was not saved", err)
	}
	history, err := s.Store.chatHistory("doc")
	if err != nil || len(history) != 1 || !strings.Contains(history[0].Content, "Official") {
		t.Fatal("completed answer missing from history", history, err)
	}
}
