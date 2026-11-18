package neoread

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A worker can emit another large checkpoint while Go returns PDF images for
// an earlier tool. Windows stdout pipes are synchronous: both directions must
// keep draining or the worker and host can block each other indefinitely.
func TestPiWorkerDrainsCheckpointWhileReturningLargeToolResult(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "ai-work"), 0700); err != nil {
		t.Fatal(err)
	}
	script := `
import { createInterface } from 'node:readline';
import { writeSync } from 'node:fs';
const rl = createInterface({input:process.stdin});
let runId='', result=false, ack=false;
function send(event) {
 const data=Buffer.from(JSON.stringify({version:1,runId,...event})+'\n');
 for(let offset=0;offset<data.length;) offset+=writeSync(1,data,offset,data.length-offset);
}

rl.on('line', line => {
 const m=JSON.parse(line);
 if(m.type==='start') {
  runId=m.input.runId;
  send({type:'tool',id:'pdf',name:'read_pdf_pages',args:{}});
  send({type:'checkpoint',id:'checkpoint-next',entries:[{type:'message',payload:'c'.repeat(2*1024*1024)}],canContinue:false});
 } else if(m.type==='toolResult') {
  if(m.content[0].text.length!==2*1024*1024) process.exit(2);
  result=true;
 } else if(m.type==='checkpointAck') ack=true;
 if(result && ack) { send({type:'complete',text:'done',entries:[]}); rl.close();process.stdin.destroy(); }
});`
	worker := filepath.Join(root, "backpressure.mjs")
	if err := os.WriteFile(worker, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEOREAD_AGENT", worker)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	checkpoints, tools := 0, 0
	result, err := runPiWorker(ctx, root, piRequest{Version: 1, RunID: "backpressure", Key: "PRIVATE_PI_KEY", Prompt: "PRIVATE_PI_PROMPT", DurableCheckpoints: true}, func(e piEvent) error {
		if e.Type == "checkpoint" {
			checkpoints++
		}
		return nil
	}, func(string, json.RawMessage) ([]any, error) {
		tools++
		return []any{map[string]string{"type": "text", "text": strings.Repeat("p", 2<<20)}}, nil
	})
	if err != nil || result.Text != "done" || checkpoints != 1 || tools != 1 {
		t.Fatalf("pipe round trip stalled: checkpoints=%d tools=%d text=%q err=%v", checkpoints, tools, result.Text, err)
	}
	for _, expected := range []string{`"pi.worker.send"`, `"kind":"toolResult"`, `"phase":"finish"`} {
		if !strings.Contains(logs.String(), expected) {
			t.Fatalf("missing safe pipe diagnostic %s", expected)
		}
	}
	if strings.Contains(logs.String(), "PRIVATE_PI_") || strings.Contains(logs.String(), strings.Repeat("p", 100)) {
		t.Fatal("pipe diagnostics leaked request/result content")
	}
}

func TestPiOutputReaderPreservesQueuedFramesAndEOF(t *testing.T) {
	var source strings.Builder
	for i := 0; i < 1000; i++ {
		fmt.Fprintf(&source, "%d\n", i)
	}
	r := newPiOutputReader(strings.NewReader(source.String()))
	<-r.done // The producer must drain even before the consumer starts reading.
	for i := 0; i < 1000; i++ {
		line, err := r.next(t.Context())
		if err != nil || string(line) != fmt.Sprintf("%d\n", i) {
			t.Fatalf("frame %d lost/reordered: %q %v", i, line, err)
		}
	}
	if line, err := r.next(t.Context()); len(line) != 0 || err != io.EOF {
		t.Fatalf("EOF lost: %q %v", line, err)
	}
}

func TestPiOutputReaderCancellationUnblocksWait(t *testing.T) {
	reader, writer := io.Pipe()
	r := newPiOutputReader(reader)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := r.next(ctx); err != context.Canceled {
		t.Fatal(err)
	}
	writer.Close()
	<-r.done
}
