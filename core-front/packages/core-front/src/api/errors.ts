// The Go error envelope and its client-side representation.
//
// Every backend failure arrives as { error: { code, message, request_id } } with a
// status from the documented map (CONVENTIONS.md). ApiError flattens that into one
// throwable type carrying the machine `code`, human `message`, originating `status`,
// and the `requestId` — surfaced in the UI so a user can quote it in a bug report.

/** Canonical codes the status map synthesizes when the body isn't a valid envelope. */
export const STATUS_TO_CODE: Readonly<Record<number, string>> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
}

/** Map an HTTP status to a code when the response carries no usable envelope. */
export function codeFromStatus(status: number): string {
  return STATUS_TO_CODE[status] ?? 'INTERNAL_ERROR'
}

export interface ApiErrorParams {
  code: string
  message: string
  status: number
  requestId?: string
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly requestId?: string

  constructor({ code, message, status, requestId }: ApiErrorParams) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.requestId = requestId
  }
}

/**
 * Plain, RSC-serializable shape of an ApiError. Class instances don't cross the
 * server -> client boundary cleanly, so server loaders pass this to client renderers.
 */
export interface SerializedError {
  code: string
  message: string
  requestId?: string
}

export function serializeError(error: ApiError): SerializedError {
  return { code: error.code, message: error.message, requestId: error.requestId }
}

/** Coerce any thrown value into an ApiError so stores/UI have a uniform shape. */
export function toApiError(value: unknown): ApiError {
  if (value instanceof ApiError) return value
  const message = value instanceof Error ? value.message : String(value)
  return new ApiError({ code: 'INTERNAL_ERROR', message, status: 0 })
}

/**
 * Build an ApiError from a non-OK Response. Reads the {error:{...}} envelope when
 * present; otherwise synthesizes the code from the status (500 -> INTERNAL_ERROR).
 * Clones the response so the body remains readable by callers.
 */
export async function parseError(response: Response): Promise<ApiError> {
  let code = codeFromStatus(response.status)
  let message = response.statusText || code
  let requestId: string | undefined

  try {
    const body: unknown = await response.clone().json()
    const envelope = (body as { error?: unknown } | null)?.error
    if (envelope && typeof envelope === 'object') {
      const e = envelope as Record<string, unknown>
      if (typeof e.code === 'string') code = e.code
      if (typeof e.message === 'string') message = e.message
      if (typeof e.request_id === 'string') requestId = e.request_id
    }
  } catch {
    // Body wasn't JSON or wasn't the envelope shape — keep the status-derived code.
  }

  return new ApiError({ code, message, status: response.status, requestId })
}
