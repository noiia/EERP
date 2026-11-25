package main

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"core/internal/dbmanage"
)

const dumpEntry = "dump.dump"

type input struct {
	zip     *zip.ReadCloser
	Version string
}

// openInput opens an extract zip, requiring its dump and reading its version.json if present.
func openInput(path string) (*input, error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	in := &input{zip: zr}
	hasDump := false
	for _, f := range zr.File {
		switch f.Name {
		case dumpEntry:
			hasDump = true
		case dbmanage.VersionEntry:
			rc, err := f.Open()
			if err != nil {
				zr.Close()
				return nil, err
			}
			var vf dbmanage.VersionFile
			err = json.NewDecoder(rc).Decode(&vf)
			rc.Close()
			if err != nil {
				zr.Close()
				return nil, fmt.Errorf("read %s: %w", dbmanage.VersionEntry, err)
			}
			in.Version = vf.Version
		}
	}
	if !hasDump {
		zr.Close()
		return nil, fmt.Errorf("%s is not an extract: no %s entry", path, dumpEntry)
	}
	return in, nil
}

// extractDump writes the zip's dump.dump to dst.
func (in *input) extractDump(dst string) error {
	for _, f := range in.zip.File {
		if f.Name != dumpEntry {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		defer rc.Close()
		w, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
		if err != nil {
			return err
		}
		if _, err := io.Copy(w, rc); err != nil {
			w.Close()
			return err
		}
		return w.Close()
	}
	return errors.New("no dump entry")
}

// writeOutput writes out atomically: version.json, the new dump, then every other
// input entry copied raw. It returns how many s3/ entries were copied.
func writeOutput(ctx context.Context, out string, in *input, targetVersion string, dump func(io.Writer) error) (s3Objects int, err error) {
	partial := out + ".partial"
	f, err := os.OpenFile(partial, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, err
	}
	defer func() {
		if err != nil {
			f.Close()
			os.Remove(partial)
		}
	}()
	zw := zip.NewWriter(f)
	w, err := zw.Create(dbmanage.VersionEntry)
	if err != nil {
		return 0, err
	}
	if err = json.NewEncoder(w).Encode(dbmanage.VersionFile{Version: targetVersion}); err != nil {
		return 0, err
	}
	if w, err = zw.Create(dumpEntry); err != nil {
		return 0, err
	}
	if err = dump(w); err != nil {
		return 0, err
	}
	for _, e := range in.zip.File {
		if err = ctx.Err(); err != nil {
			return 0, err
		}
		if e.Name == dumpEntry || e.Name == dbmanage.VersionEntry {
			continue
		}
		if err = zw.Copy(e); err != nil {
			return 0, err
		}
		if len(e.Name) > 3 && e.Name[:3] == "s3/" {
			s3Objects++
		}
	}
	if err = zw.Close(); err != nil {
		return 0, err
	}
	if err = f.Close(); err != nil {
		return 0, err
	}
	if err = os.Rename(partial, out); err != nil {
		return 0, err
	}
	return s3Objects, nil
}
