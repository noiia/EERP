package teams

import (
	"testing"
)

func TestSetCheck_Body(t *testing.T) {
	body := "Todo\n- [ ] one\n```\n- [ ] in code\n```\n* [x] two\n- [] not a box"
	for _, c := range []struct {
		name    string
		index   int
		checked bool
		want    string
		err     error
	}{
		{"tick the first", 0, true, "Todo\n- [x] one\n```\n- [ ] in code\n```\n* [x] two\n- [] not a box", nil},
		{"code block skipped: index 1 is the second real box", 1, false, "Todo\n- [ ] one\n```\n- [ ] in code\n```\n* [ ] two\n- [] not a box", nil},
		{"already in that state", 1, true, body, nil},
		{"past the last box", 2, true, "", ErrNoSuchCheck},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, err := setCheck(body, c.index, c.checked)
			if err != c.err || got != c.want {
				t.Fatalf("got %q, %v; want %q, %v", got, err, c.want, c.err)
			}
		})
	}
	// An unclosed fence hides every line after it.
	if _, err := setCheck("```\n- [ ] x", 0, true); err != ErrNoSuchCheck {
		t.Fatalf("unclosed fence: %v", err)
	}
}
