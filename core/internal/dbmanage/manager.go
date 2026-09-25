package dbmanage

import (
	"sync"
	"time"

	"core/internal/pictures"
	"core/internal/presence"
	"core/internal/types"
	"core/orm"

	"github.com/bytecodealliance/wasmtime-go/v15"
)

// Manager holds everything a database-management action needs: the live app
// database handle (whose pool Activate can hot-swap — see core/orm/pool/db.
// SwapPool), the connection/secret material every action needs, and the
// in-memory state of any database currently being prepared or sitting warm
// as an activate-ready standby (prepare.go). Deliberately holds no
// *module.Registry: Provisioner.Provision (provision.go) builds its own
// throwaway registry per call, so schema provisioning never needs the
// process's one live registry singleton (main.go's own moduleRuntime, used
// for ActiveGateMiddleware elsewhere) — that's what lets Prepare run against
// a not-yet-live database with zero interaction with live request handling.
type Manager struct {
	app         *orm.App
	presenceHub *presence.Hub
	objects     pictures.ObjectStore // nil when s3_* isn't configured
	provisioner Provisioner
	conn        connInfo
	masterKey   string
	configPath  string
	maxConns    int32
	minConns    int32

	mu       sync.RWMutex
	active   string                     // currently active database name — see ActiveName's doc comment
	prepared map[string]*preparedTarget // standbys — see prepare.go
	// lastPrepareDuration is the most recent successful Prepare's own wall-clock
	// time in THIS process — the rough estimate PrepareInfoFor hands a caller
	// polling a still-running Prepare's status. Zero until the first one
	// completes; a process restart resets it, same as prepared itself.
	lastPrepareDuration time.Duration
}

// NewManager wires a Manager from main.go's already-constructed dependencies.
// objects may be nil (s3_* unconfigured) — S3-inclusive extraction/restore
// then simply isn't offered (Handler returns a clear error instead of a
// panic), the same degrade-gracefully posture internal/pictures itself takes.
func NewManager(
	app *orm.App,
	presenceHub *presence.Hub,
	objects pictures.ObjectStore,
	engine *wasmtime.Engine,
	linker *wasmtime.Linker,
	cfg *types.Config,
	configPath string,
) *Manager {
	conn := connInfo{Host: cfg.DbHost, Port: cfg.DbPort, User: cfg.DbUser, Password: cfg.DbPassword}
	return &Manager{
		app:         app,
		presenceHub: presenceHub,
		objects:     objects,
		provisioner: Provisioner{
			Engine:      engine,
			Linker:      linker,
			ModuleRoots: cfg.ModuleRoot,
			Environment: cfg.Environment,
		},
		conn:       conn,
		masterKey:  cfg.MasterPassword,
		configPath: configPath,
		maxConns:   cfg.MaxConns,
		minConns:   cfg.MinConns,
		active:     cfg.DbName,
		prepared:   map[string]*preparedTarget{},
	}
}

// ActiveName is the database core-back is CURRENTLY serving from — tracked
// here rather than read off the boot-time config, since the config's own
// db_name field goes stale the instant a live switch happens (nothing else
// in the process re-reads it after boot).
func (m *Manager) ActiveName() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.active
}

func (m *Manager) setActiveName(name string) {
	m.mu.Lock()
	m.active = name
	m.mu.Unlock()
}
