package teams

import (
	"slices"
	"testing"

	"core/orm"
)

func TestTables_RegisteredButNotExposed(t *testing.T) {
	if err := (&teamsModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}
	registered, exposed := orm.RegisteredTableNames(), orm.ExposedTableNames()
	for _, tbl := range []string{"team", "team_member", "chat_channel", "chat_channel_member", "chat_message",
		"chat_attachment", "chat_reaction", "team_folder", "team_file", "team_file_share"} {
		if !slices.Contains(registered, tbl) {
			t.Errorf("%s must be registered", tbl)
		}
		if slices.Contains(exposed, tbl) {
			t.Errorf("%s must not be exposed on the generic CRUD surface", tbl)
		}
	}
}
