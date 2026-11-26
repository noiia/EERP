package main

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func makeZip(t *testing.T, path string, files map[string]string) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for n, c := range files {
		w, _ := zw.Create(n)
		_, _ = w.Write([]byte(c))
	}
	_ = zw.Close()
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readZip(t *testing.T, path string) map[string]string {
	t.Helper()
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	got := map[string]string{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		got[f.Name] = string(b)
	}
	return got
}

func TestOpenInput(t *testing.T) {
	d := t.TempDir()
	bad := filepath.Join(d, "bad.zip")
	_ = os.WriteFile(bad, []byte("nope"), 0o600)
	if _, err := openInput(bad); err == nil {
		t.Error("non-zip must error")
	}
	nodump := filepath.Join(d, "nodump.zip")
	makeZip(t, nodump, map[string]string{"manifest.json": "{}"})
	if _, err := openInput(nodump); err == nil {
		t.Error("zip without dump.dump must error")
	}
	plain := filepath.Join(d, "plain.zip")
	makeZip(t, plain, map[string]string{"dump.dump": "x"})
	in, err := openInput(plain)
	if err != nil || in.Version != "" {
		t.Fatalf("plain: %v %+v", err, in)
	}
	in.zip.Close()
	ver := filepath.Join(d, "ver.zip")
	makeZip(t, ver, map[string]string{"dump.dump": "x", "version.json": `{"version":"0.150.0"}`})
	in, err = openInput(ver)
	if err != nil || in.Version != "0.150.0" {
		t.Fatalf("ver: %v %+v", err, in)
	}
	dst := filepath.Join(d, "out.dump")
	if err := in.extractDump(dst); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "x" {
		t.Errorf("dump = %q", b)
	}
	in.zip.Close()
}

func TestWriteOutput(t *testing.T) {
	d := t.TempDir()
	src := filepath.Join(d, "in.zip")
	makeZip(t, src, map[string]string{
		"dump.dump": "old", "version.json": `{"version":"0.150.0"}`,
		"manifest.json": `{"m":1}`, "s3/t/a.png": "png",
	})
	in, err := openInput(src)
	if err != nil {
		t.Fatal(err)
	}
	defer in.zip.Close()
	out := filepath.Join(d, "out.zip")
	n, err := writeOutput(context.Background(), out, in, "0.170.0", func(w io.Writer) error {
		_, err := w.Write([]byte("new"))
		return err
	})
	if err != nil || n != 1 {
		t.Fatalf("writeOutput = %d, %v", n, err)
	}
	got := readZip(t, out)
	want := map[string]string{"version.json": `{"version":"0.170.0"}`, "dump.dump": "new", "manifest.json": `{"m":1}`, "s3/t/a.png": "png"}
	if len(got) != len(want) {
		t.Fatalf("entries = %v", got)
	}
	for k, v := range want {
		if strings.TrimSpace(got[k]) != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}

	out2 := filepath.Join(d, "out2.zip")
	if _, err := writeOutput(context.Background(), out2, in, "0.170.0", func(io.Writer) error { return errors.New("boom") }); err == nil {
		t.Fatal("want error")
	}
	for _, p := range []string{out2, out2 + ".partial"} {
		if _, err := os.Stat(p); err == nil {
			t.Errorf("%s left behind", p)
		}
	}
}
