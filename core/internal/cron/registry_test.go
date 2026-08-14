package cron

import (
	"context"
	"testing"
)

func TestRegistry(t *testing.T) {
	clearForTest()
	defer clearForTest()

	if _, ok := Get("nope"); ok {
		t.Fatalf("Get on empty registry: expected ok=false")
	}

	Register(Action{ID: "b.action", Label: "B", Run: func(context.Context) error { return nil }})
	Register(Action{ID: "a.action", Label: "A", Run: func(context.Context) error { return nil }})

	got, ok := Get("a.action")
	if !ok || got.Label != "A" {
		t.Fatalf("Get(a.action) = %+v, ok=%v", got, ok)
	}

	// Re-registering the same ID overwrites, last write wins.
	Register(Action{ID: "a.action", Label: "A2", Run: func(context.Context) error { return nil }})
	got, _ = Get("a.action")
	if got.Label != "A2" {
		t.Fatalf("Register did not overwrite: got Label=%q", got.Label)
	}
}
