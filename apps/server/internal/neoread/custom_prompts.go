package neoread

import "strings"

// Match the chat endpoint's UTF-8 byte limit, rather than UTF-16 input lengths.
func validChatPromptPreferences(v map[string]any) string {
	items, ok := v["prompts"].([]any)
	if !ok || len(items) > 50 {
		return "常用 prompt 列表格式无效或超过 50 条"
	}
	seen := make(map[string]bool)
	for _, item := range items {
		p, ok := item.(map[string]any)
		if !ok {
			return "常用 prompt 格式无效"
		}
		id, idOK := p["id"].(string)
		description, descriptionOK := p["description"].(string)
		prompt, promptOK := p["prompt"].(string)
		if !idOK || strings.TrimSpace(id) == "" || len(id) > 128 || seen[id] ||
			!descriptionOK || strings.TrimSpace(description) == "" || len(description) > 320 ||
			!promptOK || strings.TrimSpace(prompt) == "" || len(prompt) > 16000 {
			return "常用 prompt 内容无效，提示词最多 16000 UTF-8 字节"
		}
		seen[id] = true
	}
	return ""
}
