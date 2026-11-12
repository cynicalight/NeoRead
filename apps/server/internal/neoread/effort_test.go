package neoread

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestEffortPersistsAndRejectsNativeOnlyValues(t *testing.T) {
	s := testServer(t)
	c := AIConfig{Primary: "codex", Models: map[string]string{"codex": "model"}, Efforts: map[string]map[string]string{"codex": {"model": "max"}}}
	if r := request(t, s, "PUT", "/api/ai/config", configJSON(c)); r.Code != 200 {
		t.Fatal(r.Body)
	}
	if got := s.aiConfig().Efforts["codex"]["model"]; got != "max" {
		t.Fatal(got)
	}
	// An older settings client omitting the optional field must not erase it.
	c.Efforts = nil
	if r := request(t, s, "PUT", "/api/ai/config", configJSON(c)); r.Code != 200 {
		t.Fatal(r.Body)
	}
	if got := s.aiConfig().Efforts["codex"]["model"]; got != "max" {
		t.Fatal("effort lost", got)
	}
	for _, value := range []string{"xhigh", "ultra", "on", "invalid"} {
		c.Efforts = map[string]map[string]string{"codex": {"model": value}}
		if r := request(t, s, "PUT", "/api/ai/config", configJSON(c)); r.Code != 400 {
			t.Fatalf("accepted %s: %s", value, r.Body)
		}
	}
}

func configJSON(c AIConfig) *bytes.Reader { b, _ := json.Marshal(c); return bytes.NewReader(b) }
