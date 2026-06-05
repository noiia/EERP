//go:build wasip1

package main

import (
	"encoding/json"
	"unsafe"
)

// Local mirror of core/internal/types.Migration — no host dependencies in WASM.

type migration struct {
	Entity     string      `json:"entity"`
	Version    int         `json:"version"`
	Operations []operation `json:"operations"`
}

type operation struct {
	Type     string `json:"type"`
	Table    string `json:"table"`
	Column   string `json:"column"`
	SQLType  string `json:"sql_type"`
	Nullable bool   `json:"nullable"`
}

type route struct {
	Method  string `json:"method"`
	Path    string `json:"path"`
	Handler string `json:"handler"`
}

type routeManifest struct {
	Module string  `json:"module"`
	Routes []route `json:"routes"`
}

var (
	migratePayload []byte
	routesPayload  []byte
)

func init() {
	m := migration{
		Entity:  "crm",
		Version: 1,
		Operations: []operation{
			{Type: "add_column", Table: "contact", Column: "name", SQLType: "TEXT", Nullable: false},
			{Type: "add_column", Table: "contact", Column: "email", SQLType: "TEXT", Nullable: false},
			{Type: "add_column", Table: "contact", Column: "company", SQLType: "TEXT", Nullable: false},
			{Type: "add_column", Table: "contact", Column: "status", SQLType: "TEXT", Nullable: false},
		},
	}

	r := routeManifest{
		Module: "crm",
		Routes: []route{
			{Method: "GET", Path: "/contacts", Handler: "list_contacts"},
			{Method: "GET", Path: "/contacts/:id", Handler: "get_contact"},
			{Method: "POST", Path: "/contacts", Handler: "create_contact"},
			{Method: "PUT", Path: "/contacts/:id", Handler: "update_contact"},
			{Method: "DELETE", Path: "/contacts/:id", Handler: "delete_contact"},
			{Method: "POST", Path: "/contacts/:id/restore", Handler: "restore_contact"},
			{Method: "PUT", Path: "/contacts/:id/convert", Handler: "convert_to_customer"},
		},
	}

	var err error
	migratePayload, err = json.Marshal(m)
	if err != nil {
		panic(err)
	}
	routesPayload, err = json.Marshal(r)
	if err != nil {
		panic(err)
	}
}

//go:wasmexport migrate
func migrate() int32 {
	return int32(uintptr(unsafe.Pointer(&migratePayload[0])))
}

//go:wasmexport migrate_len
func migrate_len() int32 {
	return int32(len(migratePayload))
}

//go:wasmexport routes
func routes() int32 {
	return int32(uintptr(unsafe.Pointer(&routesPayload[0])))
}

//go:wasmexport routes_len
func routes_len() int32 {
	return int32(len(routesPayload))
}

func main() {}
