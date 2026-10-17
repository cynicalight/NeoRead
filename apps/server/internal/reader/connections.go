package reader

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

type APIConnection struct {
	Protocol string `json:"protocol,omitempty"`
	URL      string `json:"url"`
	Model    string `json:"model"`
	Key      string `json:"key,omitempty"`
	HasKey   bool   `json:"hasKey"`
}
type Capability struct {
	Tools             string `json:"tools,omitempty"`
	ToolSchemaVersion string `json:"toolSchemaVersion,omitempty"`
	ToolError         string `json:"toolError,omitempty"`
	PendingVision     bool   `json:"pendingVision,omitempty"`
	Text              bool   `json:"text"`
	Vision            bool   `json:"vision"`
	CheckedAt         string `json:"checkedAt"`
	Error             string `json:"error,omitempty"`
	Fingerprint       string `json:"-"`
}
type AIConfig struct {
	Primary string                       `json:"primary"`
	Models  map[string]string            `json:"models"`
	Efforts map[string]map[string]string `json:"efforts,omitempty"`
	// Translation choices are independent of chat. An empty model means
	// Reader picks the fast tier from the live catalog.
	TranslationModels  map[string]string            `json:"translationModels,omitempty"`
	TranslationEfforts map[string]map[string]string `json:"translationEfforts,omitempty"`
	TranslationPrompt  *string                      `json:"translationPrompt,omitempty"`
	// The API agent also picks a model for image input. Other agents send
	// images to their chat model.
	VisionModels  map[string]string            `json:"visionModels,omitempty"`
	VisionEfforts map[string]map[string]string `json:"visionEfforts,omitempty"`
	// API is the endpoint of the "api" agent; API.Model is unused. APIModels
	// are model IDs the user added beside the endpoint's /models list.
	API          APIConnection         `json:"api"`
	APIModels    []string              `json:"apiModels"`
	TextAPI      APIConnection         `json:"textAPI"`
	ImageAPI     APIConnection         `json:"imageAPI"`
	Capabilities map[string]Capability `json:"capabilities"`
}
type savedConfig struct {
	Config       AIConfig          `json:"config"`
	Fingerprints map[string]string `json:"fingerprints"`
}
type AIInput struct {
	SourceOnly    bool
	ContextInfo   func(window, used int)
	UsageSink     func(UsageCall) error
	UsageProvider string
	Chat          *chatInput
	Effort        string
	Prompt        string
	Image         []byte
	Images        [][]byte
}

func (in AIInput) images() [][]byte {
	if len(in.Images) > 0 {
		return in.Images
	}
	if len(in.Image) > 0 {
		return [][]byte{in.Image}
	}
	return nil
}

type AIResult struct {
	Reasoning string
	Text      string
	Provider  string
	Fallback  bool
}

