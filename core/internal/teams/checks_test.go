package teams_test

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestSetCheckHandler(t *testing.T) {
	f := newChatFixture(t, false)
	m := f.post(t, f.member, f.general, `{"body":"- [ ] a\n- [ ] b"}`)
	p := map[string]string{"message": m["id"].(string)}
	for _, c := range []struct {
		name string
		as   uuid.UUID
		body string
		want int
	}{
		{"outsider", f.outside, `{"index":0,"checked":true}`, 404},
		{"guest", f.guest, `{"index":0,"checked":true}`, 403},
		{"missing checked", f.owner, `{"index":0}`, 400},
		{"negative index", f.owner, `{"index":-1,"checked":true}`, 400},
		{"malformed", f.owner, `{`, 400},
		{"no such box", f.owner, `{"index":2,"checked":true}`, 422},
	} {
		if rec := serve(t, f.h.SetCheck, "PUT", c.body, f.as(c.as), p); rec.Code != c.want {
			t.Fatalf("%s: %d %s", c.name, rec.Code, rec.Body)
		}
	}
	// Someone other than the author ticks the second box: not an edit, pushed to the channel.
	rec := serve(t, f.h.SetCheck, "PUT", `{"index":1,"checked":true}`, f.as(f.owner), p)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"body":"- [ ] a\n- [x] b"`) || strings.Contains(rec.Body.String(), `"edited_at":"`) {
		t.Fatalf("tick: %d %s", rec.Code, rec.Body)
	}
	fr := f.hub.frames[len(f.hub.frames)-1]
	if msg, _ := fr.payload["message"].(map[string]any); fr.payload["type"] != "chat_message_updated" || msg["body"] != "- [ ] a\n- [x] b" {
		t.Fatalf("frame: %v", fr.payload)
	}
	// A deleted message can't be ticked.
	if rec := serve(t, f.h.DeleteMessage, "DELETE", "", f.as(f.member), p); rec.Code != 204 {
		t.Fatalf("delete: %d", rec.Code)
	}
	if rec := serve(t, f.h.SetCheck, "PUT", `{"index":0,"checked":true}`, f.as(f.owner), p); rec.Code != 404 {
		t.Fatalf("deleted: %d", rec.Code)
	}
}
