package neoread

import (
	"database/sql"
	"encoding/json"
	"errors"
)

// PrepareStartupSettings snapshots the theme before recovery can occupy the
// store's single database connection. Read errors must not become a wrong theme.
func (s *Server) PrepareStartupSettings() error {
	var value string
	err := s.Store.DB.QueryRow("SELECT value FROM settings WHERE key='neoread'").Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		value = "{}"
	} else if err != nil {
		return err
	}
	if !json.Valid([]byte(value)) {
		return errors.New("保存的主题设置无效")
	}
	s.startupSettings = json.RawMessage(value)
	return nil
}
