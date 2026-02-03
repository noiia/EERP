package types

import (
	"github.com/dgraph-io/ristretto"
	"github.com/rogpeppe/go-internal/cache"
)

// Vente fields
type Vente struct {
	ID         string                 `json:"id"`
	Montant    float64                `json:"montant"`
	Extensions map[string]interface{} `json:"extensions"`
}

// Migration fields
type Migration struct {
	Entity     string      `json:"entity"`
	Version    int         `json:"version"`
	Operations []Operation `json:"operations"`
}

// SQL Operation fields
type Operation struct {
	Type     string `json:"type"`
	Table    string `json:"table"`
	Column   string `json:"column"`
	SQLType  string `json:"sql_type"`
	Nullable bool   `json:"nullable"`
}

// Module fields
type Module struct {
	Active      bool                `json:"active"`
	Path        string              `json:"path"`
	Name        string              `json:"name"`
	DisplayName string              `json:"display_name"`
	Version     string              `json:"version"`
	Author      string              `json:"author"`
	Description string              `json:"description"`
	Depends     []string            `json:"depends"`
	StaticFiles map[string][]string `json:"static_files"`
	Comportment string              `json:"comportment"` // core (create an entire container for this service)/thread (create a thread on the inherited service)/inherited (use the inherited service's thread to run)
	Thread      string              `json:"thread"`
	AutoInstall bool                `json:"auto_install"`
}

type ModuleCache struct {
	config *cache.Cache
	wasm   *ristretto.Cache
}
