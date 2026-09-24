package dbmanage

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/labstack/echo/v4"
)

// Extract streams dbName as a zip directly into the HTTP response: a
// dump.dump (pg_dump custom format) entry always, plus — when includeS3 is
// true — a manifest.json and one s3/<object_key> entry per object the
// manifest names, fetched from THIS instance's currently-configured S3
// store. Writes straight into the response via archive/zip's streaming
// writer (no temp file, no full in-memory buffering — zip's central
// directory is written at Close(), after every entry has already streamed
// out).
func (m *Manager) Extract(c echo.Context, dbName string, includeS3 bool) error {
	if includeS3 && m.objects == nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR",
			"S3 content was requested but this instance has no s3_* object store configured.")
	}

	ctx := c.Request().Context()
	c.Response().Header().Set(echo.HeaderContentType, "application/zip")
	c.Response().Header().Set(echo.HeaderContentDisposition,
		fmt.Sprintf(`attachment; filename="%s.zip"`, dbName))
	c.Response().WriteHeader(http.StatusOK)

	zw := zip.NewWriter(c.Response())
	defer func() { _ = zw.Close() }()

	dumpEntry, err := zw.Create("dump.dump")
	if err != nil {
		return fmt.Errorf("dbmanage: create dump.dump entry: %w", err)
	}
	if err := pgDump(ctx, m.conn, dbName, dumpEntry); err != nil {
		return err
	}

	if !includeS3 {
		return nil
	}

	manifest, err := BuildManifest(ctx, m.conn, dbName)
	if err != nil {
		return err
	}
	manifestEntry, err := zw.Create("manifest.json")
	if err != nil {
		return fmt.Errorf("dbmanage: create manifest.json entry: %w", err)
	}
	if err := json.NewEncoder(manifestEntry).Encode(manifest); err != nil {
		return fmt.Errorf("dbmanage: encode manifest.json: %w", err)
	}

	seen := make(map[string]bool, len(manifest))
	for _, entry := range manifest {
		if seen[entry.ObjectKey] {
			continue
		}
		seen[entry.ObjectKey] = true

		body, _, err := m.objects.Get(ctx, entry.ObjectKey)
		if err != nil {
			return fmt.Errorf("dbmanage: fetch s3 object %s: %w", entry.ObjectKey, err)
		}
		objEntry, err := zw.Create("s3/" + entry.ObjectKey)
		if err != nil {
			_ = body.Close()
			return fmt.Errorf("dbmanage: create s3/%s entry: %w", entry.ObjectKey, err)
		}
		_, copyErr := io.Copy(objEntry, body)
		closeErr := body.Close()
		if copyErr != nil {
			return fmt.Errorf("dbmanage: write s3/%s: %w", entry.ObjectKey, copyErr)
		}
		if closeErr != nil {
			return fmt.Errorf("dbmanage: close s3 object %s: %w", entry.ObjectKey, closeErr)
		}
	}
	return nil
}
