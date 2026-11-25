package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"core/internal/common"
	"core/internal/dbmanage"
	"core/internal/types"
	"core/internal/version"
	"core/orm"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
)

// migrator brings a database up to Version()'s schema.
type migrator interface {
	Migrate(ctx context.Context, dbName string) error
	Version() string
}

// inProcess migrates with this build's own modules.
type inProcess struct{ cfg *types.Config }

func (m inProcess) Migrate(ctx context.Context, db string) error { return provision(ctx, m.cfg, db) }
func (inProcess) Version() string                                { return version.Version }

func run(ctx context.Context, cfg *types.Config, a args) (Report, error) {
	if a.To != "" && a.To != version.Version {
		return Report{}, fmt.Errorf("-to %s is not supported yet", a.To)
	}
	return runWith(ctx, cfg, a, inProcess{cfg})
}

func tmpName(kind string) string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return "eerp_upgrade_" + kind + "_" + hex.EncodeToString(b)
}

func runSteps(ctx context.Context, cfg *types.Config, db, target string, pre bool) error {
	ss := stepsFor(target, pre)
	if len(ss) == 0 {
		return nil
	}
	c := *cfg
	c.DbName = db
	app, err := orm.New(c.PoolConfig(c.DSN()), common.Logger)
	if err != nil {
		return err
	}
	defer app.Close()
	for _, s := range ss {
		common.Logger.Info("upgrade step", zap.String("step", s.Name))
		if err := s.Run(ctx, app.DB); err != nil {
			return fmt.Errorf("step %s: %w", s.Name, err)
		}
	}
	return nil
}

func schemaOf(ctx context.Context, conn dbmanage.Conn, db string) (Schema, error) {
	c, err := pgx.Connect(ctx, conn.DSN(db))
	if err != nil {
		return nil, err
	}
	defer c.Close(ctx)
	return loadSchema(ctx, c)
}

func runWith(ctx context.Context, cfg *types.Config, a args, m migrator) (rep Report, err error) {
	start := time.Now()
	in, err := openInput(a.In)
	if err != nil {
		return rep, err
	}
	defer in.zip.Close()
	target := strings.TrimPrefix(m.Version(), "v")
	if err := checkRange(in.Version, target); err != nil {
		return rep, err
	}

	conn := dbmanage.ConnFromConfig(cfg)
	tmp, ref := tmpName("tmp"), tmpName("ref")
	defer func() {
		// Ctrl-C must still clean up.
		cctx := context.WithoutCancel(ctx)
		for _, n := range []string{tmp, ref} {
			if derr := dbmanage.DropDatabase(cctx, conn, n, cfg.DbName); derr != nil {
				common.Logger.Debug("drop temp database", zap.String("db", n), zap.Error(derr))
			}
		}
	}()

	work, err := os.MkdirTemp("", "eerp-upgrade-")
	if err != nil {
		return rep, err
	}
	defer os.RemoveAll(work)
	dumpPath := filepath.Join(work, "in.dump")
	if err := in.extractDump(dumpPath); err != nil {
		return rep, err
	}
	if err := dbmanage.CreateDatabase(ctx, conn, tmp); err != nil {
		return rep, err
	}
	if err := dbmanage.PgRestore(ctx, conn, tmp, dumpPath); err != nil {
		return rep, fmt.Errorf("restore input: %w", err)
	}
	if err := runSteps(ctx, cfg, tmp, target, true); err != nil {
		return rep, err
	}
	if err := m.Migrate(ctx, tmp); err != nil {
		return rep, fmt.Errorf("migrate: %w", err)
	}
	if err := runSteps(ctx, cfg, tmp, target, false); err != nil {
		return rep, err
	}
	if err := dbmanage.CreateDatabase(ctx, conn, ref); err != nil {
		return rep, err
	}
	if err := m.Migrate(ctx, ref); err != nil {
		return rep, fmt.Errorf("migrate reference: %w", err)
	}
	want, err := schemaOf(ctx, conn, ref)
	if err != nil {
		return rep, err
	}
	got, err := schemaOf(ctx, conn, tmp)
	if err != nil {
		return rep, err
	}
	rep = Report{In: a.In, Out: a.Out, Target: target, Source: in.Version, Diff: diffSchemas(want, got)}
	if rep.Diff.Failed() {
		rep.Duration = time.Since(start)
		return rep, fmt.Errorf("upgraded schema differs from a fresh %s database:\n%s", target, rep)
	}
	rep.S3Objects, err = writeOutput(ctx, a.Out, in, target, func(w io.Writer) error {
		return dbmanage.PgDump(ctx, conn, tmp, w)
	})
	rep.Duration = time.Since(start)
	return rep, err
}
