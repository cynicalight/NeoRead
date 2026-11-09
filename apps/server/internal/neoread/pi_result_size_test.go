package neoread

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPiCompletePreservesLargeToolHistoryAndAnswer(t *testing.T) {
	piTestRuntime(t)
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "ai-work"), 0700); err != nil {
		t.Fatal(err)
	}
	worker := filepath.Join(root, "large.mjs")
	script := `import {createInterface} from 'node:readline';const rl=createInterface({input:process.stdin});rl.once('line',line=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({version:1,runId:m.input.runId,type:'complete',text:'x'.repeat(1024*1024+1),entries:[{type:'message',payload:'y'.repeat(41*1024*1024)}]})+'\n',()=>{rl.close();process.stdin.destroy()})});`
	if err := os.WriteFile(worker, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEOREAD_AGENT", worker)
	result, err := runPiWorker(t.Context(), root, piRequest{Version: 1, RunID: "large"}, nil, nil)
	if err != nil || len(result.Text) != 1<<20+1 || len(result.Entries) < 41<<20 {
		t.Fatalf("large complete rejected: text=%d entries=%d err=%v", len(result.Text), len(result.Entries), err)
	}
}
func TestChatRunKeepsLargeValidEventHistory(t *testing.T) {
	cancelled := false
	r := &chatRun{changed: make(chan struct{}), cancel: func() { cancelled = true }}
	for i := 0; i < 9; i++ {
		if err := r.send("delta", map[string]string{"text": strings.Repeat("x", 1<<20)}); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.send("done", map[string]bool{"ok": true}); err != nil || cancelled || len(r.events) != 9 || r.terminal == nil {
		t.Fatalf("valid history rejected: %v canceled=%v", err, cancelled)
	}
}

// 旧 fixture scanner 的容量仅用于测试进程，不参与实际供应商读取。
const maxProviderFrame = 8 << 20

func TestProviderLineReaderRetainsLargeJSONLine(t *testing.T) {
	text := strings.Repeat("x", 9<<20)
	r := &providerLineReader{reader: bufio.NewReader(strings.NewReader(text + "\r\n"))}
	if !r.Scan() || string(r.Bytes()) != text || r.Scan() || r.Err() != nil {
		t.Fatal("provider line was truncated")
	}
}
