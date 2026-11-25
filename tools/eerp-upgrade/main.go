// Command eerp-upgrade upgrades a /database/management extract zip from an
// older EERP release to the current one, writing a new zip.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"core/internal/common"
	"core/internal/types"
	"core/internal/version"
)

type args struct {
	ConfigPath, In, Out, To string
	Force, Debug            bool
}

func parseArgs(argv []string) (args, error) {
	var a args
	fs := flag.NewFlagSet("eerp-upgrade", flag.ContinueOnError)
	fs.StringVar(&a.ConfigPath, "config", "", "eerp-config.json path (database server to use as scratch)")
	fs.StringVar(&a.In, "in", "", "extract zip to upgrade")
	fs.StringVar(&a.Out, "out", "", "upgraded zip to write")
	fs.StringVar(&a.To, "to", version.Version, "target EERP version (default: this build's)")
	fs.BoolVar(&a.Force, "force", false, "overwrite -out if it exists")
	fs.BoolVar(&a.Debug, "debug", false, "debug logging")
	return a, fs.Parse(argv)
}

func validateArgs(a args) error {
	if a.ConfigPath == "" || a.In == "" || a.Out == "" {
		return errors.New("-config, -in and -out are required")
	}
	if _, err := os.Stat(a.In); err != nil {
		return fmt.Errorf("-in: %w", err)
	}
	if st, err := os.Stat(filepath.Dir(a.Out)); err != nil || !st.IsDir() {
		return fmt.Errorf("-out: directory %s does not exist", filepath.Dir(a.Out))
	}
	if a.In == a.Out {
		return errors.New("-out must differ from -in")
	}
	if _, err := os.Stat(a.Out); err == nil && !a.Force {
		return fmt.Errorf("%s exists (use -force to overwrite)", a.Out)
	}
	return nil
}

func main() {
	a, err := parseArgs(os.Args[1:])
	if err == nil {
		err = validateArgs(a)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "eerp-upgrade:", err)
		os.Exit(2)
	}
	if err := common.InitLogger(a.Debug); err != nil {
		panic(err)
	}
	cfg, err := common.DecodeJSON[*types.Config](a.ConfigPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "eerp-upgrade: read config:", err)
		os.Exit(1)
	}
	cfg.ResolvePaths(filepath.Dir(a.ConfigPath))

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	rep, err := run(ctx, cfg, a)
	if err != nil {
		fmt.Fprintln(os.Stderr, "eerp-upgrade:", err)
		os.Exit(1)
	}
	fmt.Println(rep)
}
