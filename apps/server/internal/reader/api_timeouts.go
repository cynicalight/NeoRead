package reader

import (
	"context"
	"sync"
	"time"
)

type apiTimeoutKey struct{}
type apiDefaultTimeoutKey struct{}

// Observe adapter events; heartbeat frames and usage metadata are not progress.
func withAPIRequestTimeouts(parent context.Context, c APIConnection, emit func(ProviderEvent) error, run func(context.Context, func(ProviderEvent) error) (GenerateResult, error)) (GenerateResult, error) {
	if parent.Value(apiTimeoutKey{}) != nil {
		return run(parent, emit)
	}
	ctx, cancel := context.WithCancelCause(context.WithValue(parent, apiTimeoutKey{}, true))
	defer cancel(nil)
	var mu sync.Mutex
	stopped, started := false, false
	last := time.Now()
	timers := []*time.Timer{}
	var idleTimer *time.Timer
	schedule := func(seconds int, message string, idle bool) {
		if seconds <= 0 {
			return
		}
		duration := time.Duration(seconds) * time.Second
		var timer *time.Timer
		timer = time.AfterFunc(duration, func() {
			mu.Lock()
			defer mu.Unlock()
			if stopped {
				return
			}
			if idle {
				if !started {
					return
				}
				remaining := duration - time.Since(last)
				if remaining > 0 {
					timer.Reset(remaining)
					return
				}
			}
			if message == "首个输出" && started {
				return
			}
			cancel(generationError(ErrorTimeout, "API "+message+"超时，请调整请求时限后重试"))
		})
		timers = append(timers, timer)
		if idle {
			idleTimer = timer
		}
	}
	schedule(c.FirstOutputTimeoutSeconds, "首个输出", false)
	schedule(c.IdleTimeoutSeconds, "空闲", true)
	total := c.TotalTimeoutSeconds
	if total == 0 {
		if fallback, ok := parent.Value(apiDefaultTimeoutKey{}).(time.Duration); ok {
			total = int(fallback / time.Second)
		}
	}
	schedule(total, "总时限", false)
	send := func(e ProviderEvent) error {
		if e.Text != "" || e.Reasoning != "" || e.Draft != "" || e.ToolProgress {
			mu.Lock()
			if !started && idleTimer != nil {
				idleTimer.Reset(time.Duration(c.IdleTimeoutSeconds) * time.Second)
			}
			started = true
			last = time.Now()
			mu.Unlock()
		}
		if emit != nil {
			return emit(e)
		}
		return nil
	}
	result, err := run(ctx, send)
	mu.Lock()
	stopped = true
	for _, timer := range timers {
		timer.Stop()
	}
	mu.Unlock()
	if parent.Err() != nil {
		return result, parent.Err()
	}
	if cause := context.Cause(ctx); cause != nil {
		return result, cause
	}
	return result, err
}

// Configured API limits must not be truncated by Reader's outer default limits.
func apiOuterTimeout(c AIConfig, fallback time.Duration) time.Duration {
	if c.Primary != "api" {
		return fallback
	}
	for _, p := range apiProviders(c) {
		if d := time.Duration(p.Connection.TotalTimeoutSeconds) * time.Second; d > fallback {
			fallback = d + time.Second
		}
		for _, o := range p.ModelOverrides {
			if d := time.Duration(o.TotalTimeoutSeconds) * time.Second; d > fallback {
				fallback = d + time.Second
			}
		}
	}
	return fallback
}
