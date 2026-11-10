package neoread

// Store only page references. Rehydrate image bytes at the provider boundary,
// not in SQLite, usage logs, compact prompts or the public chat transcript.
func pageImageMessages(req completionRequest, messages []toolCompletionMessage) ([]toolCompletionMessage, error) {
	wire := append([]toolCompletionMessage(nil), messages...)
	for i, m := range wire {
		if len(m.PageImages) == 0 {
			continue
		}
		if !req.Vision || req.PageImageData == nil {
			return nil, generationError(ErrorCapability, "当前聊天模型未通过图片能力检测，请使用支持读图的模型")
		}
		parts := []any{map[string]any{"type": "text", "text": m.Content}}
		for _, page := range m.PageImages {
			data, err := req.PageImageData(page)
			if err != nil {
				return nil, err
			}
			parts = append(parts, map[string]any{"type": "text", "text": "[" + page.SourceID + "] " + pageEvidence(page).Text}, map[string]any{"type": "image_url", "image_url": map[string]string{"url": imageData(data), "detail": "high"}})
		}
		wire[i].PageImages = nil
		wire[i].Content = parts
	}
	return wire, nil
}
