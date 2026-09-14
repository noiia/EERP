package attachments

import (
	"reflect"
	"strings"
	"testing"
)

// Attachment deletes must be HARD (see the model comment): a softdelete tag
// would turn Delete into a tombstone that still occupies uq_attachment_anchor
// — the next upload to the anchor 23505s while FindByAnchor (which filters
// soft-deleted rows) sees nothing — and that points at bytes already removed
// from the bucket. Pin the absence of the tag, mirroring
// internal/pictures/models_test.go's TestPictureIsHardDeleted.
func TestAttachmentIsHardDeleted(t *testing.T) {
	tt := reflect.TypeOf(Attachment{})
	for i := 0; i < tt.NumField(); i++ {
		f := tt.Field(i)
		if f.Anonymous {
			t.Errorf("Attachment embeds %s — embedded bases can smuggle a softdelete column in", f.Type)
		}
		if strings.Contains(f.Tag.Get("db"), "softdelete") {
			t.Errorf("Attachment.%s carries a softdelete tag — attachment deletes must be hard", f.Name)
		}
	}
}
