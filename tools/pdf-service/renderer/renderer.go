// Package renderer is pdf-service's core: a pooled headless-Chromium
// renderer behind a small interface, so the transport in front of it (HTTP
// today, NATS later if multiple workers are needed — see
// docs/roadmaps/pdf-reports.md Phase 5) never touches Chrome directly.
package renderer

import (
	"context"
	"fmt"
	"time"

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
type ChromeRenderer struct {
	browserCtx context.Context
	cancel     context.CancelFunc
}

const defaultTimeout = 20 * time.Second

func NewChromeRenderer(execPath string) (*ChromeRenderer, error) {
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath(execPath),
		chromedp.Flag("headless", true),
		chromedp.Flag("disable-gpu", true),
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
	if err := chromedp.Run(browserCtx); err != nil {
		cancel()
		return nil, fmt.Errorf("chrome startup: %w", err)
	}
	return &ChromeRenderer{browserCtx: browserCtx, cancel: cancel}, nil
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

	// A tab per report, cancelled on return — isolates one report's page
	// state/memory from the next without paying to relaunch the browser.
	tabCtx, cancelTab := chromedp.NewContext(r.browserCtx)
	defer cancelTab()
	tabCtx, cancelTimeout := context.WithTimeout(tabCtx, timeout)
	defer cancelTimeout()

	var pdfBuf []byte
	actions := []chromedp.Action{chromedp.Navigate(req.URL)}
	if req.WaitFor != "" {
		// React SSR + data fetching finishes asynchronously; the print route
		// sets this selector once it's actually safe to print — printing
		// before then silently produces a PDF of a loading state.
		actions = append(actions, chromedp.WaitVisible(req.WaitFor, chromedp.ByQuery))
	}
	actions = append(actions, chromedp.ActionFunc(func(ctx context.Context) error {
		var err error
		pdfBuf, _, err = page.PrintToPDF().
			WithPrintBackground(true).
			WithDisplayHeaderFooter(true).
			WithHeaderTemplate(`<span></span>`).
			WithFooterTemplate(`<div style="font-size:8px;width:100%;text-align:center;">Page <span class="pageNumber"></span>/<span class="totalPages"></span></div>`).
			WithMarginTop(0.4).WithMarginBottom(0.6).
			// Lets a report's own `@page { size: ... }` CSS rule (set by the
			// print route from a report_page_format row) pick the paper
			// dimensions instead of Chrome's US-Letter default — margins stay
			// governed by the params above regardless (docs/roadmaps/
			// pdf-reports.md's Reports settings: page size, never page margin,
			// comes from CSS).
			WithPreferCSSPageSize(true).
			Do(ctx)
		return err
	}))

	if err := chromedp.Run(tabCtx, actions...); err != nil {
		return nil, fmt.Errorf("render %s: %w", req.URL, err)
	}
	return pdfBuf, nil
}
