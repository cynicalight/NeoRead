package neoread

import (
	"context"
	"crypto/subtle"
	"errors"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type documentToolBinding struct {
	mu      sync.Mutex
	agent   *documentAgent
	attempt string
}

func (b *documentToolBinding) bind(a *documentAgent) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.agent = a
	b.attempt = ""
	if a != nil {
		b.attempt = a.ID
	}
}
func (b *documentToolBinding) current() (*documentAgent, string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.agent, b.attempt
}
func serveDocumentMCP(agent *documentAgent) (string, string, func(), error) {
	return serveBoundDocumentMCP(&documentToolBinding{agent: agent, attempt: agent.ID})
}
func serveBoundDocumentMCP(binding *documentToolBinding) (string, string, func(), error) {
	instructions := documentReadingInstructions
	if agent, _ := binding.current(); agent != nil && agent.chat != nil {
		instructions = webInstructions(instructions, agent.chat.WebSearch)
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "neoread_document", Version: "1.0.0"}, &mcp.ServerOptions{Instructions: instructions})
	for _, definition := range documentToolDefinitions {
		d := definition
		server.AddTool(&mcp.Tool{Name: d.Name, Description: d.Description, InputSchema: d.Schema, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			agent, attempt := binding.current()
			if agent == nil {
				return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "No active NeoRead turn"}}}, nil
			}
			agent.mu.Lock()
			stale := attempt != "" && attempt != agent.ID
			agent.mu.Unlock()
			if stale {
				return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "文档工具尝试已结束"}}}, nil
			}
			ctx, cancel := context.WithCancel(ctx)
			stop := context.AfterFunc(agent.ctx, cancel)
			defer cancel()
			defer stop()
			raw, err := agent.callAttempt(ctx, attempt, d.Name, req.Params.Arguments)
			if err != nil {
				if errors.Is(err, errDocumentAttemptEnded) {
					return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "文档工具尝试已结束"}}}, nil
				}
				if errors.Is(err, errDocumentReadingBudget) {
					return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: `{"shouldFinish":true,"message":"Prioritize essential evidence and complete the answer promptly; disclose gaps."}`}}}, nil
				}
				if ctx.Err() != nil && agent.ctx.Err() == nil {
					return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "Tool request was interrupted; use available evidence or try another approach."}}}, nil
				}
				if result, fatal := agent.toolFailure(ctx, err); fatal == nil {
					return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: string(result)}}}, nil
				}
				agent.mu.Lock()
				abort := agent.abort
				agent.mu.Unlock()
				if abort != nil {
					abort()
				}
				return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: err.Error()}}}, nil
			}

			content := []mcp.Content{&mcp.TextContent{Text: string(raw)}}
			for _, page := range resultPageImages(raw) {
				data, err := agent.pageImageData(page)
				if err != nil {
					failure, fatal := agent.toolFailure(ctx, err)
					if fatal != nil {
						return nil, fatal
					}
					return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: string(failure)}}}, nil
				}
				content = append(content, &mcp.TextContent{Text: "[" + page.SourceID + "] " + pageEvidence(page).Text}, &mcp.ImageContent{Data: data, MIMEType: "image/png"})
			}
			return &mcp.CallToolResult{Content: content}, nil
		})
	}
	token := id() + id()
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, MaxRequestBodyBytes: 16 << 10})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", "", nil, err
	}
	httpServer := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/mcp" {
			http.NotFound(w, r)
			return
		}
		if agent, _ := binding.current(); agent != nil && agent.ctx.Err() != nil {
			http.Error(w, "unauthorized", 401)
			return
		}
		if subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")), []byte(token)) != 1 {
			http.Error(w, "unauthorized", 401)
			return
		}
		if r.Header.Get("Origin") != "" {
			http.Error(w, "invalid origin", 403)
			return
		}
		handler.ServeHTTP(w, r)
	})}
	go httpServer.Serve(listener)
	return "http://" + listener.Addr().String() + "/mcp", token, func() { _ = httpServer.Close() }, nil
}
