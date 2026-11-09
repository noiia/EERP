package teams_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/teams"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func serve(t *testing.T, h echo.HandlerFunc, method, body string, id auth.Identity, params map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, "/", rd)
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(auth.SetIdentity(req.Context(), id))
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	for k, v := range params {
		c.SetPathValues(append(c.PathValues(), echo.PathValue{Name: k, Value: v}))
	}
	if err := h(c); err != nil {
		e.HTTPErrorHandler(c, err)
	}
	return rec
}

type fixture struct {
	h              *teams.Handler
	app            *orm.App
	tenant         uuid.UUID
	team           uuid.UUID
	owner, member  uuid.UUID
	guest, outside uuid.UUID
	staff          uuid.UUID // staff user not in the team
	website        uuid.UUID
}

func (f fixture) as(u uuid.UUID) auth.Identity { return auth.Identity{UserID: u, TenantID: f.tenant} }

func newFixture(t *testing.T) fixture {
	t.Helper()
	r, app := setup(t)
	ctx := context.Background()
	f := fixture{app: app, tenant: uuid.New(), owner: uuid.New(), member: uuid.New(), guest: uuid.New(),
		outside: uuid.New(), staff: uuid.New(), website: uuid.New()}
	for _, u := range []struct {
		id   uuid.UUID
		kind string
	}{{f.owner, "staff"}, {f.member, "staff"}, {f.guest, "staff"}, {f.outside, "staff"}, {f.staff, "staff"}, {f.website, auth.KindWebsite}} {
		if _, err := app.DB.Exec(ctx, `INSERT INTO users (id, tenant_id, email, password_hash, kind) VALUES ($1,$2,$3,'x',$4)`,
			u.id, f.tenant, u.id.String()+"@t.test", u.kind); err != nil {
			t.Fatal(err)
		}
	}
	team, _, err := r.CreateTeam(ctx, teams.Team{TenantID: f.tenant, Name: "T"}, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	f.team = team.ID
	if _, err := r.AddMember(ctx, f.tenant, team.ID, f.member, teams.RoleMember); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AddMember(ctx, f.tenant, team.ID, f.guest, teams.RoleGuest); err != nil {
		t.Fatal(err)
	}
	f.h = teams.NewHandler(r, auth.NewUserRepository(app.DB), nil, nil, nil)
	t.Cleanup(func() {
		_, _ = r.DeleteTeam(ctx, f.tenant, f.team)
		_, _ = app.DB.Exec(ctx, `DELETE FROM users WHERE tenant_id=$1`, f.tenant)
	})
	return f
}

func TestTeamRoutes_RoleMatrix(t *testing.T) {
	f := newFixture(t)
	roles := []struct {
		name string
		user uuid.UUID
	}{{"owner", f.owner}, {"member", f.member}, {"guest", f.guest}, {"none", f.outside}}
	rows := []struct {
		route  string
		method string
		fn     echo.HandlerFunc
		body   string
		want   [4]int
	}{
		{"PUT team", "PUT", f.h.UpdateTeam, `{"name":"New"}`, [4]int{200, 403, 403, 404}},
		{"POST member", "POST", f.h.AddMember, `{"user_id":"` + f.staff.String() + `","role":"guest"}`, [4]int{201, 403, 403, 404}},
		{"POST channel", "POST", f.h.CreateChannel, `{"name":"dev"}`, [4]int{201, 403, 403, 404}},
		{"GET channels", "GET", f.h.ListChannels, "", [4]int{200, 200, 200, 404}},
		{"GET team", "GET", f.h.GetTeam, "", [4]int{200, 200, 200, 404}},
	}
	for _, r := range rows {
		for i, role := range roles {
			t.Run(r.route+"/"+role.name, func(t *testing.T) {
				rec := serve(t, r.fn, r.method, r.body, f.as(role.user), map[string]string{"id": f.team.String()})
				if rec.Code != r.want[i] {
					t.Fatalf("got %d, want %d: %s", rec.Code, r.want[i], rec.Body)
				}
			})
		}
	}
}

func TestRemoveAndDemoteLastOwner_409(t *testing.T) {
	f := newFixture(t)
	p := map[string]string{"id": f.team.String(), "user": f.owner.String()}
	if rec := serve(t, f.h.RemoveMember, "DELETE", "", f.as(f.owner), p); rec.Code != 409 || !strings.Contains(rec.Body.String(), "LAST_OWNER") {
		t.Fatalf("remove: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(t, f.h.SetMemberRole, "PUT", `{"role":"member"}`, f.as(f.owner), p); rec.Code != 409 {
		t.Fatalf("demote: %d %s", rec.Code, rec.Body)
	}
}

func TestMemberCanLeave(t *testing.T) {
	f := newFixture(t)
	p := map[string]string{"id": f.team.String(), "user": f.member.String()}
	if rec := serve(t, f.h.RemoveMember, "DELETE", "", f.as(f.member), p); rec.Code != 204 {
		t.Fatalf("leave: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(t, f.h.GetTeam, "GET", "", f.as(f.member), map[string]string{"id": f.team.String()}); rec.Code != 404 {
		t.Fatalf("after leaving: %d", rec.Code)
	}
	// a member can't remove someone else
	p["user"] = f.guest.String()
	if rec := serve(t, f.h.RemoveMember, "DELETE", "", f.as(f.guest), map[string]string{"id": f.team.String(), "user": f.owner.String()}); rec.Code != 403 {
		t.Fatalf("guest removing owner: %d", rec.Code)
	}
}

func TestAddMember_Rules(t *testing.T) {
	f := newFixture(t)
	p := map[string]string{"id": f.team.String()}
	if rec := serve(t, f.h.AddMember, "POST", `{"user_id":"`+f.website.String()+`","role":"member"}`, f.as(f.owner), p); rec.Code != 422 {
		t.Fatalf("website user: %d", rec.Code)
	}
	if rec := serve(t, f.h.AddMember, "POST", `{"user_id":"`+f.member.String()+`","role":"member"}`, f.as(f.owner), p); rec.Code != 409 {
		t.Fatalf("duplicate: %d", rec.Code)
	}
}

func TestChannels_LastChannelKept(t *testing.T) {
	f := newFixture(t)
	rec := serve(t, f.h.ListChannels, "GET", "", f.as(f.owner), map[string]string{"id": f.team.String()})
	var out struct{ Data []struct{ ID string } }
	if err := jsonDecode(rec, &out); err != nil || len(out.Data) != 1 {
		t.Fatalf("channels: %v %s", err, rec.Body)
	}
	p := map[string]string{"id": f.team.String(), "channel": out.Data[0].ID}
	if rec := serve(t, f.h.DeleteChannel, "DELETE", "", f.as(f.owner), p); rec.Code != 409 {
		t.Fatalf("delete last: %d", rec.Code)
	}
	if rec := serve(t, f.h.RenameChannel, "PUT", `{"name":"main"}`, f.as(f.owner), p); rec.Code != 200 {
		t.Fatalf("rename: %d", rec.Code)
	}
}

func TestDeleteTeam(t *testing.T) {
	f := newFixture(t)
	p := map[string]string{"id": f.team.String()}
	if rec := serve(t, f.h.DeleteTeam, "DELETE", "", f.as(f.member), p); rec.Code != 403 {
		t.Fatalf("member delete: %d", rec.Code)
	}
	if rec := serve(t, f.h.DeleteTeam, "DELETE", "", f.as(f.owner), p); rec.Code != 204 {
		t.Fatalf("owner delete: %d", rec.Code)
	}
	if rec := serve(t, f.h.GetTeam, "GET", "", f.as(f.owner), p); rec.Code != 404 {
		t.Fatalf("after delete: %d", rec.Code)
	}
}

func TestDirectory_ExcludesWebsiteUsers(t *testing.T) {
	f := newFixture(t)
	rec := serve(t, f.h.Directory, "GET", "", f.as(f.owner), nil)
	if rec.Code != 200 || strings.Contains(rec.Body.String(), f.website.String()) || !strings.Contains(rec.Body.String(), f.staff.String()) {
		t.Fatalf("directory: %d %s", rec.Code, rec.Body)
	}
}

func TestActiveGate_404WhenInactive(t *testing.T) {
	next := func(c *echo.Context) error { return c.NoContent(200) }
	for active, want := range map[bool]int{true: 200, false: 404} {
		rec := serve(t, teams.ActiveGate(func(string) bool { return active })(next), "GET", "", auth.Identity{}, nil)
		if rec.Code != want {
			t.Errorf("active=%v: %d", active, rec.Code)
		}
	}
}

func jsonDecode(rec *httptest.ResponseRecorder, v any) error {
	return json.Unmarshal(rec.Body.Bytes(), v)
}
