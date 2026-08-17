import { NextResponse } from 'next/server'
import { ApiError, findAttachment, uploadAttachment } from '@eerp/core-front/server'

// BFF proxy for the attachment service collection routes — mirrors
// app/api/pictures/route.ts exactly, scoped to internal/attachments. The
// browser never talks to Go: widgets POST their multipart here (and query
// anchors here), Next forwards with the session Bearer, Go owns validation,
// tenant pinning, and storage.

function errorResponse(e: unknown): NextResponse {
  if (e instanceof ApiError) {
    return NextResponse.json(
      { error: { code: e.code, message: e.message, request_id: e.requestId } },
      { status: e.status },
    )
  }
  throw e
}

// POST /api/attachments — multipart {table_name, record_id, field, file} passthrough.
export async function POST(request: Request) {
  try {
    const form = await request.formData()
    return NextResponse.json(await uploadAttachment(form), { status: 201 })
  } catch (e) {
    return errorResponse(e)
  }
}

// GET /api/attachments?table&record&field — anchor → metadata; 404 = no attachment.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  try {
    const meta = await findAttachment({
      table: params.get('table') ?? '',
      recordId: params.get('record') ?? '',
      field: params.get('field') ?? '',
    })
    if (!meta) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'No attachment on this field.' } },
        { status: 404 },
      )
    }
    return NextResponse.json(meta)
  } catch (e) {
    return errorResponse(e)
  }
}
