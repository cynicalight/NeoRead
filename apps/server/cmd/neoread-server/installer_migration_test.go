package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"neoread.local/server/internal/diagnostics"
)

func TestInstallerRetryExportsEachOutcomeWithoutPrivatePaths(t *testing.T) {
	root := t.TempDir()
	const privateName = "private-project-name"
	source := filepath.Join(root, "application", privateName)
	profile := filepath.Join(root, "profile")
	target := filepath.Join(root, "NeoRead Library")
	if err := os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	database := filepath.Join(source, "neoread.sqlite")
	if err := os.WriteFile(database, []byte(privateName), 0600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	migrate := func() int {
		output.Reset()
		return runInstallerMigration(source, target, profile, []string{filepath.Dir(source)}, &output)
	}
	if code := migrate(); code == 0 || output.String() != "invalid_library" {
		t.Fatalf("invalid database: status=%d, output=%q", code, output.String())
	}
	if err := os.Remove(database); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", database)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE documents (id TEXT PRIMARY KEY, type TEXT)`)
	closeErr := db.Close()
	if err != nil || closeErr != nil {
		t.Fatalf("create test library: %v, %v", err, closeErr)
	}
	if code := migrate(); code != 0 || output.Len() != 0 {
		t.Fatalf("valid retry: status=%d, output=%q", code, output.String())
	}

	logs, err := diagnostics.New(filepath.Join(profile, "logs"), "export")
	if err != nil {
		t.Fatal(err)
	}
	var bundle bytes.Buffer
	if err := logs.Export(&bundle, target, nil, nil); err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(bundle.Bytes()), int64(bundle.Len()))
	if err != nil {
		t.Fatal(err)
	}
	type event struct {
		Event, Status, Stage, ReasonCode, SessionID string
	}
	starts := map[string]int{}
	finishes := map[string]event{}
	for _, f := range archive.File {
		if !strings.HasPrefix(f.Name, "logs/") {
			continue
		}
		reader, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		scanner := bufio.NewScanner(reader)
		for scanner.Scan() {
			if bytes.Contains(scanner.Bytes(), []byte(privateName)) {
				t.Fatal("exported private path or database content")
			}
			var e event
			if err := json.Unmarshal(scanner.Bytes(), &e); err != nil {
				t.Fatal(err)
			}
			switch e.Event {
			case "library.install_migration.start":
				starts[e.SessionID]++
			case "library.install_migration.finish":
				finishes[e.Status] = e
			}
		}
		reader.Close()
		if err := scanner.Err(); err != nil {
			t.Fatal(err)
		}
	}
	failure, success := finishes["failed"], finishes["success"]
	if failure.Stage != "verify" || failure.ReasonCode != "invalid_library" || success.Stage != "activate" || success.ReasonCode != "" {
		t.Fatalf("unexpected diagnostic outcomes: %+v", finishes)
	}
	if failure.SessionID == "" || success.SessionID == "" || failure.SessionID == success.SessionID || starts[failure.SessionID] != 1 || starts[success.SessionID] != 1 {
		t.Fatalf("retry attempts not separately attributable: starts=%v, finishes=%v", starts, finishes)
	}
}
