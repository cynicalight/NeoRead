package reader

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestSelectionTranslationBoundsAndCompletion(t *testing.T) {
	g := &GenerationService{primary: "codex", connections: map[string]generationConnection{}}
	g.connections["codex"] = generationConnection{VerifiedText: true, Adapter: adapterFunc(func(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
		if !req.Input.SourceOnly || req.Input.Chat != nil {
			t.Fatal("selection translation must use an isolated source-only request")
		}
		var input selectionTranslationInput
		if err := json.Unmarshal([]byte(strings.SplitN(req.Input.Prompt, "资料：\n", 2)[1]), &input); err != nil {
			t.Fatal(err)
		}
		if input.Text != "selected" || len(strings.Fields(input.Before)) != 30 || len(strings.Fields(input.After)) != 30 || !strings.HasSuffix(input.Before, "nearest") || !strings.HasPrefix(input.After, "nearest") {
			t.Fatalf("unexpected context: %+v", input)
		}
		if err := emit(ProviderEvent{Text: "译文"}); err != nil {
			return GenerateResult{}, err
		}
		return GenerateResult{Text: "译文", FinishReason: "stop"}, nil
	})}
	text, err := generateSelectionTranslation(t.Context(), g, selectionTranslationInput{Text: "selected", Before: strings.Repeat("far ", 100) + "nearest", After: "nearest " + strings.Repeat("far ", 100)})
	if err != nil || text != "译文" {
		t.Fatalf("%q %v", text, err)
	}
}

func TestSelectionTranslationRejectsFailedPartialAndCancellation(t *testing.T) {
	for _, canceled := range []bool{false, true} {
		g := &GenerationService{primary: "codex", connections: map[string]generationConnection{}}
		g.connections["codex"] = generationConnection{VerifiedText: true, Adapter: adapterFunc(func(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
			if canceled {
				<-ctx.Done()
				return GenerateResult{}, ctx.Err()
			}
			return GenerateResult{Text: "partial"}, errors.New("interrupted")
		})}
		ctx, cancel := context.WithCancel(t.Context())
		if canceled {
			cancel()
		}
		text, err := generateSelectionTranslation(ctx, g, selectionTranslationInput{Text: "selected"})
		cancel()
		if err == nil || text != "" {
			t.Fatalf("accepted failed result: %q %v", text, err)
		}
	}
}
func TestSelectionTranslationValidation(t *testing.T) {
	s := testServer(t)
	for _, body := range []string{`{"text":" "}`, `{"text":"` + strings.Repeat("a", 12001) + `"}`, `{"text":"hello","unexpected":true}`} {
		if w := request(t, s, "POST", "/api/translate-selection", strings.NewReader(body)); w.Code != 400 {
			t.Fatalf("status %d: %s", w.Code, w.Body.String())
		}
	}
	if got := nearbySelectionWords(strings.Repeat("中", 80), true); got != strings.Repeat("中", 30) {
		t.Fatal(got)
	}
}
