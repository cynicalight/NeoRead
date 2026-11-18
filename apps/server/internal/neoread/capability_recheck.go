package neoread

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

// A failed answer from a built-in agent checks its connection again in the
// background so Settings shows the current state. Requests never wait for it.
const capabilityRecheckInterval = time.Minute

type capabilityRecheck struct {
	running  bool
	finished time.Time
}

func (s *Server) recheckAfterFailure(provider string, err error) {
	if _, native := piProviders[provider]; !native || !piConnected(s.aiConfig(), provider) {
		return
	}
	kind := errorKind(err)
	switch kind {
	// The user, a local limit or the content stopped the answer, not the connection.
	case ErrorCanceled, ErrorBusy, ErrorSave, ErrorLimit, ErrorContext, ErrorContent, ErrorCapability:
		return
	}
	s.capabilityRecheckMu.Lock()
	if s.capabilityRechecks == nil {
		s.capabilityRechecks = map[string]capabilityRecheck{}
	}
	last := s.capabilityRechecks[provider]
	// Batch work can fail repeatedly; one check per interval is enough.
	if last.running || time.Since(last.finished) < capabilityRecheckInterval {
		s.capabilityRecheckMu.Unlock()
		return
	}
	s.capabilityRechecks[provider] = capabilityRecheck{running: true}
	s.capabilityRecheckMu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		previous := s.aiConfig().Capabilities[provider]
		started := time.Now()
		result, checkErr := s.probeCapability(ctx, provider, "", 45*time.Second, 90*time.Second)
		level, code := slog.LevelInfo, ""
		switch {
		case errors.Is(checkErr, errProbeStale):
			level, code = slog.LevelWarn, "stale"
		case checkErr != nil:
			level, code = slog.LevelWarn, string(errorKind(checkErr))
		}
		s.diagnosticEvent(level, "agent.capability.recheck", "provider", provider, "trigger", kind,
			"durationMs", time.Since(started).Milliseconds(), "saved", checkErr == nil,
			"previousText", previous.Text, "previousVision", previous.Vision,
			"text", result.Text, "vision", result.Vision, "errorCode", code)
		s.capabilityRecheckMu.Lock()
		s.capabilityRechecks[provider] = capabilityRecheck{finished: time.Now()}
		s.capabilityRecheckMu.Unlock()
	}()
}
