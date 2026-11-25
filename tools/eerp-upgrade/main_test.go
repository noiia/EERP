package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidateArgs(t *testing.T) {
	d := t.TempDir()
	in, out := filepath.Join(d, "in.zip"), filepath.Join(d, "out.zip")
	_ = os.WriteFile(in, []byte("x"), 0o600)
	ok := args{ConfigPath: "c.json", In: in, Out: out}
	if err := validateArgs(ok); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(out, []byte("x"), 0o600)
	if validateArgs(ok) == nil {
		t.Error("existing out without force must error")
	}
	ok.Force = true
	if err := validateArgs(ok); err != nil {
		t.Error(err)
	}
	if validateArgs(args{ConfigPath: "c", In: in, Out: in, Force: true}) == nil {
		t.Error("out == in must error")
	}
	if validateArgs(args{ConfigPath: "c", In: filepath.Join(d, "missing"), Out: out, Force: true}) == nil {
		t.Error("missing in must error")
	}
	if validateArgs(args{In: in, Out: out, Force: true}) == nil {
		t.Error("missing config must error")
	}
}

func TestParseArgs(t *testing.T) {
	a, err := parseArgs([]string{"-config", "c", "-in", "i", "-out", "o", "-to", "0.170.0", "-force"})
	if err != nil || a.ConfigPath != "c" || a.In != "i" || a.Out != "o" || a.To != "0.170.0" || !a.Force {
		t.Fatalf("%+v %v", a, err)
	}
}
