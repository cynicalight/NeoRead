package neoread

import (
	"strings"
	"testing"
)

func TestTranslationPromptAsksForKaTeXInlineMath(t *testing.T) {
	prompt := translationPrompt(Document{Title: "t"}, layoutManifest{Pages: 1}, translationBatch{}, "")
	for _, rule := range []string{"KaTeX", `\\ll`, `\\$`, "不要输出 $$", "行内数学是例外", "source 与 target 中对应的数学须写成相同的 $...$", "恢复可确定的上下标", "相邻公式间保留空格"} {
		if !strings.Contains(prompt, rule) {
			t.Fatalf("prompt lacks %q", rule)
		}
	}
	// The verbatim rule must not also tell the model to keep formulas as extracted.
	if strings.Contains(prompt, "公式和符号保持原样") || strings.Contains(prompt, "无法确定的符号照抄原文") {
		t.Fatal("PDF prompt contradicts the inline math rule")
	}
	// EPUB source is verbatim, so it never carries LaTeX.
	epub := translationPrompt(Document{Title: "t", Type: "epub"}, layoutManifest{Pages: 1}, translationBatch{}, "")
	if !strings.Contains(epub, "sentences.source 必须逐字保留") || !strings.Contains(epub, "source 不写成 LaTeX") || strings.Contains(epub, "行内数学是例外") {
		t.Fatal("EPUB prompt must keep source verbatim")
	}
}

func TestTranslationAcceptsKaTeXSourceWithExtractedAnchors(t *testing.T) {
	source := "Keys have dimension d , and values have dimension √ d . We then apply the softmax k v function."
	raw := `{"sentences":[{"source":"Keys have dimension $d_k$, and values have dimension $\\sqrt{d_v}$.","target":"键的维度为 $d_k$，值的维度为 $\\sqrt{d_v}$。"},{"source":"We then apply the softmax function.","target":"然后应用 softmax 函数。"}]}`
	sentences, err := parseTranslation(raw, source)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sentences[0].Source, `\sqrt{d_v}`) || sentences[0].Anchor == "" {
		t.Fatalf("source keeps KaTeX and the anchor keeps extracted text: %+v", sentences[0])
	}
	joined := sentences[0].Anchor + sentences[1].Anchor
	if strings.Join(strings.Fields(joined), "") != strings.Join(strings.Fields(source), "") {
		t.Fatalf("anchors must cover the extracted paragraph: %q", joined)
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

func TestComparableLettersIgnoreKaTeXCommands(t *testing.T) {
	if got := string(comparableLetters(`dot $\frac{1}{\sqrt{d_k}}$`)); got != "dotdk" {
		t.Fatalf("letters %q", got)
	}
}

func TestSimilarTextIgnoresGreekVariablesOnBothSides(t *testing.T) {
	if !similarText(`Let $\alpha, \beta, \gamma, \delta, \epsilon, \zeta, \eta, \theta$.`, "Let α, β, γ, δ, ε, ζ, η, θ.") {
		t.Fatal("restored Greek variables must match the extracted Greek letters")
	}
}
