package reader

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestReaderLayoutSettingsSurviveReopen(t *testing.T) {
	s := testServer(t)
	settings := `{"zoom":1.4,"readerLayout":{"navigationWidth":21,"assistantWidth":32,"navigationOpen":false,"assistantOpen":true,"sourceWidth":63,"swapped":true}}`
	w := request(t, s, "PUT", "/api/settings", strings.NewReader(settings))
	if w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	s.Close()
	if err := s.Store.DB.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(s.Store.Root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.DB.Close() })
	reopened := NewServer(store, "test-secret", "")
	t.Cleanup(reopened.Close)
	w = request(t, reopened, "GET", "/api/settings", nil)
	if w.Code != 200 {
		t.Fatalf("reload: %d %s", w.Code, w.Body.String())
	}
	var got, want map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(settings), &want); err != nil {
		t.Fatal(err)
	}
	actual, _ := json.Marshal(got)
	expected, _ := json.Marshal(want)
	if string(actual) != string(expected) {
		t.Fatalf("settings changed after reopening: %s", actual)
	}
}
