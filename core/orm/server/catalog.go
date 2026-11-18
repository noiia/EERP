package server

import (
	"context"
	"slices"
	"sort"

	"core/orm/access"
	"core/orm/internal/registry"
)

// APIField describes an API-visible field. It deliberately contains neither
// reflection internals nor fields excluded from the HTTP surface.
type APIField struct {
	Name     string `json:"name"`
	Column   string `json:"column"`
	Type     string `json:"type"`
	Nullable bool   `json:"nullable"`
	ReadOnly bool   `json:"read_only"`
}

// APIModel describes a model on the generic HTTP surface.
type APIModel struct {
	Name       string     `json:"name"`
	Route      string     `json:"route"`
	PrimaryKey string     `json:"primary_key"`
	SoftDelete bool       `json:"soft_delete"`
	Fields     []APIField `json:"fields"`
}

// ModelCatalog returns public API metadata, applying the same field group gates
// as CRUD responses. Callers must additionally check model read permissions.
func ModelCatalog(ctx context.Context) []APIModel {
	groups, _ := access.GroupsFromContext(ctx)
	models := make([]APIModel, 0)
	for _, meta := range registry.All() {
		model := APIModel{Name: meta.TableName, Route: meta.RoutePrefix,
			PrimaryKey: meta.PKField.Name, SoftDelete: meta.SoftDelete, Fields: []APIField{}}
		for _, f := range meta.Fields {
			if len(f.Groups) > 0 && !slices.ContainsFunc(f.Groups, func(g string) bool { return slices.Contains(groups, g) }) {
				continue
			}
			model.Fields = append(model.Fields, APIField{Name: f.Name, Column: f.Column,
				Type: f.GoType, Nullable: f.Nullable, ReadOnly: f.ReadOnly})
		}
		models = append(models, model)
	}
	sort.Slice(models, func(i, j int) bool { return models[i].Name < models[j].Name })
	return models
}
