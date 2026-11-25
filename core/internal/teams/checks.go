package teams

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"core/orm"

	"github.com/google/uuid"
)

// A message checkbox is a Markdown task line, `- [ ] text` or `- [x] text`, outside a
// ``` code block — the same lines the frontend's Markdown.tsx draws as checkboxes, in the
// same order, so an index means the same box on both sides.
var checkLine = regexp.MustCompile(`^([-*] \[)[ xX](\] .*)$`)

// ErrNoSuchCheck: the message has no checkbox at that index.
var ErrNoSuchCheck = errors.New("teams: no such checkbox")

// setCheck returns body with its index-th checkbox (0-based) ticked or cleared.
func setCheck(body string, index int, checked bool) (string, error) {
	lines := strings.Split(body, "\n")
	n := 0
	for i := 0; i < len(lines); i++ {
		if strings.HasPrefix(lines[i], "```") {
			// Skip to the closing fence (an exact ``` line), or to the end when none.
			for i++; i < len(lines) && lines[i] != "```"; i++ {
			}
			continue
		}
		m := checkLine.FindStringSubmatch(lines[i])
		if m == nil {
			continue
		}
		if n == index {
			mark := " "
			if checked {
				mark = "x"
			}
			lines[i] = m[1] + mark + m[2]
			return strings.Join(lines, "\n"), nil
		}
		n++
	}
	return "", ErrNoSuchCheck
}

// SetCheck ticks or clears a live message's index-th checkbox. The row is locked while its
// body is rewritten, so two people ticking different boxes at once both keep their tick.
// edited_at is left alone: ticking a box doesn't rewrite the message. orm.ErrNotFound when
// it was deleted meanwhile, ErrNoSuchCheck for an index past its checkboxes.
func (r *Repository) SetCheck(ctx context.Context, tenant, id uuid.UUID, index int, checked bool) (Message, error) {
	err := orm.Transact(ctx, r.db, func(tx *orm.Tx) error {
		rows, err := r.messages.SelectForUpdate().Where(orm.Cond("tenant_id = $1", tenant)).
			Where(orm.Cond("id = $1", id)).All(ctx, tx)
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			return orm.ErrNotFound
		}
		body, err := setCheck(rows[0].Body, index, checked)
		if err != nil || body == rows[0].Body {
			return err
		}
		_, err = r.messages.UpdateQuery().Set("body", body).Set("updated_at", time.Now()).
			Where(orm.Cond("tenant_id = $1", tenant)).Where(orm.Cond("id = $1", id)).Exec(ctx, tx)
		return err
	})
	if errors.Is(err, orm.ErrNotFound) || errors.Is(err, ErrNoSuchCheck) {
		return Message{}, err
	}
	if err != nil {
		return Message{}, fmt.Errorf("teams: set check: %w", err)
	}
	return r.FindMessage(ctx, tenant, id)
}
