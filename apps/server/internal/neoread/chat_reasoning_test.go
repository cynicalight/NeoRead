package neoread

import "testing"

func TestVisibleReasoningDropsLineBreaksOnly(t *testing.T) {
	if got := visibleReasoning("\n\n\n"); got != "" {
		t.Fatalf("visibleReasoning(line breaks) = %q", got)
	}
	if got := visibleReasoning("\nCheck the source.\n"); got != "\nCheck the source.\n" {
		t.Fatalf("visibleReasoning(text) = %q", got)
	}
}
