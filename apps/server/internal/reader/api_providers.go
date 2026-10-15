package reader

import (
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strings"
)

// Raw legacy references always belong to default, even after that provider is deleted.
const defaultAPIProviderID = "default"

type APIModelOverride struct {
	TextProbeTimeoutSeconds   int `json:"textProbeTimeoutSeconds,omitempty"`
	VisionProbeTimeoutSeconds int `json:"visionProbeTimeoutSeconds,omitempty"`
	FirstOutputTimeoutSeconds int `json:"firstOutputTimeoutSeconds,omitempty"`
	IdleTimeoutSeconds        int `json:"idleTimeoutSeconds,omitempty"`
	TotalTimeoutSeconds       int `json:"totalTimeoutSeconds,omitempty"`
}
type APIProvider struct {
	ID             string                      `json:"id"`
	Name           string                      `json:"name"`
	Connection     APIConnection               `json:"connection"`
	Models         []string                    `json:"models"`
	EnabledModels  []string                    `json:"enabledModels,omitzero"`
	ModelOverrides map[string]APIModelOverride `json:"modelOverrides,omitempty"`
}

func apiModelRef(provider, model string) string {
	if provider == defaultAPIProviderID && !strings.Contains(model, "::") {
		return model
	}
	return provider + "::" + model
}
func splitAPIModelRef(ref string) (string, string) {
	if provider, model, ok := strings.Cut(ref, "::"); ok {
		return provider, model
	}
	return defaultAPIProviderID, ref
}
func apiProviders(c AIConfig) []APIProvider {
	if c.APIProviders != nil {
		return c.APIProviders
	}
	return []APIProvider{{ID: defaultAPIProviderID, Name: "API", Connection: c.API, Models: c.APIModels, EnabledModels: c.APIEnabledModels}}
}
func resolveAPIProvider(c AIConfig, ref string) (APIProvider, string, bool) {
	if c.APIProviders == nil {
		return apiProviders(c)[0], ref, true
	}
	id, model := splitAPIModelRef(ref)
	for _, p := range apiProviders(c) {
		if p.ID == id {
			p.Connection = effectiveAPIConnection(p.Connection, p.ModelOverrides[model])
			return p, model, true
		}
	}
	return APIProvider{}, model, false
}
func effectiveAPIConnection(c APIConnection, o APIModelOverride) APIConnection {
	for _, pair := range [][2]*int{{&c.TextProbeTimeoutSeconds, &o.TextProbeTimeoutSeconds}, {&c.VisionProbeTimeoutSeconds, &o.VisionProbeTimeoutSeconds}, {&c.FirstOutputTimeoutSeconds, &o.FirstOutputTimeoutSeconds}, {&c.IdleTimeoutSeconds, &o.IdleTimeoutSeconds}, {&c.TotalTimeoutSeconds, &o.TotalTimeoutSeconds}} {
		if *pair[1] > 0 {
			*pair[0] = *pair[1]
		}
	}
	return c
}
func migrateAPIProviders(c *AIConfig) {
	if c.APIProviders != nil {
		projectLegacyAPI(c)
		return
	}
	c.APIProviders = apiProviders(*c)
	// Old literal IDs containing our delimiter must be wrapped, never interpreted.
	convert := func(ref string) string {
		if strings.Contains(ref, "::") {
			return defaultAPIProviderID + "::" + ref
		}
		return ref
	}
	for _, models := range []map[string]string{c.Models, c.TranslationModels, c.VisionModels} {
		if models["api"] != "" {
			models["api"] = convert(models["api"])
		}
	}
	for _, efforts := range []map[string]map[string]string{c.Efforts, c.TranslationEfforts, c.VisionEfforts} {
		if efforts["api"] == nil {
			continue
		}
		migrated := make(map[string]string, len(efforts["api"]))
		for model, level := range efforts["api"] {
			migrated[convert(model)] = level
		}
		efforts["api"] = migrated
	}
	migrated := make(map[string]Capability, len(c.Capabilities))
	for key, cap := range c.Capabilities {
		if model, ok := strings.CutPrefix(key, "api:"); ok {
			key = apiCapabilityKey(convert(model))
		}
		migrated[key] = cap
	}
	c.Capabilities = migrated
}

