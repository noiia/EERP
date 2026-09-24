package dbmanage

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"

	"github.com/labstack/echo/v4"
)

// Restore rebuilds a database from a zip produced by Extract: creates a new
// database named by the "name" form field, pg_restores its dump.dump into
// it, and — if the zip carries a manifest.json/s3/ folder — re-uploads each
// object to THIS instance's currently-configured S3 bucket at the SAME key.
// No key rewriting happens: object keys are tenant/table/record/field-scoped
// (internal/pictures, internal/attachments), never environment-scoped, so
// the freshly-restored database's own picture/attachment rows resolve
// correctly against the newly-populated bucket with no extra mapping step.
// Does NOT auto-switch into the restored database — that stays an explicit,
// separate SwitchTo call, keeping every action here atomic and composable.
func (m *Manager) Restore(c echo.Context) error {
	ctx := c.Request().Context()

	name := c.FormValue("name")
	if err := validateName(name); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", err.Error())
	}

	fileHeader, err := c.FormFile("file")
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "A `file` part (the .zip) is required.")
	}

	tmpDir, err := os.MkdirTemp("", "dbmanage-restore-*")
	if err != nil {
		return fmt.Errorf("dbmanage: create temp dir: %w", err)
	}
	defer func() { _ = os.RemoveAll(tmpDir) }()

	zipPath := filepath.Join(tmpDir, "upload.zip")
	if err := saveUpload(fileHeader, zipPath); err != nil {
		return fmt.Errorf("dbmanage: save upload: %w", err)
	}

	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Uploaded file is not a valid zip.")
	}
	defer func() { _ = zr.Close() }()

	dumpPath := filepath.Join(tmpDir, "dump.dump")
	if err := extractZipEntry(&zr.Reader, "dump.dump", dumpPath); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Zip has no dump.dump entry.")
	}

	if err := CreateDatabase(ctx, m.conn, name); err != nil {
		return err
	}
	if err := pgRestore(ctx, m.conn, name, dumpPath); err != nil {
		return err
	}

	manifestFile, err := zr.Open("manifest.json")
	if err != nil {
		// No S3 content in this zip — a SQL-only extraction. Nothing more to do.
		return c.JSON(http.StatusCreated, map[string]any{"name": name})
	}
	defer func() { _ = manifestFile.Close() }()

	var manifest []ManifestEntry
	if err := json.NewDecoder(manifestFile).Decode(&manifest); err != nil {
		return fmt.Errorf("dbmanage: parse manifest.json: %w", err)
	}
	if m.objects == nil && len(manifest) > 0 {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR",
			"This zip carries S3 content but this instance has no s3_* object store configured to restore it into.")
	}

	for _, entry := range manifest {
		obj, err := zr.Open("s3/" + entry.ObjectKey)
		if err != nil {
			return fmt.Errorf("dbmanage: zip missing s3/%s named by its own manifest: %w", entry.ObjectKey, err)
		}
		info, statErr := obj.Stat()
		if statErr != nil {
			_ = obj.Close()
			return fmt.Errorf("dbmanage: stat s3/%s: %w", entry.ObjectKey, statErr)
		}
		putErr := m.objects.Put(ctx, entry.ObjectKey, entry.Mime, info.Size(), obj)
		closeErr := obj.Close()
		if putErr != nil {
			return fmt.Errorf("dbmanage: restore s3 object %s: %w", entry.ObjectKey, putErr)
		}
		if closeErr != nil {
			return fmt.Errorf("dbmanage: close zip entry s3/%s: %w", entry.ObjectKey, closeErr)
		}
	}

	return c.JSON(http.StatusCreated, map[string]any{"name": name, "s3_objects_restored": len(manifest)})
}

func saveUpload(fh *multipart.FileHeader, dst string) error {
	src, err := fh.Open()
	if err != nil {
		return err
	}
	defer func() { _ = src.Close() }()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer func() { _ = out.Close() }()

	_, err = io.Copy(out, src)
	return err
}

func extractZipEntry(zr *zip.Reader, name, dstPath string) error {
	f, err := zr.Open(name)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	out, err := os.Create(dstPath)
	if err != nil {
		return err
	}
	defer func() { _ = out.Close() }()

	_, err = io.Copy(out, f)
	return err
}
