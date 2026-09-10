package propertymanagement

import (
	"encoding/json"
	"testing"
	"time"

	"core/modules/sale"

	"github.com/google/uuid"
)

// receiptGeneratedThisMonth: nil (never generated — the whole reason
// LastReceiptMonth is a *string, not a string) must read as false, not
// panic or false-match against an empty-string "now".
func TestReceiptGeneratedThisMonth(t *testing.T) {
	now := time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC)
	thisMonth := "2026-08"
	lastMonth := "2026-07"

	tests := []struct {
		name             string
		lastReceiptMonth *string
		want             bool
	}{
		{"nil (never generated)", nil, false},
		{"matches the current month", &thisMonth, true},
		{"a stale prior month", &lastMonth, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := receiptGeneratedThisMonth(tt.lastReceiptMonth, now); got != tt.want {
				t.Errorf("receiptGeneratedThisMonth() = %v, want %v", got, tt.want)
			}
		})
	}
}

// latestStatus: the entry with the latest Date wins, regardless of
// insertion order — a backdated entry entered after a more recent one must
// not overwrite CurrentState with stale data.
func TestLatestStatus(t *testing.T) {
	older := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	newer := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)

	tests := []struct {
		name    string
		entries []PropertyManagementEquipmentStatus
		want    string
	}{
		{
			name: "single entry",
			entries: []PropertyManagementEquipmentStatus{
				{Date: &older, State: "good"},
			},
			want: "good",
		},
		{
			name: "in-order entries — later one wins",
			entries: []PropertyManagementEquipmentStatus{
				{Date: &older, State: "good"},
				{Date: &newer, State: "damaged"},
			},
			want: "damaged",
		},
		{
			name: "out-of-order entries — latest Date still wins",
			entries: []PropertyManagementEquipmentStatus{
				{Date: &newer, State: "damaged"},
				{Date: &older, State: "good"},
			},
			want: "damaged",
		},
		{
			name: "nil Date never beats a set one",
			entries: []PropertyManagementEquipmentStatus{
				{Date: &older, State: "good"},
				{Date: nil, State: "under_repair"},
			},
			want: "good",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := latestStatus(tt.entries).State; got != tt.want {
				t.Errorf("latestStatus() = %v, want %v", got, tt.want)
			}
		})
	}
}

// Regression: Handler.CreateEquipmentStatus binds the request body straight
// onto PropertyManagementEquipmentStatus via c.Bind (encoding/json) — same
// "json tag must match db tag" hazard as modules/sale/handler_test.go's
// TestSaleLine_JSONUnmarshalsIDFields.
func TestEquipmentStatus_JSONUnmarshalsIDFields(t *testing.T) {
	equipmentID := uuid.New()
	body := []byte(`{"property_management_equipment_id":"` + equipmentID.String() + `","state":"damaged"}`)

	var status PropertyManagementEquipmentStatus
	if err := json.Unmarshal(body, &status); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if status.PropertyManagementEquipmentID != equipmentID {
		t.Errorf("PropertyManagementEquipmentID = %v, want %v", status.PropertyManagementEquipmentID, equipmentID)
	}
	if status.State != "damaged" {
		t.Errorf("State = %v, want damaged", status.State)
	}
}

// computeBillingLineTotal mirrors sale/handler.go's computeLineTotal — same
// three-source stack (legacy tax_rate + percentage tags + fixed tags), base
// is just UnitPrice here (no quantity concept).
func TestComputeBillingLineTotal(t *testing.T) {
	tests := []struct {
		name         string
		base         float64
		legacyRate   float64
		taxes        []sale.SaleTax
		included     bool
		wantSubtotal float64
		wantTotal    float64
	}{
		{"no tax at all", 1000, 0, nil, false, 1000, 1000},
		{"legacy tax_rate only", 1000, 0.2, nil, false, 1000, 1200},
		{"one percentage tag, no legacy rate", 100, 0, []sale.SaleTax{{Kind: "percentage", Rate: 0.1}}, false, 100, 110},
		{"one fixed tag, no legacy rate", 100, 0, []sale.SaleTax{{Kind: "fixed", Amount: 5}}, false, 100, 105},
		{
			"legacy rate stacks with a percentage tag and a fixed tag",
			1000, 0.2,
			[]sale.SaleTax{{Kind: "percentage", Rate: 0.1}, {Kind: "fixed", Amount: 50}},
			false,
			// 1000 base + 200 (legacy) + 100 (percentage tag) + 50 (fixed tag)
			1000, 1350,
		},
		// included: base is itself the final, tax-inclusive price.
		{"included, 20% tax baked in", 1200, 0.2, nil, true, 1000, 1200},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotSubtotal, gotTotal := computeBillingLineTotal(tt.base, tt.legacyRate, tt.taxes, tt.included)
			if gotSubtotal != tt.wantSubtotal || gotTotal != tt.wantTotal {
				t.Errorf("computeBillingLineTotal() = (%v, %v), want (%v, %v)", gotSubtotal, gotTotal, tt.wantSubtotal, tt.wantTotal)
			}
		})
	}
}
