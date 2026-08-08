package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pdf-service/renderer"
)

// fakeRenderer stands in for ChromeRenderer so these tests exercise the
// HTTP layer (routing, request decoding, status codes) without needing a
// real browser — renderer.Render itself is covered against a real Chrome
// binary in renderer/renderer_test.go.
type fakeRenderer struct {
	lastReq renderer.RenderRequest
	pdf     []byte
	err     error
}

func (f *fakeRenderer) Render(_ context.Context, req renderer.RenderRequest) ([]byte, error) {
	f.lastReq = req
	return f.pdf, f.err
}

func TestHealthz(t *testing.T) {
	mux := newMux(&fakeRenderer{})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestRender_Success(t *testing.T) {
	fake := &fakeRenderer{pdf: []byte("%PDF-1.7 fake")}
	mux := newMux(fake)

	body, _ := json.Marshal(renderRequestBody{URL: "http://core-front/print/report/x/1", WaitFor: "[data-report-ready]"})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/render", bytes.NewReader(body)))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "application/pdf" {
		t.Errorf("Content-Type = %q, want application/pdf", got)
	}
	if !bytes.Equal(rec.Body.Bytes(), fake.pdf) {
		t.Errorf("body = %q, want %q", rec.Body.Bytes(), fake.pdf)
	}
	if fake.lastReq.URL != "http://core-front/print/report/x/1" {
		t.Errorf("renderer received URL %q", fake.lastReq.URL)
	}
	if fake.lastReq.WaitFor != "[data-report-ready]" {
		t.Errorf("renderer received WaitFor %q", fake.lastReq.WaitFor)
	}
}

func TestRender_MissingURL(t *testing.T) {
	mux := newMux(&fakeRenderer{})
	body, _ := json.Marshal(renderRequestBody{})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/render", bytes.NewReader(body)))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestRender_MalformedBody(t *testing.T) {
	mux := newMux(&fakeRenderer{})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/render", strings.NewReader("not json")))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestRender_RendererError(t *testing.T) {
	fake := &fakeRenderer{err: errors.New("chrome exploded")}
	mux := newMux(fake)
	body, _ := json.Marshal(renderRequestBody{URL: "http://core-front/print/report/x/1"})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/render", bytes.NewReader(body)))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", rec.Code)
	}
}

func TestRender_RendererTimeout(t *testing.T) {
	fake := &fakeRenderer{err: context.DeadlineExceeded}
	mux := newMux(fake)
	body, _ := json.Marshal(renderRequestBody{URL: "http://core-front/print/report/x/1"})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/render", bytes.NewReader(body)))

	if rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("expected 504, got %d", rec.Code)
	}
}

func TestRender_TimeoutSecondsPassedThrough(t *testing.T) {
	fake := &fakeRenderer{pdf: []byte("%PDF-1.7")}
	mux := newMux(fake)
	body, _ := json.Marshal(renderRequestBody{URL: "http://x", TimeoutSec: 5})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/render", bytes.NewReader(body)))

	if fake.lastReq.Timeout.Seconds() != 5 {
		t.Errorf("Timeout = %v, want 5s", fake.lastReq.Timeout)
	}
}
