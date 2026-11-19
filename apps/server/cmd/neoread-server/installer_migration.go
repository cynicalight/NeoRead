package main

import (
	"fmt"
	"io"
	"log/slog"
	"time"

	"neoread.local/server/internal/diagnostics"
	"neoread.local/server/internal/neoread"
)

// The installer reads stdout as a protocol, not a user-facing error stream.
// Never send filesystem paths or database errors to it or the diagnostic bundle.
func runInstallerMigration(source, destination, profile string, roots []string, output io.Writer) int {
	started := time.Now()
	var logs *diagnostics.Store
	if directory, err := neoread.InstallerLogDirectory(source, profile, roots); err == nil {
		if store, err := diagnostics.New(directory, ""); err == nil {
			logs = store
		}
	}
	logs.Event(slog.LevelInfo, "library.install_migration.start", "stage", "preflight")
	stage, reason := "preflight", "unsafe_location"
	code := 2
	if destination != "" && profile != "" {
		if err := neoread.InstallLibrary(source, destination, profile, roots); err != nil {
			stage, reason = neoread.InstallerFailure(err)
			code = 1
		} else {
			logs.Event(slog.LevelInfo, "library.install_migration.finish", "status", "success", "stage", "activate", "durationMs", time.Since(started).Milliseconds())
			return 0
		}
	}
	logs.Event(slog.LevelError, "library.install_migration.finish", "status", "failed", "stage", stage, "reasonCode", reason, "durationMs", time.Since(started).Milliseconds())
	fmt.Fprint(output, reason)
	return code
}
