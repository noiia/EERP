package internal

import (
	"core/orm/model"

	"github.com/google/uuid"
)

// ReportPageFormat is a named PDF page layout a ReportDescriptor can opt into
// via its own `pageFormat` field (matched by Name). Every override column is
// a nullable pointer — nil means "inherit the reports.layout global default
// (footer/address) or the built-in constant (padding/colors)", the same
// nullable-pointer idiom sale.Invoice already uses for its optional columns.
type ReportPageFormat struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id,index"`
	Name     string    `db:"name"`
	// Width/Height are plain numbers in Unit's scale — CSS natively
	// understands px/cm/in as length units, so no conversion is ever needed;
	// the print route emits them straight into an `@page { size: <w><unit>
	// <h><unit>; }` rule.
	Width  float64 `db:"width"`
	Height float64 `db:"height"`
	Unit   string  `db:"unit"` // "px", "cm", "in" — UI-enforced via a selection field, not validated server-side (same posture as Contact.Status)

	Padding        *float64 `db:"padding"` // px; nil = built-in default (100)
	ColorText      *string  `db:"color_text"`
	ColorTextMuted *string  `db:"color_text_muted"`
	ColorBorder    *string  `db:"color_border"`
	ColorAccent    *string  `db:"color_accent"`
	Footer         *string  `db:"footer"`  // nil = global reports.layout default
	Address        *string  `db:"address"` // nil = global reports.layout default
}
