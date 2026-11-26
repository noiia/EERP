package dbmanage

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"core/internal/version"

	"github.com/labstack/echo/v5"
)

// VersionEntry is the bundle entry recording which EERP release wrote it, so
// the upgrade tool (tools/eerp-upgrade) knows which migrations still apply.
const VersionEntry = "version.json"

// VersionFile is VersionEntry's content.
type VersionFile struct {
	Version string `json:"version"`
}

// ErrNoObjectStore: S3 content was requested but s3_* isn't configured.
var ErrNoObjectStore = errors.New("dbmanage: S3 content was requested but this instance has no s3_* object store configured")

// dumpDB is PgDump; a var so tests can run without pg_dump installed.
var dumpDB = PgDump

// Extract streams dbName's bundle (WriteBundle) as a zip download.
func (m *Manager) Extract(c *echo.Context, dbName string, includeS3 bool) error {
	if includeS3 && m.objects == nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR",
			"S3 content was requested but this instance has no s3_* object store configured.")
	}
	c.Response().Header().Set(echo.HeaderContentType, "application/zip")
	c.Response().Header().Set(echo.HeaderContentDisposition,
		fmt.Sprintf(`attachment; filename="%s.zip"`, dbName))
	c.Response().WriteHeader(http.StatusOK)
	_, err := m.WriteBundle(c.Request().Context(), c.Response(), dbName, includeS3)
	return err
}

// WriteBundle writes dbName as the zip Restore accepts into w: a dump.dump
// entry (pg_dump custom format) always, plus — when includeS3 is true — a
// manifest.json and one s3/<object_key> entry per object the manifest names,
// fetched from THIS instance's S3 store. Streams (zip's central directory is
// written at Close, after every entry). Returns the number of S3 objects
// written. Used by the HTTP download and by automated backups (a file).
func (m *Manager) WriteBundle(ctx context.Context, w io.Writer, dbName string, includeS3 bool) (int, error) {
	if includeS3 && m.objects == nil {
		return 0, ErrNoObjectStore
	}
	zw := zip.NewWriter(w)
	objects, err := m.writeBundle(ctx, zw, dbName, includeS3)
	if closeErr := zw.Close(); err == nil && closeErr != nil {
		err = fmt.Errorf("dbmanage: close zip: %w", closeErr)
	}
	return objects, err
}

func (m *Manager) writeBundle(ctx context.Context, zw *zip.Writer, dbName string, includeS3 bool) (int, error) {
	versionEntry, err := zw.Create(VersionEntry)
	if err != nil {
		return 0, fmt.Errorf("dbmanage: create %s entry: %w", VersionEntry, err)
	}
	if err := json.NewEncoder(versionEntry).Encode(VersionFile{Version: version.Version}); err != nil {
		return 0, fmt.Errorf("dbmanage: encode %s: %w", VersionEntry, err)
	}
	dumpEntry, err := zw.Create("dump.dump")
	if err != nil {
		return 0, fmt.Errorf("dbmanage: create dump.dump entry: %w", err)
	}
	if err := dumpDB(ctx, m.conn, dbName, dumpEntry); err != nil {
		return 0, err
	}
	if !includeS3 {
		return 0, nil
	}

	manifest, err := BuildManifest(ctx, m.conn, dbName)
	if err != nil {
		return 0, err
	}
	manifestEntry, err := zw.Create("manifest.json")
	if err != nil {
		return 0, fmt.Errorf("dbmanage: create manifest.json entry: %w", err)
	}
	if err := json.NewEncoder(manifestEntry).Encode(manifest); err != nil {
		return 0, fmt.Errorf("dbmanage: encode manifest.json: %w", err)
	}

	seen := make(map[string]bool, len(manifest))
	for _, entry := range manifest {
		if seen[entry.ObjectKey] {
			continue
		}
		seen[entry.ObjectKey] = true

		body, _, err := m.objects.Get(ctx, entry.ObjectKey)
		if err != nil {
			return len(seen) - 1, fmt.Errorf("dbmanage: fetch s3 object %s: %w", entry.ObjectKey, err)
		}
		objEntry, err := zw.Create("s3/" + entry.ObjectKey)
		if err != nil {
			_ = body.Close()
			return len(seen) - 1, fmt.Errorf("dbmanage: create s3/%s entry: %w", entry.ObjectKey, err)
		}
		_, copyErr := io.Copy(objEntry, body)
		closeErr := body.Close()
		if copyErr != nil {
			return len(seen) - 1, fmt.Errorf("dbmanage: write s3/%s: %w", entry.ObjectKey, copyErr)
		}
		if closeErr != nil {
			return len(seen) - 1, fmt.Errorf("dbmanage: close s3 object %s: %w", entry.ObjectKey, closeErr)
		}
	}
	return len(seen), nil
}
