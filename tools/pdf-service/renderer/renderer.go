// Package renderer is pdf-service's core: a pooled headless-Chromium
// renderer behind a small interface, so the transport in front of it (HTTP
// today, NATS later if multiple workers are needed — see
// docs/roadmaps/pdf-reports.md Phase 5) never touches Chrome directly.
package renderer

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/emulation"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
)

// RenderRequest points at an already-network-trusted, server-rendered print
// route (core-front's /print/report/:name/:id) — the same component tree,
// Tailwind/MUI classes and form field data the on-screen view uses. The
// renderer never re-implements layout; it only asks a real browser to paint
// a real page.
type RenderRequest struct {
	URL     string        // print route URL, internal network address
	WaitFor string        // CSS selector the page sets once it's safe to print; empty skips the wait
	Timeout time.Duration // per-report ceiling; zero falls back to 20s
}

type Renderer interface {
	Render(ctx context.Context, req RenderRequest) ([]byte, error)
}

// ChromeRenderer launches Chromium ONCE and reuses it across renders — a new
// tab per report, never a new browser. Constructing a fresh browser per
// report (~490ms) instead of reusing a pooled one (~170ms) is the single
// biggest performance mistake this design avoids (docs/adr/ADR-010).
//
// slots caps how many tabs render at once: every tab is a renderer process
// sharing the one browser, so an unbounded burst could OOM the container.
// Excess requests queue here; NATS already spreads load across replicas.
type ChromeRenderer struct {
	browserCtx context.Context
	cancel     context.CancelFunc
	slots      chan struct{}
}

const defaultTimeout = 20 * time.Second

// NewChromeRenderer starts the pooled browser. maxConcurrent <= 0 means 1.
func NewChromeRenderer(execPath string, maxConcurrent int) (*ChromeRenderer, error) {
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath(execPath),
		chromedp.Flag("headless", true),
		chromedp.Flag("disable-gpu", true),
		// Docker's default /dev/shm is 64MB — too small for Chrome's shared
		// memory, which crashes tabs under load; /tmp has no such cap.
		chromedp.Flag("disable-dev-shm-usage", true),
		chromedp.NoSandbox, // containers don't have the setuid sandbox helper available
	)
	allocCtx, cancelAlloc := chromedp.NewExecAllocator(context.Background(), opts...)
	browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)

	cancel := func() {
		cancelBrowser()
		cancelAlloc()
	}
	// Force the browser to actually start now, at service boot, not on the
	// first request — so the first real report doesn't pay the launch cost.
	if err := chromedp.Do(browserCtx); err != nil {
		cancel()
		return nil, fmt.Errorf("chrome startup: %w", err)
	}
	return &ChromeRenderer{browserCtx: browserCtx, cancel: cancel, slots: make(chan struct{}, max(1, maxConcurrent))}, nil
}

// Close shuts down the pooled browser. Call once, at service shutdown.
func (r *ChromeRenderer) Close() { r.cancel() }

func (r *ChromeRenderer) Render(ctx context.Context, req RenderRequest) ([]byte, error) {
	if req.URL == "" {
		return nil, fmt.Errorf("render: URL is required")
	}
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}

	queued := time.Now()
	select {
	case r.slots <- struct{}{}:
		defer func() { <-r.slots }()
	case <-ctx.Done():
		return nil, fmt.Errorf("render %s: waiting for a slot: %w", req.URL, ctx.Err())
	}
	start := time.Now()

	// A tab per report, cancelled on return — isolates one report's page
	// state/memory from the next without paying to relaunch the browser.
	tabCtx, cancelTab := chromedp.NewContext(r.browserCtx)
	defer cancelTab()
	tabCtx, cancelTimeout := context.WithTimeout(tabCtx, timeout)
	defer cancelTimeout()

	var loaded, ready time.Time
	mark := func(at *time.Time) chromedp.Action[chromedp.Void] {
		return chromedp.Func(func(context.Context, *chromedp.Target) error { *at = time.Now(); return nil })
	}
	steps := []chromedp.Action[chromedp.Void]{
		// The print route is a Server Component: its HTML already carries the
		// whole report (and the ready marker), so page JavaScript would only
		// download, parse and hydrate the entire app shell for nothing — the
		// single biggest cost of a render. Pitfall: a report node that only
		// renders client-side would come out blank; ReportRenderer must stay
		// server-renderable (docs/adr/ADR-010).
		chromedp.Func(func(ctx context.Context, t *chromedp.Target) error {
			_, err := cdp.Call(ctx, t, emulation.SetScriptExecutionDisabled, emulation.SetScriptExecutionDisabledParams{Value: true})
			return err
		}),
		chromedp.Navigate(req.URL),
		mark(&loaded),
	}
	if req.WaitFor != "" {
		// Printing before the print route's readiness marker is present
		// silently produces a PDF of a loading/404 state.
		steps = append(steps, chromedp.WaitVisible(chromedp.CSS(req.WaitFor)))
	}
	steps = append(steps, mark(&ready))
	if err := chromedp.Do(tabCtx, steps...); err != nil {
		return nil, fmt.Errorf("render %s: %w", req.URL, err)
	}
	pdfBuf, err := chromedp.Run(tabCtx, chromedp.PrintToPDF(
		chromedp.PDFPrintBackground(),
		chromedp.PDFHeaderTemplate(`<span></span>`),
		chromedp.PDFFooterTemplate(`<div style="font-family:Helvetica,Arial,sans-serif;font-size:8px;width:100%;text-align:center;">Page <span class="pageNumber"></span>/<span class="totalPages"></span></div>`),
		// Top and bottom only: the sides keep Chrome's default (1 cm).
		func(p *page.PrintToPDFParams) { p.MarginTop, p.MarginBottom = new(0.4), new(0.6) },
		// Lets a report's own `@page { size: ... }` CSS rule (set by the print
		// route from a report_page_format row) pick the paper dimensions
		// instead of Chrome's US-Letter default — margins stay governed by the
		// options above regardless (docs/roadmaps/pdf-reports.md's Reports
		// settings: page size, never page margin, comes from CSS).
		chromedp.PDFPreferCSSPageSize(),
	))
	if err != nil {
		return nil, fmt.Errorf("render %s: %w", req.URL, err)
	}
	done := time.Now()
	log.Printf("rendered %d bytes: queue=%s navigate=%s wait=%s print=%s total=%s",
		len(pdfBuf), start.Sub(queued), loaded.Sub(start), ready.Sub(loaded), done.Sub(ready), done.Sub(queued))
	return pdfBuf, nil
}
