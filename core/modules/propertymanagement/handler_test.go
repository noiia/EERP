package propertymanagement

import (
	"encoding/json"
	"testing"
	"time"

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
