package website

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/labstack/echo/v5"
)

// AttachFunc links a just-verified website user's earlier anonymous bookings
// (spec 4). Passed in by app.go so this package never imports an ERP module.
type AttachFunc func(ctx context.Context, tx *orm.Tx, tenant, userID uuid.UUID, email string) error

type verificationResender interface {
	ResendVerification(ctx context.Context, tenantID, userID uuid.UUID, siteURL string) error
}

// VerifyHandler confirms a website account's email address, behind
// WebsiteJWTMiddleware: a token only verifies the account it was issued to,
// and only from that account's own session.
type VerifyHandler struct {
	db      *orm.DB
	attach  AttachFunc
	users   verificationResender
	siteURL string
}

func NewVerifyHandler(db *orm.DB, attach AttachFunc, users verificationResender, siteURL string) *VerifyHandler {
	return &VerifyHandler{db: db, attach: attach, users: users, siteURL: siteURL}
}

var errBadToken = errors.New("bad token")

// Verify handles POST /api/v1/website/me/verify {token} (POST only: mail
// scanners prefetch GET links). Only the token's sha256 is stored, and an
// unknown, expired, already-used or someone else's token is the same 400.
// The token must belong to the caller's own account: otherwise an attacker
// signing up with a victim's address could get the victim to click the link
// and inherit their history. Verification and the history attach commit
// together — never attached before the address is proven.
func (h *VerifyHandler) Verify(c *echo.Context) error {
	var req struct {
		Token string `json:"token"`
	}
	if err := c.Bind(&req); err != nil || len(req.Token) != 64 {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid or expired link")
	}
	sum := sha256.Sum256([]byte(req.Token))
	ctx := c.Request().Context()
	caller := auth.MustIdentity(ctx)
	err := orm.Transact(ctx, h.db, func(tx *orm.Tx) error {
		var id, tenant uuid.UUID
		var email string
		err := tx.QueryRow(ctx, `
			UPDATE users SET email_verified_at = now(), verify_token_hash = '', verify_expires_at = NULL, updated_at = now()
			WHERE verify_token_hash = $1 AND id = $2 AND tenant_id = $3
			  AND verify_expires_at > now() AND kind = 'website' AND deleted_at IS NULL
			RETURNING id, tenant_id, email`, hex.EncodeToString(sum[:]), caller.UserID, caller.TenantID).Scan(&id, &tenant, &email)
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

// Resend handles POST /api/v1/website/me/verify/resend: a fresh link for the
// caller's still-unverified account (the old one stops working). 204 either
// way — a verified account just gets nothing.
func (h *VerifyHandler) Resend(c *echo.Context) error {
	ctx := c.Request().Context()
	caller := auth.MustIdentity(ctx)
	if err := h.users.ResendVerification(ctx, caller.TenantID, caller.UserID, h.siteURL); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}
