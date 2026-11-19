package neoread

import (
	"errors"
	"os"
	"syscall"

	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

type installerStage string

const (
	installPreflight         installerStage = "preflight"
	installProfileLock       installerStage = "profile_lock"
	installSourceLock        installerStage = "source_lock"
	installDestinationCreate installerStage = "destination_create"
	installDestinationLock   installerStage = "destination_lock"
	installCopy              installerStage = "copy"
	installVerify            installerStage = "verify"
	installActivate          installerStage = "activate"
)

type installerReason string

const (
	installBusy              installerReason = "busy"
	installInvalidLibrary    installerReason = "invalid_library"
	installNoSpace           installerReason = "no_space"
	installSettingsWrite     installerReason = "settings_write"
	installUnsafeLocation    installerReason = "unsafe_location"
	installDestinationExists installerReason = "destination_exists"
	installPermissionDenied  installerReason = "permission_denied"
	installCopyFailed        installerReason = "copy_failed"
)

type installerError struct {
	stage   installerStage
	reason  installerReason
	err     error
	message string
}

func (e *installerError) Error() string {
	if e.message != "" {
		return e.message
	}
	return e.err.Error()
}
func (e *installerError) Unwrap() error { return e.err }

// InstallerFailure returns only stable diagnostic identifiers, never the cause
// text. Use the original error for unwrapping, not as installer output.
func InstallerFailure(err error) (stage string, reason string) {
	if err == nil {
		return "", ""
	}
	var failure *installerError
	if errors.As(err, &failure) {
		return string(failure.stage), string(failure.reason)
	}
	return "unknown", string(installerFailureReason(err, installCopyFailed))
}

func installerFailureAt(stage installerStage, fallback installerReason, err error) error {
	if err == nil {
		return nil
	}
	var failure *installerError
	if errors.As(err, &failure) {
		return err
	}
	return &installerError{stage: stage, reason: installerFailureReason(err, fallback), err: err}
}

func installerFailureWithMessage(stage installerStage, fallback installerReason, err error, message string) error {
	return &installerError{stage: stage, reason: installerFailureReason(err, fallback), err: err, message: message}
}

func installerFailureReason(err error, fallback installerReason) installerReason {
	switch {
	case errors.Is(err, syscall.ENOSPC):
		return installNoSpace
	case errors.Is(err, os.ErrPermission), errors.Is(err, syscall.EROFS):
		return installPermissionDenied
	case errors.Is(err, errLibraryBusy):
		return installBusy
	}
	if reason := installerPlatformReason(err); reason != "" {
		return reason
	}
	var migrationErr *migrationError
	if errors.As(err, &migrationErr) && migrationErr.reason == "source_busy" {
		return installBusy
	}
	var sqliteErr *sqlite.Error
	if errors.As(err, &sqliteErr) {
		switch sqliteErr.Code() & 0xff {
		case sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED:
			return installBusy
		case sqlite3.SQLITE_FULL:
			return installNoSpace
		case sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB, sqlite3.SQLITE_SCHEMA:
			return installInvalidLibrary
		case sqlite3.SQLITE_PERM, sqlite3.SQLITE_READONLY:
			return installPermissionDenied
		case sqlite3.SQLITE_IOERR, sqlite3.SQLITE_CANTOPEN:
			return installCopyFailed
		}
	}
	return fallback
}
