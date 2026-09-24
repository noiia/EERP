package dbmanage

import (
	"sync"

	"core/internal/module"
	"core/internal/pictures"
	"core/internal/presence"
	"core/internal/types"
	"core/orm"

	"github.com/bytecodealliance/wasmtime-go/v15"
)

// Manager holds everything a database-management action needs: the live app
// database handle (whose pool CreateAndProvision/SwitchTo can hot-swap — see
// core/orm/pool/db.SwapPool), the SAME module.Registry instance main.go wired
// into ActiveGateMiddleware (switching must re-Boot THIS one, not a
// throwaway copy, so its live active/table-ownership state stays correct —
// see switch.go), and the connection/secret material every action needs.
type Manager struct {
	app           *orm.App
	moduleRuntime *module.Registry
	presenceHub   *presence.Hub
	objects       pictures.ObjectStore // nil when s3_* isn't configured
	provisioner   Provisioner
	conn          connInfo
	masterKey     string
	environment   string
	configPath    string

	mu     sync.RWMutex
	active string // currently active database name — see ActiveName's doc comment
}

// NewManager wires a Manager from main.go's already-constructed dependencies.
// objects may be nil (s3_* unconfigured) — S3-inclusive extraction/restore
// then simply isn't offered (Handler returns a clear error instead of a
// panic), the same degrade-gracefully posture internal/pictures itself takes.
func NewManager(
	app *orm.App,
	moduleRuntime *module.Registry,
	presenceHub *presence.Hub,
	objects pictures.ObjectStore,
	engine *wasmtime.Engine,
	linker *wasmtime.Linker,
	cfg *types.Config,
	configPath string,
) *Manager {
	conn := connInfo{Host: cfg.DbHost, Port: cfg.DbPort, User: cfg.DbUser, Password: cfg.DbPassword}
	return &Manager{
		app:           app,
		moduleRuntime: moduleRuntime,
		presenceHub:   presenceHub,
		objects:       objects,
		provisioner: Provisioner{
			Engine:      engine,
			Linker:      linker,
			ModuleRoots: cfg.ModuleRoot,
			Environment: cfg.Environment,
		},
		conn:        conn,
		masterKey:   cfg.MasterPassword,
		environment: cfg.Environment,
		configPath:  configPath,
		active:      cfg.DbName,
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
