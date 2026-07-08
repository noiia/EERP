package pictures

import (
	"reflect"
	"strings"
	"testing"
)

// Picture deletes must be HARD (see the model comment): a softdelete tag would
// turn Delete into a tombstone that still occupies uq_picture_anchor — the next
// upload to the anchor 23505s while FindByAnchor sees nothing — and that points
// at bytes already removed from the bucket. Pin the absence of the tag, so
// re-embedding model.BaseModel (which carries `deleted_at,softdelete`) fails
// loudly here instead of in production uploads.
func TestPictureIsHardDeleted(t *testing.T) {
	tt := reflect.TypeOf(Picture{})
	for i := 0; i < tt.NumField(); i++ {
		f := tt.Field(i)
		if f.Anonymous {
			t.Errorf("Picture embeds %s — embedded bases can smuggle a softdelete column in", f.Type)
		}
		if strings.Contains(f.Tag.Get("db"), "softdelete") {
			t.Errorf("Picture.%s carries a softdelete tag — picture deletes must be hard", f.Name)
		}
	}
}
