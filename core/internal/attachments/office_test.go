package attachments

import (
	"context"
	"net/http/httptest"
	"testing"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func TestOfficeSourceUsesAttachmentPermissionAndTenant(t *testing.T) {
	tenant, user, id := uuid.New(), uuid.New(), uuid.New()
	store := &stubAttachments{found: Attachment{ID: id, Filename: "Invoice.docx", ObjectKey: "private", TableName: "invoice", RecordID: uuid.New()}}
	handler := NewHandler(store, &stubObjects{})
	for _, allowed := range []bool{false, true} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest("GET", "/", nil)
		request = request.WithContext(auth.SetIdentity(request.Context(), auth.Identity{UserID: user, TenantID: tenant, Roles: []string{"staff"}}))
		c := echo.New().NewContext(request, recorder)
		source := handler.OfficeSource(func(_ context.Context, roles []string, permission string) (bool, error) {
			if len(roles) != 1 || roles[0] != "staff" || permission != "attachments:attachments:read" {
				t.Fatal("wrong permission", roles, permission)
			}
			return allowed, nil
		})
		doc, ok, err := source.Resolve(c, id)
		if err != nil {
			t.Fatal(err)
		}
		if !allowed {
			if ok || recorder.Code != 403 {
				t.Fatalf("permission bypass: %v %d", ok, recorder.Code)
			}
			continue
		}
		if !ok || doc.ID != id || doc.Writable || source.Replace != nil || store.gotTenant != tenant {
			t.Fatal("incorrect attachment scope", doc, store.gotTenant)
		}
		store.foundErr = orm.ErrNotFound
		_, ok, err = source.Resolve(c, id)
		if ok || err != nil || recorder.Code != 404 {
			t.Fatal("missing attachment", ok, err, recorder.Code)
		}
	}
}
