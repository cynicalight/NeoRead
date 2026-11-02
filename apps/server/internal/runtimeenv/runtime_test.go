package runtimeenv

import (
	"context"
	"net/http"
	"os"
	"testing"
	"time"
)

func setup(t *testing.T) *Runtime {
	t.Helper()
	for key := range networkKeys {
		t.Setenv(key, "")
	}
	t.Setenv("PATH", os.Getenv("PATH"))
	previous := Default
	Default = New(true)
	r := Default
	t.Cleanup(func() { r.Stop(); Default = previous })
	return r
}
func str(value string) *string { return &value }
func TestIndependentNetworkAndPath(t *testing.T) {
	r := setup(t)
	req, _ := http.NewRequest("GET", "https://example.com", nil)
	network := make(chan error, 1)
	go func() {
		proxy, err := Proxy(req)
		if err == nil && (proxy == nil || proxy.Host != "127.0.0.1:12345") {
			t.Error("wrong proxy")
		}
		network <- err
	}()
	select {
	case <-network:
		t.Fatal("network did not wait")
	case <-time.After(20 * time.Millisecond):
	}
	if err := r.Apply("network", map[string]*string{"HTTPS_PROXY": str("http://127.0.0.1:12345")}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-network:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("network blocked on PATH")
	}
	binary, _ := os.Executable()
	found := make(chan error, 1)
	go func() { _, err := LookPath(context.Background(), binary); found <- err }()
	select {
	case <-found:
		t.Fatal("lookup did not wait")
	case <-time.After(20 * time.Millisecond):
	}
	if err := r.Apply("path", map[string]*string{"PATH": str(os.Getenv("PATH"))}); err != nil {
		t.Fatal(err)
	}
	if err := <-found; err != nil {
		t.Fatal(err)
	}
}
func TestValidationAndOneTimeApplication(t *testing.T) {
	r := setup(t)
	if err := r.Apply("path", map[string]*string{"PATH": str("changed"), "HOME": str("injected")}); err == nil {
		t.Fatal("accepted arbitrary variable")
	}
	if os.Getenv("PATH") == "changed" {
		t.Fatal("partial change")
	}
	if err := r.Apply("path", map[string]*string{"PATH": str(os.Getenv("PATH"))}); err != nil {
		t.Fatal(err)
	}
	if err := r.Apply("path", map[string]*string{"PATH": str("replacement")}); err == nil {
		t.Fatal("accepted replacement")
	}
}
func TestLoopbackAndCancellation(t *testing.T) {
	r := setup(t)
	req, _ := http.NewRequest("GET", "http://127.0.0.1:1234", nil)
	if proxy, err := Proxy(req); err != nil || proxy != nil {
		t.Fatal(proxy, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := LookPath(ctx, "missing-cli"); err != context.Canceled {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- CommandContext(context.Background(), "missing-cli").Err }()
	r.Stop()
	select {
	case err := <-done:
		if err != context.Canceled {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown left a waiter")
	}
}

func TestWindowsProxyAliasesAreAppliedOnce(t *testing.T) {
	for _, input := range []map[string]*string{
		{"HTTPS_PROXY": str("http://proxy:8080"), "https_proxy": nil},
		{"HTTPS_PROXY": nil, "https_proxy": str("http://proxy:8080")},
	} {
		result := networkEnvironment(input, true)
		if len(result) != 4 || result["HTTPS_PROXY"] == nil || *result["HTTPS_PROXY"] != "http://proxy:8080" {
			t.Fatal(result)
		}
		if _, exists := result["https_proxy"]; exists {
			t.Fatal("duplicate alias")
		}
	}
}
