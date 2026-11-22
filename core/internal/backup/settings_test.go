package backup

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestValidate(t *testing.T) {
	known := []string{"poc", "client_a"}
	ok := func(mut func(*Settings)) Settings {
		s := Defaults()
		s.Enabled = true
		s.Databases = []string{"poc"}
		mut(&s)
		return s
	}
	tests := []struct {
		name    string
		s       Settings
		wantErr bool
	}{
		{"daily", ok(func(*Settings) {}), false},
		{"hours 1", ok(func(s *Settings) { s.Frequency, s.EveryHours = "hours", 1 }), false},
		{"hours 168", ok(func(s *Settings) { s.Frequency, s.EveryHours = "hours", 168 }), false},
		{"hours 0", ok(func(s *Settings) { s.Frequency, s.EveryHours = "hours", 0 }), true},
		{"hours 169", ok(func(s *Settings) { s.Frequency, s.EveryHours = "hours", 169 }), true},
		{"weekly", ok(func(s *Settings) { s.Frequency, s.Weekdays = "weekly", []int{0, 6} }), false},
		{"weekly without days", ok(func(s *Settings) { s.Frequency, s.Weekdays = "weekly", nil }), true},
		{"weekly day 7", ok(func(s *Settings) { s.Frequency, s.Weekdays = "weekly", []int{7} }), true},
		{"monthly 28", ok(func(s *Settings) { s.Frequency, s.MonthDay = "monthly", 28 }), false},
		{"monthly 29", ok(func(s *Settings) { s.Frequency, s.MonthDay = "monthly", 29 }), true},
		{"monthly 0", ok(func(s *Settings) { s.Frequency, s.MonthDay = "monthly", 0 }), true},
		{"unknown frequency", ok(func(s *Settings) { s.Frequency = "yearly" }), true},
		{"time 24:00", ok(func(s *Settings) { s.Time = "24:00" }), true},
		{"time 2:00", ok(func(s *Settings) { s.Time = "2:00" }), true},
		{"time 23:59", ok(func(s *Settings) { s.Time = "23:59" }), false},
		{"timezone typo", ok(func(s *Settings) { s.Timezone = "Europe/Pariss" }), true},
		{"timezone empty", ok(func(s *Settings) { s.Timezone = "" }), true},
		{"timezone Paris", ok(func(s *Settings) { s.Timezone = "Europe/Paris" }), false},
		{"retention 0", ok(func(s *Settings) { s.RetentionDays = 0 }), true},
		{"retention 3650", ok(func(s *Settings) { s.RetentionDays = 3650 }), false},
		{"retention 3651", ok(func(s *Settings) { s.RetentionDays = 3651 }), true},
		{"unknown database", ok(func(s *Settings) { s.Databases = []string{"ghost"} }), true},
		{"duplicate database", ok(func(s *Settings) { s.Databases = []string{"poc", "poc"} }), true},
		{"enabled without databases", ok(func(s *Settings) { s.Databases = nil }), true},
		{"disabled without databases", ok(func(s *Settings) { s.Enabled, s.Databases = false, nil }), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.s.Validate(known); (err != nil) != tt.wantErr {
				t.Errorf("Validate() = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestSaveLoad_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := Defaults()
	s.Enabled, s.Databases, s.Frequency, s.Weekdays = true, []string{"poc"}, "weekly", []int{1, 4}
	s.UpdatedAt = time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)
	if err := SaveSettings(dir, s); err != nil {
		t.Fatal(err)
	}
	got, err := LoadSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, s) {
		t.Errorf("got %+v, want %+v", got, s)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 || entries[0].Name() != "backup-config.json" {
		t.Errorf("dir holds %v, want only backup-config.json", entries)
	}
}

func TestLoad_MissingIsDefaults(t *testing.T) {
	got, err := LoadSettings(t.TempDir())
	if err != nil || !reflect.DeepEqual(got, Defaults()) {
		t.Errorf("got %+v, %v", got, err)
	}
	d := Defaults()
	if d.Enabled || d.Frequency != "daily" || d.Time != "02:00" || d.Timezone != "UTC" || !d.IncludeS3 || d.RetentionDays != 14 {
		t.Errorf("defaults = %+v", d)
	}
}

func TestLoad_CorruptIsAnError(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "backup-config.json"), []byte("{nope"), 0o600)
	if _, err := LoadSettings(dir); err == nil {
		t.Error("want an error")
	}
}
