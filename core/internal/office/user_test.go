package office

import (
	"reflect"
	"testing"

	"core/internal/auth"
	"core/orm/model"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

func TestCollaborationUser(t *testing.T) {
	id := uuid.New()
	handle := "  simon  "
	for _, tc := range []struct {
		label string
		user  auth.Users
		name  string
	}{
		{"display name", auth.Users{DisplayName: " Simon D. ", Name: "Simon", Surname: "Dupont", Email: "simon@example.test"}, "Simon D."},
		{"full name", auth.Users{Name: " Simon ", Surname: " Dupont ", Email: "simon@example.test"}, "Simon Dupont"},
		{"surname", auth.Users{Surname: "Dupont"}, "Dupont"},
		{"handle", auth.Users{Username: &handle, Email: "simon@example.test"}, "simon"},
		{"email", auth.Users{DisplayName: "  ", Email: " simon@example.test "}, "simon@example.test"},
		{"id", auth.Users{}, id.String()},
	} {
		t.Run(tc.label, func(t *testing.T) {
			tc.user.BaseModel = model.BaseModel{ID: id}
			profile := collaborationUser(tc.user)
			if profile["id"] != id.String() || profile["name"] != tc.name {
				t.Fatal(profile)
			}
		})
	}
}

func TestSessionSignsAuthenticatedProfile(t *testing.T) {
	f := setup(t)
	f.users.user.DisplayName = ""
	f.users.user.Name = "Simon"
	f.users.user.Surname = "Dupont"
	avatar := true
	f.users.user.Avatar = &avatar
	session := f.session(t)
	profile := editor(session)["user"].(map[string]any)
	if profile["name"] != "Simon Dupont" || profile["id"] != f.users.user.ID.String() || profile["image"] != "https://office.example/api/avatars/"+f.users.user.ID.String() {
		t.Fatal(profile)
	}
	if editor(session)["coEditing"].(map[string]any)["mode"] != "fast" {
		t.Fatal("collaboration mode")
	}
	config := session["config"].(map[string]any)
	claims := jwt.MapClaims{}
	if _, err := jwt.ParseWithClaims(config["token"].(string), claims, func(*jwt.Token) (any, error) { return f.service.secret, nil }, jwt.WithValidMethods([]string{"HS256"})); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(claims["editorConfig"].(map[string]any)["user"], profile) {
		t.Fatal("unsigned collaborator profile")
	}
}

func TestSessionRejectsMismatchedProfile(t *testing.T) {
	f := setup(t)
	f.users.user.TenantID = uuid.New()
	w := f.request("GET", "/api/v1/office/team-file/"+f.doc.ID.String()+"/session", "")
	if w.Code != 401 {
		t.Fatalf("profile mismatch: %d", w.Code)
	}
}
