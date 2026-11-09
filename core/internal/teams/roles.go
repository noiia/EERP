package teams

import (
	"sort"

	"github.com/google/uuid"
)

const (
	RoleOwner  = "owner"
	RoleMember = "member"
	RoleGuest  = "guest"
)

func CanRead(role string) bool   { return role == RoleOwner || role == RoleMember || role == RoleGuest }
func CanWrite(role string) bool  { return role == RoleOwner || role == RoleMember }
func CanManage(role string) bool { return role == RoleOwner }

// CanEditItem: an owner edits anything, a member only what they created.
func CanEditItem(role string, createdBy, caller uuid.UUID) bool {
	return role == RoleOwner || (role == RoleMember && createdBy == caller)
}

// DirectKey identifies a two-person conversation regardless of argument order.
func DirectKey(a, b uuid.UUID) string {
	k := []string{a.String(), b.String()}
	sort.Strings(k)
	return k[0] + ":" + k[1]
}
