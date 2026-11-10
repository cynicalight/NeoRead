package neoread

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPiDocumentToolFailureReturnsSafeResultAndContinues(t *testing.T) {
	piTestRuntime(t)
	s, agent := prepareConversationFixture(t)
	if _, err := s.Store.DB.Exec("DROP TABLE document_passages_fts"); err != nil {
		t.Fatal(err)
	}
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		calls++
		if calls == 1 {
			writeToolReply(w, "search_document", `{"query":"cobalt"}`)
			return
		}
		if !strings.Contains(string(raw), "tool_failed") || strings.Contains(string(raw), "document_passages_fts") {
			t.Error("tool failure not safely refilled")
		}
		writeAPIReply(w, "依据已有摘录回答。")
	}))
	defer upstream.Close()
	chat := &chatInput{server: s, Agent: agent, DocumentID: "doc", Question: "解释", CurrentText: "用户摘录"}
	result, err := streamPiChat(t.Context(), APIConnection{URL: upstream.URL, Key: "fixture"}, completionRequest{Model: "test", Tools: true, ContextWindow: 32000}, AIInput{Chat: chat}, nil)
	if err != nil || calls != 2 || result.Text != "依据已有摘录回答。" || len(agent.conversation.PiEntries) == 0 {
		t.Fatalf("result=%+v err=%v calls=%d", result, err, calls)
	}
	if len(chat.Tools) != 1 || strings.Contains(chat.Tools[0].Detail, "document_passages_fts") {
		t.Fatalf("unsafe tool activity: %+v", chat.Tools)
	}
}

func TestPiOversizedArgumentsReturnResultWithoutExecuting(t *testing.T) {
	piTestRuntime(t)
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "ai-work"), 0700); err != nil {
		t.Fatal(err)
	}
	worker := filepath.Join(root, "worker.mjs")
	script := `import {createInterface} from 'node:readline';const lines=createInterface({input:process.stdin});let runId='';const send=(e)=>process.stdout.write(JSON.stringify({version:1,runId,...e})+'\n');lines.on('line',line=>{const m=JSON.parse(line);if(m.type==='start'){runId=m.input.runId;send({type:'tool',id:'large',name:'read_passage',args:{blockId:'x'.repeat(5000)}})}else{const text=JSON.stringify(m.content);if(!text.includes('invalid_arguments'))process.exit(2);send({type:'complete',text:'done',entries:[]});lines.close();process.exit(0)}});`
	if err := os.WriteFile(worker, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEOREAD_AGENT", worker)
	executed := 0
	result, err := runPiWorker(t.Context(), root, piRequest{Version: 1, RunID: "run"}, nil, func(string, json.RawMessage) ([]any, error) { executed++; return nil, nil })
	if err != nil || result.Text != "done" || executed != 0 {
		t.Fatalf("result=%+v err=%v executed=%d", result, err, executed)
	}
}

func TestPiWorkerCorrelationFailuresRemainFatal(t *testing.T) {
	piTestRuntime(t)
	for _, mode := range []string{"empty-id", "wrong-run", "duplicate-id"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			if err := os.MkdirAll(filepath.Join(root, "ai-work"), 0700); err != nil {
				t.Fatal(err)
			}
			worker := filepath.Join(root, "worker.mjs")
			script := `import {createInterface} from 'node:readline';const lines=createInterface({input:process.stdin});let runId='';const mode=` + jsonText(mode) + `;const send=(e)=>process.stdout.write(JSON.stringify({version:1,runId,...e})+'\n');lines.on('line',line=>{const m=JSON.parse(line);if(m.type==='start'){runId=m.input.runId;send({type:'tool',id:mode==='empty-id'?'':'same',runId:mode==='wrong-run'?'other':runId,name:'get_outline',args:{}})}else{send({type:'tool',id:'same',name:'get_outline',args:{}})}});`
			if err := os.WriteFile(worker, []byte(script), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("NEOREAD_AGENT", worker)
			_, err := runPiWorker(t.Context(), root, piRequest{Version: 1, RunID: "run"}, nil, func(string, json.RawMessage) ([]any, error) {
				return []any{map[string]string{"type": "text", "text": "ok"}}, nil
			})
			if errorKind(err) != ErrorProtocol {
				t.Fatalf("correlation failure recovered: %v", err)
			}
		})
	}
}

func TestDocumentToolFailurePreservesInvalidationAndSaveErrors(t *testing.T) {
	_, a := originalDocumentFixture(t)
	for _, failure := range []error{errDocumentAttemptEnded, generationError(ErrorSave, "private storage detail")} {
		raw, fatal := a.toolFailure(t.Context(), failure)
		if fatal != failure || len(raw) != 0 {
			t.Fatalf("fatal error recovered: raw=%s err=%v", raw, fatal)
		}
	}
	a.fatal = generationError(ErrorProtocol, "document revision invalidated")
	if raw, fatal := a.toolFailure(t.Context(), a.fatal); fatal == nil || len(raw) != 0 {
		t.Fatalf("invalidation recovered: raw=%s err=%v", raw, fatal)
	}
}
