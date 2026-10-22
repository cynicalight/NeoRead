package scholar

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCrossrefEmailAndRateLimit(t *testing.T) {
	for _, email := range []string{"", "reader+papers@example.com"} {
		t.Run(email, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/crossref/10.1234/test" {
					if got := r.URL.Query().Get("mailto"); got != email {
						t.Errorf("mailto = %q", got)
					}
					w.WriteHeader(429)
					return
				}
				if r.URL.Query().Has("mailto") {
					t.Error("email leaked to another service")
				}
				http.NotFound(w, r)
			}))
			defer upstream.Close()
			c := New(1024)
			c.AllowPrivateHosts = true
			c.Crossref, c.SemanticScholar = upstream.URL+"/crossref/", upstream.URL+"/s2/"
			c.CrossrefEmail = email
			_, err := c.Lookup(context.Background(), Identifiers{DOI: "10.1234/test"})
			if err == nil || !strings.Contains(err.Error(), "Crossref 服务商限制") {
				t.Fatalf("error = %v", err)
			}
			if strings.Contains(err.Error(), "设置 →") != (email == "") {
				t.Fatalf("wrong guidance: %v", err)
			}
		})
	}
}

func TestSemanticScholarRateLimitDoesNotSuggestEmail(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(429) }))
	defer upstream.Close()
	c := New(1024)
	c.AllowPrivateHosts = true
	c.SemanticScholar = upstream.URL + "/"
	_, err := c.Lookup(context.Background(), Identifiers{Title: "Attention Is All You Need"})
	if err == nil || strings.Contains(err.Error(), "邮箱") {
		t.Fatalf("error = %v", err)
	}
}
