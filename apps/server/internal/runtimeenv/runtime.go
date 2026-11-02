// Package runtimeenv coordinates the desktop's one-time background environment
// discovery. Local HTTP handlers never wait here; outbound requests and child
// processes wait only when they need the corresponding environment.
package runtimeenv

import (
	"context"
	"errors"
	"golang.org/x/net/http/httpproxy"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

type Runtime struct {
	enabled             bool
	mu                  sync.Mutex
	network, path       chan struct{}
	stopped             chan struct{}
	stopOnce            sync.Once
	networkSet, pathSet bool
}

var Default = New(false)

func New(enabled bool) *Runtime {
	r := &Runtime{enabled: enabled, network: make(chan struct{}), path: make(chan struct{}), stopped: make(chan struct{})}
	if !enabled {
		close(r.network)
		close(r.path)
	}
	return r
}
func (r *Runtime) Enabled() bool { return r.enabled }
func (r *Runtime) Stop()         { r.stopOnce.Do(func() { close(r.stopped) }) }
func (r *Runtime) wait(ctx context.Context, ready <-chan struct{}) error {
	select {
	case <-ready:
		return nil
	default:
	}
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	select {
	case <-ready:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-r.stopped:
		return context.Canceled
	case <-timer.C:
		return errors.New("启动环境尚未就绪，请稍后重试")
	}
}

var networkKeys = map[string]bool{"HTTP_PROXY": true, "HTTPS_PROXY": true, "ALL_PROXY": true, "NO_PROXY": true, "http_proxy": true, "https_proxy": true, "all_proxy": true, "no_proxy": true}

// Apply accepts only a fixed set of variables, once per startup stage. Validate
// the entire payload before changing anything; never log its private values.
func (r *Runtime) Apply(stage string, values map[string]*string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.enabled {
		return errors.New("desktop runtime disabled")
	}
	if stage != "network" && stage != "path" {
		return errors.New("invalid runtime stage")
	}
	if stage == "network" && r.networkSet || stage == "path" && r.pathSet {
		return errors.New("runtime already configured")
	}
	if stage == "path" && (len(values) != 1 || values["PATH"] == nil || *values["PATH"] == "") {
		return errors.New("invalid PATH")
	}
	for key, value := range values {
		if (stage == "path" && key != "PATH") || (stage == "network" && !networkKeys[key]) {
			return errors.New("invalid runtime key")
		}
		if value != nil && strings.ContainsRune(*value, 0) {
			return errors.New("invalid runtime value")
		}
	}
	if stage == "network" {
		values = networkEnvironment(values, runtime.GOOS == "windows")
	}

	for key, value := range values {
		if value == nil {
			_ = os.Unsetenv(key)
		} else if err := os.Setenv(key, *value); err != nil {
			return err
		}
	}
	if stage == "network" {
		r.networkSet = true
		close(r.network)
	} else {
		r.pathSet = true
		close(r.path)
	}
	return nil
}

// Windows environment names are case-insensitive. Collapse aliases before
// writing so a nil lowercase value cannot erase its uppercase counterpart.
func networkEnvironment(values map[string]*string, windows bool) map[string]*string {
	out := make(map[string]*string)
	if windows {
		for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"} {
			value := values[key]
			if value == nil {
				value = values[strings.ToLower(key)]
			}
			out[key] = value
		}
	} else {
		for key := range networkKeys {
			out[key] = values[key]
		}
	}
	return out
}

func Proxy(request *http.Request) (*url.URL, error) {
	host := request.URL.Hostname()
	if host == "localhost" || net.ParseIP(host).IsLoopback() {
		return nil, nil
	}
	if err := Default.wait(request.Context(), Default.network); err != nil {
		return nil, err
	}
	// Avoid net/http's process-wide environment cache before desktop discovery.
	return httpproxy.FromEnvironment().ProxyFunc()(request.URL)
}
func LookPath(ctx context.Context, name string) (string, error) {
	if err := Default.wait(ctx, Default.path); err != nil {
		return "", err
	}
	return exec.LookPath(name)
}
func CommandContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	err := Default.wait(ctx, Default.path)
	if err == nil {
		err = Default.wait(ctx, Default.network)
	}
	cmd := exec.CommandContext(ctx, name, args...)
	if err != nil {
		cmd.Err = err
	}
	return cmd
}
func Command(name string, args ...string) *exec.Cmd {
	return CommandContext(context.Background(), name, args...)
}
