package neoread

import (
	"context"
	"neoread.local/server/internal/runtimeenv"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestThemeAvailableBeforeRecovery(t *testing.T) {
	s := testServer(t)
	_, err := s.Store.DB.Exec(`INSERT OR REPLACE INTO settings(key,value) VALUES('neoread','{"appearance":"dark"}')`)
	if err != nil {
		t.Fatal(err)
	}
	ready := make(chan struct{})
	s.processingReady = ready
	if err := s.PrepareStartupSettings(); err != nil {
		t.Fatal(err)
	}
	// Hold the only DB connection as recovery would; startup theme uses snapshot.
	connection, err := s.Store.DB.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	result := request(t, s, "GET", "/api/settings?startup=1", nil)
	connection.Close()
	if result.Code != 200 || !strings.Contains(result.Body.String(), "dark") {
		t.Fatal(result.Body.String())
	}
	if result := request(t, s, "GET", "/api/documents", nil); result.Code != 200 {
		t.Fatal(result.Code)
	}
	done := make(chan int, 1)
	go func() { done <- request(t, s, "PUT", "/api/preferences/library", strings.NewReader(`{}`)).Code }()
	select {
	case <-done:
		t.Fatal("library API raced recovery")
	case <-time.After(20 * time.Millisecond):
	}
	close(ready)
	select {
	case code := <-done:
		if code != 200 {
			t.Fatal(code)
		}
	case <-time.After(time.Second):
		t.Fatal("library remained blocked")
	}
}
func TestDesktopRuntimeRequiresAuthenticationAndValidStage(t *testing.T) {
	t.Setenv("PATH", os.Getenv("PATH"))
	previous := runtimeenv.Default
	runtimeenv.Default = runtimeenv.New(true)
	t.Cleanup(func() { runtimeenv.Default.Stop(); runtimeenv.Default = previous })
	s := testServer(t)
	r := httptest.NewRequest("POST", "http://127.0.0.1:17840/api/desktop-runtime/path", strings.NewReader(`{"PATH":"injected"}`))
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
	if result := request(t, s, "POST", "/api/desktop-runtime/path", strings.NewReader(`{"HOME":"injected"}`)); result.Code != 400 {
		t.Fatal(result.Code)
	}
	if result := request(t, s, "POST", "/api/desktop-runtime/path", strings.NewReader(`{"PATH":"safe-test-path"}`)); result.Code != 200 {
		t.Fatal(result.Code)
	}
	if os.Getenv("PATH") != "safe-test-path" {
		t.Fatal("PATH not applied")
	}
	if result := request(t, s, "POST", "/api/desktop-runtime/path", strings.NewReader(`{"PATH":"replacement"}`)); result.Code != 400 {
		t.Fatal("accepted duplicate", result.Code)
	}
}
func TestAsyncProcessingStopsBeforeStoreClosure(t *testing.T) {
	s := testServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	stop := s.StartProcessingAsync(ctx)
	cancel()
	done := make(chan struct{})
	go func() { stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("workers did not stop")
	}
	// idempotent stop is safe for error and shutdown paths.
	stop()
}
