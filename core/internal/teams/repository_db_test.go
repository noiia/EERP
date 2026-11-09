package teams_test

import (
	"context"
	"errors"
	"testing"

	_ "core/modules/auth"
	_ "core/modules/teams"

	"core/internal/teams"
	"core/internal/testdb"
	"core/orm"

	"github.com/google/uuid"
)

func setup(t *testing.T) (*teams.Repository, *orm.App) {
	t.Helper()
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth", "teams")
	return teams.NewRepository(app.DB), app
}

func TestCreateTeam_OwnerAndGeneral(t *testing.T) {
	r, app := setup(t)
	ctx, tenant, owner := context.Background(), uuid.New(), uuid.New()
	team, ch, err := r.CreateTeam(ctx, teams.Team{TenantID: tenant, Name: "  Ops "}, owner)
	if err != nil {
		t.Fatal(err)
	}
	if team.Name != "Ops" || ch.Name != "general" || ch.TeamID == nil || *ch.TeamID != team.ID {
		t.Fatalf("unexpected team/channel: %+v %+v", team, ch)
	}
	role, err := r.RoleOf(ctx, tenant, team.ID, owner)
	if err != nil || role != teams.RoleOwner {
		t.Fatalf("role = %q, %v", role, err)
	}
	var n int
	if err := app.DB.QueryRow(ctx, `SELECT count(*) FROM chat_channel WHERE team_id=$1 AND name='general'`, team.ID).Scan(&n); err != nil || n != 1 {
		t.Fatalf("general channels = %d, %v", n, err)
	}
	if _, _, err := r.CreateTeam(ctx, teams.Team{TenantID: tenant, Name: " "}, owner); err == nil {
		t.Error("blank name must be refused")
	}
}

func TestRoleOf_NonMember(t *testing.T) {
	r, _ := setup(t)
	ctx, tenant := context.Background(), uuid.New()
	team, _, err := r.CreateTeam(ctx, teams.Team{TenantID: tenant, Name: "A"}, uuid.New())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.RoleOf(ctx, tenant, team.ID, uuid.New()); !errors.Is(err, orm.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if _, err := r.RoleOf(ctx, uuid.New(), team.ID, uuid.New()); !errors.Is(err, orm.ErrNotFound) {
		t.Fatalf("other tenant err = %v", err)
	}
}

func TestListMyTeams_OnlyMine(t *testing.T) {
	r, _ := setup(t)
	ctx, tenant, me, other := context.Background(), uuid.New(), uuid.New(), uuid.New()
	mine, _, err := r.CreateTeam(ctx, teams.Team{TenantID: tenant, Name: "Mine"}, me)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := r.CreateTeam(ctx, teams.Team{TenantID: tenant, Name: "Theirs"}, other); err != nil {
		t.Fatal(err)
	}
	got, err := r.ListMyTeams(ctx, tenant, me)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != mine.ID || got[0].MemberCount != 1 || got[0].Role != teams.RoleOwner {
		t.Fatalf("got %+v", got)
	}
}
