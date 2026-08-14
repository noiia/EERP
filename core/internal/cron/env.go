package cron

import "core/orm"

// envDB/envLogDir are the shared handles a registered Action's Run may need
// (the DB, and where log files live). Package-level, like common.Logger:
// modules register their Action from a plain init(), long before a DB
// connection exists, so there is no earlier point to inject this — SetEnv
// is called once at startup (main.go), after the DB is ready and before the
// Scheduler starts.
var (
	envDB     *orm.DB
	envLogDir string
)

// SetEnv wires the shared DB handle + log directory for every registered
// Action to read via Env().
func SetEnv(db *orm.DB, logDir string) {
	envDB = db
	envLogDir = logDir
}

// Env returns the shared DB handle + log directory set by SetEnv.
func Env() (*orm.DB, string) {
	return envDB, envLogDir
}