// Legacy fields are a projection only. Modern writes always take apiProviders as authoritative.
func projectLegacyAPI(c *AIConfig) {
	c.API = APIConnection{}
	c.APIModels = []string{}
	c.APIEnabledModels = []string{}
	for _, p := range c.APIProviders {
		if p.ID == defaultAPIProviderID {
			c.API = p.Connection
			c.APIModels = p.Models
			c.APIEnabledModels = p.EnabledModels
			return
		}
	}
}

var providerIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,80}$`)

func prepareAPIProviders(c *AIConfig, old AIConfig) error {
	if c.APIProviders == nil {
		// Old clients may edit the default provider, without dropping additional providers.
		c.APIProviders = append([]APIProvider{}, apiProviders(old)...)
		found := false
		for i := range c.APIProviders {
			if c.APIProviders[i].ID == defaultAPIProviderID {
				c.APIProviders[i].Connection = c.API
				c.APIProviders[i].Models = c.APIModels
				c.APIProviders[i].EnabledModels = c.APIEnabledModels
				found = true
			}
		}
		if !found && (c.API.URL != "" || len(c.APIModels) > 0) {
			c.APIProviders = append(c.APIProviders, APIProvider{ID: defaultAPIProviderID, Name: "API", Connection: c.API, Models: c.APIModels, EnabledModels: c.APIEnabledModels})
		}
	}
	seen := map[string]bool{}
	for i := range c.APIProviders {
		p := &c.APIProviders[i]
		if !providerIDPattern.MatchString(p.ID) || seen[p.ID] {
			return errors.New("提供商 ID 无效或重复")
		}
		seen[p.ID] = true
		p.Name = strings.TrimSpace(p.Name)
		if p.Name == "" || len(p.Name) > 100 {
			return errors.New("请填写提供商名称（最多 100 字节）")
		}
		if p.Connection.Key == "" && p.Connection.HasKey {
			for _, previous := range apiProviders(old) {
				if previous.ID == p.ID {
					p.Connection.Key = previous.Connection.Key
				}
			}
		}
		p.Connection.URL = strings.TrimSpace(p.Connection.URL)
		p.Connection.Key = strings.TrimSpace(p.Connection.Key)
		p.Connection.Model = ""
		p.Connection.HasKey = false
		if err := validateAgentAPI(p.Connection); err != nil {
			return err
		}
		for _, ids := range [][]string{p.Models, p.EnabledModels} {
			if len(ids) > 200 {
				return errors.New("模型数量过多")
			}
			for _, id := range ids {
				if strings.TrimSpace(id) == "" || len(id) > 200 {
					return errors.New("模型 ID 无效")
				}
			}
		}
		if len(p.Models) > 50 {
			return errors.New("手动添加的模型过多")
		}
		for model, o := range p.ModelOverrides {
			if model == "" || len(model) > 200 {
				return errors.New("模型 ID 无效")
			}
			if err := validateProbeTimeouts(APIConnection{TextProbeTimeoutSeconds: o.TextProbeTimeoutSeconds, VisionProbeTimeoutSeconds: o.VisionProbeTimeoutSeconds, FirstOutputTimeoutSeconds: o.FirstOutputTimeoutSeconds, IdleTimeoutSeconds: o.IdleTimeoutSeconds, TotalTimeoutSeconds: o.TotalTimeoutSeconds}); err != nil {
				return err
			}
		}
	}
	projectLegacyAPI(c)
	return nil
}
func providerModelEnabled(p APIProvider, model string) bool {
	return p.EnabledModels == nil || slices.Contains(p.EnabledModels, model)
}

func snapshotAIConfig(c AIConfig) AIConfig {
	raw, _ := json.Marshal(c)
	var snapshot AIConfig
	_ = json.Unmarshal(raw, &snapshot)
	for key, cap := range c.Capabilities {
		snapshot.Capabilities[key] = cap
	}
	return snapshot
}
