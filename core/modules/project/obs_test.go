package project

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func (f *fixture) user(kind string) uuid.UUID {
	id := f.id(`INSERT INTO users (tenant_id, email, kind) VALUES ($1, $2, $3) RETURNING id`, f.tenant, uuid.NewString()+"@t.example", kind)
	f.t.Cleanup(func() { _, _ = f.app.DB.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id) })
	return id
}

func (f *fixture) obsBox(project uuid.UUID, parent *uuid.UUID) uuid.UUID {
	return f.id(`INSERT INTO project_obs_box (tenant_id, project_id, parent_id, kind, x, y) VALUES ($1, $2, $3, 'text', 0, 0) RETURNING id`,
		f.tenant, project, parent)
}

func TestObsBoxRules(t *testing.T) {
	f := newFixture(t)
	other := f.sibling()
	m, mem := uuid.New(), uuid.New()
	me, member, stranger := f.caller(m), f.caller(mem), f.caller(uuid.New())
	p, q := f.project(m, "members"), f.project(m, "everyone")
	f.member(p, mem)
	contact, foreign := f.contactOf("contact"), other.contactOf("contact")
	staff, visitor := f.user(""), f.user("website")
	box := func(extra map[string]any) map[string]any {
		body := map[string]any{"project_id": p, "kind": "text"}
		for k, v := range extra {
			body[k] = v
		}
		return body
	}
	a := f.obsBox(p, nil)
	b := f.obsBox(p, &a)
	inQ := f.obsBox(q, nil)
	path := "project_obs_box/"
	f.run(t, []writeCase{
		{"text box", me, http.MethodPost, "project_obs_box", box(map[string]any{"x": 10, "y": 20}), 201},
		{"text box without position", me, http.MethodPost, "project_obs_box", box(nil), 201},
		{"contact box", me, http.MethodPost, "project_obs_box", box(map[string]any{"kind": "contact", "contact_id": contact}), 201},
		{"user box", me, http.MethodPost, "project_obs_box", box(map[string]any{"kind": "user", "user_id": staff}), 201},
		{"contact without contact_id", me, http.MethodPost, "project_obs_box", box(map[string]any{"kind": "contact"}), 422},
		{"user with a contact_id", me, http.MethodPost, "project_obs_box", box(map[string]any{"kind": "user", "user_id": staff, "contact_id": contact}), 422},
		{"text with a user_id", me, http.MethodPost, "project_obs_box", box(map[string]any{"user_id": staff}), 422},
		{"unknown kind", me, http.MethodPost, "project_obs_box", box(map[string]any{"kind": "robot"}), 422},
		{"another tenant's contact", me, http.MethodPost, "project_obs_box", box(map[string]any{"kind": "contact", "contact_id": foreign}), 422},
		{"website user", me, http.MethodPost, "project_obs_box", box(map[string]any{"kind": "user", "user_id": visitor}), 422},
		{"unknown user", me, http.MethodPost, "project_obs_box", box(map[string]any{"kind": "user", "user_id": uuid.New()}), 422},
		{"named color", me, http.MethodPost, "project_obs_box", box(map[string]any{"color": "red"}), 422},
		{"null color", me, http.MethodPost, "project_obs_box", box(map[string]any{"color": nil}), 201},
		{"title too long", me, http.MethodPost, "project_obs_box", box(map[string]any{"title": strings.Repeat("é", 201)}), 422},
		{"title of 200", me, http.MethodPost, "project_obs_box", box(map[string]any{"title": strings.Repeat("é", 200)}), 201},
		{"text too long", me, http.MethodPost, "project_obs_box", box(map[string]any{"text": strings.Repeat("a", 2001)}), 422},
		{"parent in another project", me, http.MethodPost, "project_obs_box", box(map[string]any{"parent_id": inQ}), 422},
		{"valid parent", me, http.MethodPost, "project_obs_box", box(map[string]any{"parent_id": a}), 201},
		{"cycle", me, http.MethodPut, path + a.String(), map[string]any{"parent_id": b}, 422},
		{"own parent", me, http.MethodPut, path + a.String(), map[string]any{"parent_id": a}, 422},
		{"project change", me, http.MethodPut, path + a.String(), map[string]any{"project_id": q}, 422},
		{"member creates", member, http.MethodPost, "project_obs_box", box(nil), 403},
		{"member updates", member, http.MethodPut, path + a.String(), map[string]any{"x": 5}, 403},
		{"member deletes", member, http.MethodDelete, path + a.String(), nil, 403},
		{"stranger updates", stranger, http.MethodPut, path + a.String(), map[string]any{"x": 5}, 404},
		{"manager moves", me, http.MethodPut, path + a.String(), map[string]any{"x": 5, "y": 6}, 200},
	})

	t.Run("color stored lowercase", func(t *testing.T) {
		code, body := f.do(me, http.MethodPost, "project_obs_box", box(map[string]any{"color": "#FFAA00"}))
		if code != http.StatusCreated || body["color"] != "#ffaa00" {
			t.Fatalf("%d %v, want 201 with #ffaa00", code, body)
		}
	})
	t.Run("reads", func(t *testing.T) {
		if n := f.total(member, "project_obs_box?filter[project_id]="+p.String()); n == 0 {
			t.Errorf("member sees no box")
		}
		if n := f.total(stranger, "project_obs_box?filter[project_id]="+p.String()); n != 0 {
			t.Errorf("stranger sees %d boxes", n)
		}
		if code, _ := f.get(stranger, path+a.String()); code != http.StatusNotFound {
			t.Errorf("stranger get: %d, want 404", code)
		}
	})
}

func TestDeleteObsBox_OrphansChildren(t *testing.T) {
	f := newFixture(t)
	m := uuid.New()
	me := f.caller(m)
	p := f.project(m, "everyone")
	root := f.obsBox(p, nil)
	c1, c2 := f.obsBox(p, &root), f.obsBox(p, &root)
	if code, body := f.do(me, http.MethodDelete, "project_obs_box/"+root.String(), nil); code != http.StatusNoContent {
		t.Fatalf("delete: %d %v, want 204", code, body)
	}
	for _, c := range []uuid.UUID{c1, c2} {
		if got := f.str(`SELECT parent_id FROM project_obs_box WHERE id = $1 AND deleted_at IS NULL`, c); got != "" {
			t.Errorf("child %v still has parent %v", c, got)
		}
	}
	if got := f.str(`SELECT deleted_at IS NOT NULL FROM project_obs_box WHERE id = $1`, root); got != "true" {
		t.Errorf("box not deleted")
	}
}
