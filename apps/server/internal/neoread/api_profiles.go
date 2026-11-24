package neoread

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
)

type APIProfile struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Protocol string `json:"protocol,omitempty"`
	URL      string `json:"url"`
	Key      string `json:"key,omitempty"`
	HasKey   bool   `json:"hasKey"`
}

func (p APIProfile) connection() APIConnection {
	return APIConnection{Protocol: p.Protocol, URL: p.URL, Key: p.Key, HasKey: p.HasKey}
}

func apiProfileFromConnection(id, name string, c APIConnection) APIProfile {
	return APIProfile{ID: id, Name: name, URL: c.URL, Protocol: c.Protocol, Key: c.Key}
}

// Upgrade on read without writing secrets or changing existing check fingerprints.
// The next config save persists the result; the ID stays stable until then.
func (c *AIConfig) migrateAPIProfile() {
	if len(c.APIProfiles) != 0 || c.API.URL == "" {
		return
	}
	name := "API 连接"
	if u, err := url.Parse(c.API.URL); err == nil && u.Host != "" {
		name = u.Host
	}
	c.ActiveAPIProfile = "profile-legacy"
	c.APIProfiles = []APIProfile{apiProfileFromConnection(c.ActiveAPIProfile, name, c.API)}
}

func mergeAPIConnection(c, old APIConnection) (APIConnection, error) {
	c.URL = strings.TrimSpace(c.URL)
	c.Key = strings.TrimSpace(c.Key)
	// A legacy protocol is shown resolved in GET; retain the stored value
	// when the user did not change it so that existing checks stay valid.
	if (old.Protocol == "" || old.Protocol == "auto") && c.URL == old.URL && c.Protocol == resolveAPIEndpoint(old).Protocol {
		c.Protocol = old.Protocol
	}
	if c.Key == "" && c.HasKey && old.Key != "" {
		if resolveAPIEndpoint(c).Base != resolveAPIEndpoint(old).Base {
			return APIConnection{}, errors.New("API 地址已更改，请重新填写 API Key")
		}
		c.Key = old.Key
	}
	c.Model, c.HasKey = "", false
	return c, validateAgentAPI(c)
}

var apiProfileID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

func (c *AIConfig) mergeAPIProfiles(old AIConfig) error {
	if c.APIProfiles == nil {
		// Legacy clients write the mirrored connection but cannot replace the
		// profile collection. Do not discard inactive profiles on their saves.
		conn, err := mergeAPIConnection(c.API, old.API)
		if err != nil {
			return err
		}
		c.API = conn
		c.APIProfiles, c.ActiveAPIProfile = old.APIProfiles, old.ActiveAPIProfile
		for i, p := range c.APIProfiles {
			if p.ID != c.ActiveAPIProfile {
				continue
			}
			if conn.URL != "" {
				c.APIProfiles[i] = apiProfileFromConnection(p.ID, p.Name, conn)
			} else {
				c.APIProfiles = append(c.APIProfiles[:i], c.APIProfiles[i+1:]...)
				c.activateAPIProfile("")
			}
			return nil
		}
		c.migrateAPIProfile()
		return nil
	}

	oldByID := make(map[string]APIProfile, len(old.APIProfiles))
	for _, p := range old.APIProfiles {
		oldByID[p.ID] = p
	}
	seen := make(map[string]bool, len(c.APIProfiles))
	for i, p := range c.APIProfiles {
		id := strings.ToLower(p.ID)
		_, retired := retiredAPIProviders[id]
		if !apiProfileID.MatchString(p.ID) || validAgent(id) || retired || id == retiredKimiCodeKey || id == "text-api" || id == "image-api" || seen[p.ID] {
			return errors.New("API 连接模板标识无效或重复")
		}
		seen[p.ID] = true
		p.Name = strings.TrimSpace(p.Name)
		if p.Name == "" || strings.TrimSpace(p.URL) == "" {
			return errors.New("请填写模板名称和 API 地址")
		}
		previous := oldByID[p.ID]
		if p.HasKey && strings.TrimSpace(p.Key) == "" && previous.Key == "" {
			return errors.New("请重新填写 API Key")
		}
		conn, err := mergeAPIConnection(p.connection(), previous.connection())
		if err != nil {
			return err
		}
		c.APIProfiles[i] = apiProfileFromConnection(p.ID, p.Name, conn)
	}

	active := c.ActiveAPIProfile
	if active == "" {
		active = old.ActiveAPIProfile
	} else if !seen[active] && active != old.ActiveAPIProfile {
		return errors.New("所选 API 连接模板不存在")
	}
	c.activateAPIProfile(active)
	return nil
}

func (c *AIConfig) activateAPIProfile(id string) {
	if len(c.APIProfiles) == 0 {
		c.ActiveAPIProfile = ""
		c.API = APIConnection{}
		return
	}
	active := c.APIProfiles[0]
	for _, p := range c.APIProfiles {
		if p.ID == id {
			active = p
			break
		}
	}
	c.ActiveAPIProfile = active.ID
	c.API = active.connection()
}
