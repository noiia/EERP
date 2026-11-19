package teams

import (
	"testing"

	"github.com/google/uuid"
)

func TestRolePredicates(t *testing.T) {
	me, other := uuid.New(), uuid.New()
	tests := []struct {
		role                         string
		read, write, manage, editOwn bool
		editOther                    bool
	}{
		{RoleOwner, true, true, true, true, true},
		{RoleMember, true, true, false, true, false},
		{RoleGuest, true, false, false, false, false},
	}
	for _, tc := range tests {
		t.Run(tc.role, func(t *testing.T) {
			if CanRead(tc.role) != tc.read || CanWrite(tc.role) != tc.write || CanManage(tc.role) != tc.manage {
				t.Errorf("read/write/manage mismatch for %s", tc.role)
			}
			if CanEditItem(tc.role, me, me) != tc.editOwn || CanEditItem(tc.role, other, me) != tc.editOther {
				t.Errorf("CanEditItem mismatch for %s", tc.role)
			}
		})
	}
	if CanRead("") || CanWrite("bogus") {
		t.Error("unknown role must have no rights")
	}
}

func TestDirectKey_OrderIndependent(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	if DirectKey(a, b) != DirectKey(b, a) {
		t.Fatal("DirectKey must not depend on argument order")
	}
}
