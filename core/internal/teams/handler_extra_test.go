package teams_test

import (
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/teams"
	"core/internal/testdb"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func TestCreateAndListTeams(t *testing.T) {
	f := newFixture(t)
	for body, want := range map[string]int{`{`: 400, `{"name":" "}`: 422} {
		if rec := serve(t, f.h.CreateTeam, "POST", body, f.as(f.staff), nil); rec.Code != want {
			t.Fatalf("create %s: %d, want %d", body, rec.Code, want)
		}
	}
	rec := serve(t, f.h.CreateTeam, "POST", `{"name":"Mine","description":"d"}`, f.as(f.staff), nil)
	var created struct{ ID, Role string }
	if rec.Code != 201 || jsonDecode(rec, &created) != nil || created.Role != teams.RoleOwner {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	id := uuid.MustParse(created.ID)
	t.Cleanup(func() { _, _ = f.repo.DeleteTeam(t.Context(), f.tenant, id) })

	rec = serve(t, f.h.ListTeams, "GET", "", f.as(f.staff), nil)
	var out struct{ Data []struct{ ID string } }
	if rec.Code != 200 || jsonDecode(rec, &out) != nil || len(out.Data) != 1 || out.Data[0].ID != created.ID {
		t.Fatalf("list: %d %s", rec.Code, rec.Body)
	}
	// other teams stay invisible
	if rec := serve(t, f.h.ListTeams, "GET", "", f.as(f.outside), nil); !strings.Contains(rec.Body.String(), `"data":[]`) {
		t.Fatalf("outsider list: %s", rec.Body)
	}
}

func TestListMembers(t *testing.T) {
	f := newFixture(t)
	p := map[string]string{"id": f.team.String()}
	rec := serve(t, f.h.ListMembers, "GET", "", f.as(f.guest), p)
	var out struct {
		Data []struct {
			UserID string `json:"user_id"`
			Role   string
		}
	}
	if rec.Code != 200 || jsonDecode(rec, &out) != nil || len(out.Data) != 3 {
		t.Fatalf("members: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(t, f.h.ListMembers, "GET", "", f.as(f.outside), p); rec.Code != 404 {
		t.Fatalf("outsider: %d", rec.Code)
	}
	if rec := serve(t, f.h.SetMemberRole, "PUT", `{"role":"boss"}`, f.as(f.owner), map[string]string{"id": f.team.String(), "user": f.member.String()}); rec.Code != 400 {
		t.Fatalf("bad role: %d", rec.Code)
	}
	if rec := serve(t, f.h.SetMemberRole, "PUT", `{"role":"owner"}`, f.as(f.owner), map[string]string{"id": f.team.String(), "user": f.member.String()}); rec.Code != 204 {
		t.Fatalf("promote: %d %s", rec.Code, rec.Body)
	}
}

// With the database down every route answers 500, never a silent 2xx or a 404.
func TestHandlers_DatabaseDown(t *testing.T) {
	app := testdb.Closed(t)
	h := teams.NewHandler(teams.NewRepository(app.DB), auth.NewUserRepository(app.DB), &fakePusher{}, &fakeNotifier{}, &memStore{objs: map[string][]byte{}})
	id := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}
	x := uuid.NewString()
	all := map[string]string{"id": x, "channel": x, "message": x, "file": x, "folder": x, "user": x}
	rows := []struct {
		name   string
		fn     echo.HandlerFunc
		method string
		body   string
	}{
		{"ListTeams", h.ListTeams, "GET", ""},
		{"CreateTeam", h.CreateTeam, "POST", `{"name":"T"}`},
		{"GetTeam", h.GetTeam, "GET", ""},
		{"Directory", h.Directory, "GET", ""},
		{"ListMembers", h.ListMembers, "GET", ""},
		{"RemoveMember", h.RemoveMember, "DELETE", ""},
		{"ListDirect", h.ListDirect, "GET", ""},
		{"OpenDirect", h.OpenDirect, "POST", `{"user_id":"` + x + `"}`},
		{"ListMessages", h.ListMessages, "GET", ""},
		{"PostMessage", h.PostMessage, "POST", `{"body":"hi"}`},
		{"MarkRead", h.MarkRead, "POST", ""},
		{"ToggleReaction", h.ToggleReaction, "POST", `{"emoji":"👍"}`},
		{"GetAttachment", h.GetAttachment, "GET", ""},
		{"DownloadFile", h.DownloadFile, "GET", ""},
		{"GetShares", h.GetShares, "GET", ""},
		{"PutShares", h.PutShares, "PUT", `{"user_ids":[]}`},
		{"ListShared", h.ListShared, "GET", ""},
	}
	for _, r := range rows {
		t.Run(r.name, func(t *testing.T) {
			if rec := serve(t, r.fn, r.method, r.body, id, all); rec.Code != 500 {
				t.Fatalf("got %d, want 500: %s", rec.Code, rec.Body)
			}
		})
	}
}
