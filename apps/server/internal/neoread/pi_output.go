package neoread

import (
	"bufio"
	"context"
	"io"
	"sync"
)

type piOutputFrame struct {
	line []byte
	err  error
}

// Always drain stdout independently of tool execution and stdin writes.
// In particular, Windows workers can synchronously write a checkpoint while
// the host returns a PDF image. Reading only after the reply would deadlock.
type piOutputReader struct {
	mu      sync.Mutex
	pending []piOutputFrame
	ready   chan struct{}
	done    chan struct{}
}

func newPiOutputReader(output io.Reader) *piOutputReader {
	r := &piOutputReader{ready: make(chan struct{}, 1), done: make(chan struct{})}
	go func() {
		defer close(r.done)
		reader := bufio.NewReader(output)
		for {
			line, err := reader.ReadBytes('\n')
			r.mu.Lock()
			r.pending = append(r.pending, piOutputFrame{line, err})
			r.mu.Unlock()
			select {
			case r.ready <- struct{}{}:
			default:
			}
			if err != nil {
				return
			}
		}
	}()
	return r
}

func (r *piOutputReader) next(ctx context.Context) ([]byte, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		r.mu.Lock()
		if len(r.pending) > 0 {
			frame := r.pending[0]
			r.pending[0] = piOutputFrame{}
			r.pending = r.pending[1:]
			if len(r.pending) == 0 {
				r.pending = nil
			}
			r.mu.Unlock()
			return frame.line, frame.err
		}
		r.mu.Unlock()
		select {
		case <-r.ready:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}
