package providers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"

	"core/internal/common"
	"core/internal/pictures"
	"core/orm"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

// PhotoSyncer copies a directory photo into the user's avatar. It never fails
// the sign-in: errors are logged by the implementation.
type PhotoSyncer interface {
	Sync(ctx context.Context, tenant, user uuid.UUID, photo []byte)
}

// FlagSetter writes the anchor's picture flag column (pictures.Repository).
type FlagSetter interface {
	SetFlag(ctx context.Context, tenantID uuid.UUID, table string, recordID uuid.UUID, field string, has bool) error
}

const (
	avatarTable   = "users"
	avatarField   = "avatar"
	maxPhotoBytes = 2 << 20
)

// PhotoSync stores LDAP photos on the picture anchor (users, <user>, avatar).
type PhotoSync struct {
	repo    *pictures.Repository
	objects pictures.ObjectStore
	flags   FlagSetter
}

func NewPhotoSync(repo *pictures.Repository, objects pictures.ObjectStore, flags FlagSetter) *PhotoSync {
	return &PhotoSync{repo: repo, objects: objects, flags: flags}
}

func (s *PhotoSync) Sync(ctx context.Context, tenant, user uuid.UUID, photo []byte) {
	if err := s.sync(ctx, tenant, user, photo); err != nil {
		common.Logger.Warn("ldap photo: not synced", zap.Stringer("user", user), zap.Error(err))
	}
}

func (s *PhotoSync) sync(ctx context.Context, tenant, user uuid.UUID, photo []byte) error {
	existing, err := s.repo.FindByAnchor(ctx, tenant, avatarTable, user, avatarField)
	found := err == nil
	if err != nil && !errors.Is(err, orm.ErrNotFound) {
		return err
	}
	if len(photo) == 0 { // the directory has none: clear ours
		if !found {
			return nil
		}
		if err := s.repo.Delete(ctx, tenant, existing.ID); err != nil {
			return err
		}
		s.deleteObject(ctx, existing.ObjectKey)
		return s.flags.SetFlag(ctx, tenant, avatarTable, user, avatarField, false)
	}
	if len(photo) > maxPhotoBytes {
		common.Logger.Warn("ldap photo: over 2 MB, ignored", zap.Stringer("user", user), zap.Int("bytes", len(photo)))
		return nil
	}
	mime := http.DetectContentType(photo)
	if mime != "image/jpeg" && mime != "image/png" {
		common.Logger.Warn("ldap photo: not JPEG/PNG, ignored", zap.Stringer("user", user), zap.String("mime", mime))
		return nil
	}
	sum := sha256.Sum256(photo)
	key := fmt.Sprintf("%s/users/%s/avatar-%s", tenant, user, hex.EncodeToString(sum[:])[:16])
	if found && existing.ObjectKey == key {
		return nil // unchanged
	}
	if err := s.objects.Put(ctx, key, mime, int64(len(photo)), bytes.NewReader(photo)); err != nil {
		return err
	}
	if found {
		oldKey := existing.ObjectKey
		existing.ObjectKey, existing.Mime, existing.Size = key, mime, int64(len(photo))
		if _, err := s.repo.Update(ctx, existing, existing.ID); err != nil {
			s.deleteObject(ctx, key)
			return err
		}
		s.deleteObject(ctx, oldKey)
	} else if _, err := s.repo.Create(ctx, pictures.Picture{
		TenantID: tenant, TableName: avatarTable, RecordID: user, Field: avatarField,
		ObjectKey: key, Mime: mime, Size: int64(len(photo)),
	}); err != nil {
		s.deleteObject(ctx, key)
		return err
	}
	return s.flags.SetFlag(ctx, tenant, avatarTable, user, avatarField, true)
}

// deleteObject is best-effort: an orphaned object is a leak, logged.
func (s *PhotoSync) deleteObject(ctx context.Context, key string) {
	if err := s.objects.Delete(ctx, key); err != nil {
		common.Logger.Warn("ldap photo: orphaned object", zap.String("key", key), zap.Error(err))
	}
}
