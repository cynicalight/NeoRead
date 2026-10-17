package reader

import (
	"strings"
	"testing"
)

func TestTranslationPromptAsksForKaTeXInlineMath(t *testing.T) {
	prompt := translationPrompt(Document{Title: "t"}, layoutManifest{Pages: 1}, translationBatch{}, "")
	for _, rule := range []string{"KaTeX", "$T_i$", `\\ll`, `\\$`, "不要输出 $$", "sentences.source 仍按原文复制"} {
		if !strings.Contains(prompt, rule) {
			t.Fatalf("prompt lacks %q", rule)
		}
	}
}

func TestTranslationKeepsEscapedKaTeXInTarget(t *testing.T) {
	line := `{"sentences":[{"source":"Let T be the followers of t in MVSG.","target":"令 $T_i$ 为 $t_i$ 在 $MVSG(s, \\ll)$ 中的后继，费用为 \\$5。"}]}`
	sentences, err := parseTranslation(line, "Let T be the followers of t in MVSG.")
	if err != nil {
		t.Fatal(err)
	}
	if want := `令 $T_i$ 为 $t_i$ 在 $MVSG(s, \ll)$ 中的后继，费用为 \$5。`; sentences[0].Target != want {
		t.Fatalf("target %q", sentences[0].Target)
	}
}