func validAgent(p string) bool { return p == "codex" || p == "claude" || p == "kimi" || p == "api" }
func (s *Server) aiConfig() AIConfig {
	s.configMu.Lock()
	defer s.configMu.Unlock()
	return s.readAIConfig()
}
func (s *Server) readAIConfig() AIConfig {
	c := AIConfig{Models: map[string]string{}, Capabilities: map[string]Capability{}}
	b, err := os.ReadFile(filepath.Join(s.Store.Root, "ai-connections.json"))
	if err != nil {
		return c
	}
	var stored savedConfig
	if json.Unmarshal(b, &stored) != nil {
		return c
	}
	c = stored.Config
	if c.Models == nil {
		c.Models = map[string]string{}
	}
	if c.Capabilities == nil {
		c.Capabilities = map[string]Capability{}
	}
	if c.APIModels == nil {
		c.APIModels = []string{}
	}
	for k, v := range c.Capabilities {
		v.Fingerprint = stored.Fingerprints[k]
		if v.ToolSchemaVersion != documentToolSchemaVersion {
			v.Tools = ""
			v.ToolError = ""
			v.ToolSchemaVersion = ""
		}
		c.Capabilities[k] = v
	}
	return c
}
func (s *Server) writeAIConfig(c AIConfig) error {
	saved := savedConfig{Config: c, Fingerprints: map[string]string{}}
	for k, v := range c.Capabilities {
		saved.Fingerprints[k] = v.Fingerprint
	}
	b, e := json.MarshalIndent(saved, "", "  ")
	if e != nil {
		return e
	}
	return atomicFile(filepath.Join(s.Store.Root, "ai-connections.json"), b)
}
func atomicFile(path string, b []byte) error {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".write-*")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if _, e = f.Write(b); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	return os.Rename(name, path)
}
func configPrint(c AIConfig, p string) string {
	var value any
	if p == "text-api" {
		value = c.TextAPI
	} else if p == "image-api" {
		value = c.ImageAPI
	} else if model, ok := strings.CutPrefix(p, "api:"); ok {
		value = []string{"api", c.API.URL, c.API.Key, c.API.Protocol, apiRulesVersion, model}
	} else if p == "api" {
		// Checked per model, never as a whole.
		return ""
	} else {
		path, _ := exec.LookPath(p)
		value = []string{p, path, c.Models[p]}
	}
	b, _ := json.Marshal(value)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func capable(c AIConfig, p string, vision bool) bool {
	if p == "api" {
		return apiCapable(c, taskChat, false) && (!vision || apiCapable(c, taskChat, true))
	}
	v := c.Capabilities[p]
	return v.Fingerprint == configPrint(c, p) && v.Text && (!vision || v.Vision)
}
func publicConfig(c AIConfig) AIConfig {
	c.API.HasKey = c.API.Key != ""
	c.API.Key = ""
	c.TextAPI.HasKey = c.TextAPI.Key != ""
	c.TextAPI.Key = ""
	c.ImageAPI.HasKey = c.ImageAPI.Key != ""
	c.ImageAPI.Key = ""
	return c
}
func validateAPI(c APIConnection) error {
	if e := validateAPIProtocol(c.Protocol); e != nil {
		return e
	}
	if c.URL == "" && c.Model == "" && c.Key == "" {
		return nil
	}
	if e := validateAPIURL(c.URL); e != nil {
		return e
	}
	if strings.TrimSpace(c.Model) == "" {
		return errors.New("请填写 API 模型")
	}
	return nil
}

// The API agent chooses models per task, so only the endpoint is required.
func validateAgentAPI(c APIConnection) error {
	if e := validateAPIProtocol(c.Protocol); e != nil {
		return e
	}
	if c.URL == "" && c.Key == "" {
		return nil
	}
	return validateAPIURL(c.URL)
}
func validateAPIProtocol(protocol string) error {
	if protocol != "" && protocol != "auto" && protocol != "openai" && protocol != "anthropic" {
		return errors.New("无效的 API 协议")
	}
	return nil
}
func validateAPIURL(raw string) error {
	u, e := url.Parse(raw)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("API 地址无效")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) {
		return errors.New("API 需要 HTTPS，本机服务可使用 HTTP")
	}
	return nil
}
func (s *Server) getAIConfig(w http.ResponseWriter, r *http.Request) {
	respond(w, 200, publicConfig(s.aiConfig()))
}

