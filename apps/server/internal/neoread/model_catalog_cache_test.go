package neoread

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestModelCatalogCacheLifetimeAndRefresh(t *testing.T) {
	for _, key := range []string{"codex", "claude", "kimi", "api:connection"} {
		t.Run(key, func(t *testing.T) {
			s := &Server{}
			calls := 0
			discover := func(context.Context) ([]AgentModel, error) {
				calls++
				return []AgentModel{{ID: "model"}}, nil
			}
			for range 2 {
				if _, err := s.cachedCatalog(t.Context(), key, discover); err != nil {
					t.Fatal(err)
				}
			}
			if calls != 1 {
				t.Fatalf("fresh catalog loaded %d times", calls)
			}
			remaining := time.Until(s.modelCache[key].expires)
			if remaining < 24*time.Hour-time.Minute || remaining > 24*time.Hour {
				t.Fatalf("TTL=%s", remaining)
			}
			entry := s.modelCache[key]
			entry.expires = time.Now().Add(-time.Second)
			s.modelCache[key] = entry
			if _, err := s.cachedCatalog(t.Context(), key, discover); err != nil {
				t.Fatal(err)
			}
			if calls != 1 {
				t.Fatal("ordinary read refreshed expired catalog")
			}
			forced := context.WithValue(t.Context(), refreshModelCatalogKey{}, true)
			if _, err := s.cachedCatalog(forced, key, discover); err != nil {
				t.Fatal(err)
			}
			if calls != 2 {
				t.Fatal("settings did not refresh expired cache")
			}
			if _, err := s.cachedCatalog(forced, key, discover); err != nil || calls != 2 {
				t.Fatal("settings refreshed fresh cache", err)
			}
			entry = s.modelCache[key]
			entry.expires = time.Now().Add(-time.Second)
			s.modelCache[key] = entry
			failure := errors.New("discovery failed")
			if _, err := s.cachedCatalog(forced, key, func(context.Context) ([]AgentModel, error) { return nil, failure }); !errors.Is(err, failure) {
				t.Fatal(err)
			}
			if _, err := s.cachedCatalog(t.Context(), key, discover); err != nil {
				t.Fatal(err)
			}
			if calls != 2 {
				t.Fatal("failed refresh erased valid cache")
			}
		})
	}
}

func TestModelCatalogConcurrentDiscoveryAndCanceledWaiter(t *testing.T) {
	s := &Server{}
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	discover := func(context.Context) ([]AgentModel, error) {
		if calls.Add(1) == 1 {
			close(started)
		}
		<-release
		return []AgentModel{{ID: "model"}}, nil
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); _, _ = s.cachedCatalog(t.Context(), "codex", discover) }()
	<-started
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := s.cachedCatalog(canceled, "codex", discover); !errors.Is(err, context.Canceled) {
		t.Fatalf("waiting cancellation=%v", err)
	}
	for range 8 {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = s.cachedCatalog(t.Context(), "codex", discover) }()
	}
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("concurrent discoveries=%d", calls.Load())
	}
}

func TestModelCatalogReadOnlyAndCanceledOwner(t *testing.T) {
	s := &Server{}
	started := make(chan context.Context, 1)
	release := make(chan struct{})
	var calls atomic.Int32
	discover := func(ctx context.Context) ([]AgentModel, error) {
		calls.Add(1)
		started <- ctx
		<-release
		return []AgentModel{{ID: "model"}}, ctx.Err()
	}
	readonly := context.WithValue(t.Context(), cachedModelsOnlyKey{}, true)
	if models, err := s.cachedCatalog(readonly, "codex", discover); err != nil || len(models) != 0 || calls.Load() != 0 {
		t.Fatal("read-only initialized discovery", err)
	}
	owner, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { _, err := s.cachedCatalog(owner, "codex", discover); done <- err }()
	loadCtx := <-started
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if loadCtx.Err() != nil {
		t.Fatal("owner canceled shared discovery")
	}
	deadline, ok := loadCtx.Deadline()
	if !ok || time.Until(deadline) > 20*time.Second {
		t.Fatal("unbounded shared discovery")
	}
	close(release)
	models, err := s.cachedCatalog(t.Context(), "codex", discover)
	if err != nil || len(models) != 1 || calls.Load() != 1 {
		t.Fatal("other waiter lost shared result", models, err)
	}
}
