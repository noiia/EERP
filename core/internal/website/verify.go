package website

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"

	"core/orm"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/labstack/echo/v5"
)

// AttachFunc links a just-verified website user's earlier anonymous bookings
// (spec 4). Passed in by app.go so this package never imports an ERP module.
type AttachFunc func(ctx context.Context, tx *orm.Tx, tenant, userID uuid.UUID, email string) error

// VerifyHandler confirms a website account's email address.
type VerifyHandler struct {
	db     *orm.DB
	attach AttachFunc
}

func NewVerifyHandler(db *orm.DB, attach AttachFunc) *VerifyHandler {
	return &VerifyHandler{db: db, attach: attach}
}

var errBadToken = errors.New("bad token")

// Verify handles POST /api/v1/website/auth/verify {token} (POST only: mail
// scanners prefetch GET links). Only the token's sha256 is stored, and an
// unknown, expired or already-used token is the same 400. Verification and
// the history attach commit together — history is never attached before the
// address is proven, so signing up with someone's email claims nothing.
func (h *VerifyHandler) Verify(c *echo.Context) error {
	var req struct {
		Token string `json:"token"`
	}
	if err := c.Bind(&req); err != nil || len(req.Token) != 64 {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid or expired link")
	}
	sum := sha256.Sum256([]byte(req.Token))
	ctx := c.Request().Context()
	err := orm.Transact(ctx, h.db, func(tx *orm.Tx) error {
		var id, tenant uuid.UUID
		var email string
		err := tx.QueryRow(ctx, `
			UPDATE users SET email_verified_at = now(), verify_token_hash = '', verify_expires_at = NULL, updated_at = now()
			WHERE verify_token_hash = $1 AND verify_expires_at > now() AND kind = 'website' AND deleted_at IS NULL
			RETURNING id, tenant_id, email`, hex.EncodeToString(sum[:])).Scan(&id, &tenant, &email)
		if errors.Is(err, pgx.ErrNoRows) {
			return errBadToken
		}
		if err != nil {
			return err
		}
		return h.attach(ctx, tx, tenant, id, email)
	})
	if errors.Is(err, errBadToken) {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid or expired link")
	}
	if err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}