// Runtime failures invalidate only the request's configuration and capability
// revision. A late failure must not overwrite a new model or a newer manual test.
func (s *Server) recordCapabilityFailure(snapshot AIConfig, provider string, vision bool, failure error) error {
	s.configMu.Lock()
	defer s.configMu.Unlock()
	latest := s.readAIConfig()
	cap := latest.Capabilities[provider]
	if configPrint(latest, provider) != configPrint(snapshot, provider) || cap.CheckedAt != snapshot.Capabilities[provider].CheckedAt {
		return nil
	}
	cap.Vision = false
	cap.PendingVision = false
	if !vision {
		cap.Text = false
	}
	cap.Error = failure.Error()
	cap.CheckedAt = now()
	cap.Fingerprint = configPrint(latest, provider)
	latest.Capabilities[provider] = cap
	return s.writeAIConfig(latest)
}
func (s *Server) putAIConfig(w http.ResponseWriter, r *http.Request) {
	var c AIConfig
	if !decode(w, r, &c) {
		return
	}
	if c.Primary != "" && !validAgent(c.Primary) {
		fail(w, 400, "请选择主 Agent")
		return
	}
	if c.TranslationPrompt != nil {
		value := strings.TrimSpace(*c.TranslationPrompt)
		if utf8.RuneCountInString(value) > 6000 {
			fail(w, 400, "翻译提示词不能超过 6000 个字符")
			return
		}
		c.TranslationPrompt = &value
	}
	for _, efforts := range []map[string]map[string]string{c.Efforts, c.TranslationEfforts, c.VisionEfforts} {
		for provider, models := range efforts {
			for _, effort := range models {
				if !validEffort(provider, effort) {
					fail(w, 400, "无效的 Effort 档位")
					return
				}
			}
		}
	}
	s.configMu.Lock()
	defer s.configMu.Unlock()
	old := s.readAIConfig()
	if c.TranslationPrompt == nil {
		c.TranslationPrompt = old.TranslationPrompt
	}
	if c.Efforts == nil {
		c.Efforts = old.Efforts
	}
	if c.TranslationModels == nil {
		c.TranslationModels = old.TranslationModels
	}
	if c.TranslationEfforts == nil {
		c.TranslationEfforts = old.TranslationEfforts
	}
	if c.VisionModels == nil {
		c.VisionModels = old.VisionModels
	}
	if c.VisionEfforts == nil {
		c.VisionEfforts = old.VisionEfforts
	}
	if c.APIModels == nil {
		c.APIModels = old.APIModels
	}
	added := []string{}
	for _, id := range c.APIModels {
		id = strings.TrimSpace(id)
		if id != "" && !slices.Contains(added, id) {
			added = append(added, id)
		}
	}
	if len(added) > 50 || slices.ContainsFunc(added, func(id string) bool { return len(id) > 200 }) {
		fail(w, 400, "手动添加的模型过多或名称过长")
		return
	}
	c.APIModels = added
	// Omitted keys preserve secrets; hasKey=false plus empty key explicitly clears one.
	if c.TextAPI.Key == "" && c.TextAPI.HasKey {
		c.TextAPI.Key = old.TextAPI.Key
	}
	if c.ImageAPI.Key == "" && c.ImageAPI.HasKey {
		c.ImageAPI.Key = old.ImageAPI.Key
	}
	if c.API.Key == "" && c.API.HasKey {
		c.API.Key = old.API.Key
	}
	c.API.URL = strings.TrimSpace(c.API.URL)
	c.API.Key = strings.TrimSpace(c.API.Key)
	c.API.Model = ""
	c.API.HasKey = false
	c.TextAPI.HasKey = false
	c.ImageAPI.HasKey = false
	if e := validateAgentAPI(c.API); e != nil {
		fail(w, 400, e.Error())
		return
	}
	for _, a := range []APIConnection{c.TextAPI, c.ImageAPI} {
		if e := validateAPI(a); e != nil {
			fail(w, 400, e.Error())
			return
		}
	}
	c.Capabilities = old.Capabilities
	if c.Models == nil {
		c.Models = map[string]string{}
	}
	for k, v := range c.Capabilities {
		if v.Fingerprint != configPrint(c, k) {
			delete(c.Capabilities, k)
		}
	}
	if e := s.writeAIConfig(c); e != nil {
		fail(w, 500, "无法保存连接配置")
		return
	}
	respond(w, 200, publicConfig(c))
	s.wakeProcessing()
}
func (s *Server) testConnection(w http.ResponseWriter, r *http.Request) {
	p := r.PathValue("provider")
	if !validAgent(p) && p != "text-api" && p != "image-api" {
		fail(w, 400, "未知连接")
		return
	}
	if p == "api" {
		// The API agent is checked one model at a time.
		model := strings.TrimSpace(r.URL.Query().Get("model"))
		if model == "" || len(model) > 200 {
			fail(w, 400, "请选择要检测的 API 模型")
			return
		}
		p = apiCapabilityKey(model)
	}
	mode := r.URL.Query().Get("capability")
	if mode == "tools" {
		s.testDocumentToolConnection(w, r, p)
		return
	}
	if mode != "" && mode != "text" && mode != "vision" || mode == "vision" && p == "text-api" {
		fail(w, 400, "无效的检测能力")
		return
	}
	c := s.aiConfig()
	fingerprint := configPrint(c, p)
	cap := Capability{CheckedAt: now(), Fingerprint: fingerprint}
	if previous := c.Capabilities[p]; previous.Fingerprint == fingerprint {
		cap.Tools, cap.ToolError = previous.Tools, previous.ToolError
		cap.ToolSchemaVersion = previous.ToolSchemaVersion
	}
	if mode == "vision" {
		if !capable(c, p, false) {
			fail(w, 409, "请先完成文本检测")
			return
		}
		cap.Text = true
	} else {
		// A completed, nonempty model response establishes text availability.
		// Formatting and CLI subscription-login metadata are not capability gates.
		answer, err := s.probeConnection(r.Context(), c, p, AIInput{Prompt: "Reply with exactly READER_OK. Do not use any tools."}, 45*time.Second)
		if err != nil {
			cap.Error = err.Error()
		} else if strings.TrimSpace(answer) == "" {
			cap.Error = "测试未返回文字"
		} else {
			cap.Text = true
		}
	}
	cap.PendingVision = mode == "text" && cap.Text && p != "text-api"
	if cap.Text && p != "text-api" && mode != "text" {
		// The challenge still requires evidence from pixels; tolerate prose/formatting.
		data, expected, probeErr := visionProbe()
		if probeErr != nil {
			cap.Error = "无法生成图片测试"
		} else {
			answer, err := s.probeConnection(r.Context(), c, p, AIInput{Prompt: visionPrompt, Image: data}, 90*time.Second)
			if err != nil {
				cap.Error = "文字可用；识图测试失败：" + err.Error()
			} else if !matchesVisionProbe(answer, expected) {
				cap.Error = "文字可用；识图测试未通过"
			} else {
				cap.Vision = true
			}
		}
	}
	if r.Context().Err() != nil {
		return
	}
	s.configMu.Lock()
	latest := s.readAIConfig()
	if configPrint(latest, p) != fingerprint || latest.Capabilities[p].CheckedAt != c.Capabilities[p].CheckedAt {
		s.configMu.Unlock()
		fail(w, 409, "配置已改变，请重新检测")
		return
	}
	latest.Capabilities[p] = cap
	err := s.writeAIConfig(latest)
	s.configMu.Unlock()
	if err != nil {
		fail(w, 500, "无法保存测试结果")
		return
	}
	respond(w, 200, cap)
	s.wakeProcessing()
}

