import { NextResponse } from 'next/server'
import { generateReportPDF } from '@eerp/core-front/server'
import { errorResponse } from '@/lib/route-errors'

// BFF proxy for report generation. The browser never talks to Go: a form
// actions menu action (docs/adr/ADR-011) POSTs here, Next forwards with the
// session Bearer (refresh-once semantics in the engine helpers), Go owns
// permission enforcement, rendering, and storage (docs/adr/ADR-010).

interface RouteContext {
  params: Promise<{ name: string; id: string }>
}

// POST /api/reports/:name/:id — generate a report, returning THIS BFF's own
// download path (never Go's), so the browser never needs a Bearer header.
export async function POST(_request: Request, context: RouteContext) {
  const { name, id } = await context.params
  try {
    const { downloadURL } = await generateReportPDF(name, id)
    return NextResponse.json({ download_url: downloadURL }, { status: 201 })
  } catch (e) {
    return errorResponse(e)
  }
}