// CLI probes use model defaults. API probes exercise saved reasoning settings;
// catalog failures still allow a selected model to be tested.
func (s *Server) probeConnection(parent context.Context, c AIConfig, p string, in AIInput, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	model := c.Models[p]
	if model == "" && validAgent(p) {
		// Test the model chat will actually use. Catalog failure keeps the CLI default.
		if models, err := s.modelCatalog(ctx, p); err == nil {
			model = defaultTaskModel(taskChat, p, models)
		}
	}
	var adapter Adapter = cliAdapter{s.Store.Root, p, model}
	if model, ok := strings.CutPrefix(p, "api:"); ok {
		// Exercise the same parameter builder as generation, including the
		// saved effort. A successful probe establishes acceptance, not efficacy.
		efforts, selected := c.Efforts, c.Models["api"]
		if len(in.images()) > 0 {
			efforts, selected = c.VisionEfforts, c.VisionModels["api"]
		}
		effort := efforts["api"][model]
		if selected == "" && efforts["api"][""] != "" {
			effort = efforts["api"][""]
		}
		if effort == "" {
			effort = "medium"
		}
		choice := apiModelChoice{model, effort}
		adapter = apiAgentAdapter{c.API, choice, choice, taskChat, s.apiCatalog(c.API)}
	}
	if p == "text-api" {
		adapter = apiAdapter{c.TextAPI}
	}
	if p == "image-api" {
		adapter = apiAdapter{c.ImageAPI}
	}
	result, err := adapter.Stream(ctx, GenerateRequest{Input: in}, nil)
	if ctx.Err() == context.DeadlineExceeded {
		return "", errors.New("检测超时，请检查网络或模型后重试")
	}
	return result.Text, err
}

var visionColorNames = regexp.MustCompile(`(?i)\b(?:red|blue|green|yellow)\b`)

func matchesVisionProbe(answer, expected string) bool {
	return strings.Join(visionColorNames.FindAllString(strings.ToUpper(answer), -1), " ") == expected
}

func (s *Server) generate(ctx context.Context, in AIInput, delta func(string), fallback func(string)) (AIResult, error) {
	return s.generateWithConfig(ctx, s.aiConfig(), in, delta, fallback)
}
func (s *Server) generateWithConfig(ctx context.Context, c AIConfig, in AIInput, delta func(string), fallback func(string)) (AIResult, error) {
	return s.generationService(c).generate(ctx, in, false, delta != nil, legacyEmitter(delta, fallback))
}
func (s *Server) invoke(ctx context.Context, c AIConfig, p string, in AIInput, delta func(string)) (string, error) {
	service := s.generationService(c)
	conn, ok := service.connections[p]
	if !ok {
		return "", generationError(ErrorConfiguration, "未知连接")
	}
	result, err := conn.Adapter.Stream(ctx, GenerateRequest{Input: in}, legacyEmitter(delta, nil))
	return result.Text, err
}

func validEffort(provider, effort string) bool {
	return validAgent(provider) && (effort == "low" || effort == "medium" || effort == "high" || effort == "max")
}

const visionPrompt = "Inspect the attached image. It contains one horizontal row of 8 colored squares. Reply with exactly 8 uppercase color names in left-to-right order, separated by single spaces. Allowed names: RED BLUE GREEN YELLOW. No punctuation or tools."

func visionProbe() ([]byte, string, error) {
	choices := make([]byte, 8)
	if _, err := rand.Read(choices); err != nil {
		return nil, "", err
	}
	colors := []color.RGBA{{230, 30, 30, 255}, {25, 70, 235, 255}, {30, 175, 65, 255}, {245, 210, 20, 255}}
	names := []string{"RED", "BLUE", "GREEN", "YELLOW"}
	im := image.NewRGBA(image.Rect(0, 0, 800, 140))
	for y := 0; y < 140; y++ {
		for x := 0; x < 800; x++ {
			im.Set(x, y, color.White)
		}
	}
	answer := make([]string, 8)
	for i, v := range choices {
		choice := int(v) % 4
		answer[i] = names[choice]
		for y := 30; y < 110; y++ {
			for x := i*100 + 10; x < i*100+90; x++ {
				im.Set(x, y, colors[choice])
			}
		}
	}
	var data bytes.Buffer
	if err := png.Encode(&data, im); err != nil {
		return nil, "", err
	}
	return data.Bytes(), strings.Join(answer, " "), nil
}
