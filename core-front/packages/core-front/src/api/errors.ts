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
  /** VALIDATION_ERROR only: the JSON field names Go reported as missing. */
  fields?: string[]
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly requestId?: string
  readonly fields?: string[]

  constructor({ code, message, status, requestId, fields }: ApiErrorParams) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.requestId = requestId
    this.fields = fields
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
  fields?: string[]
}

export function serializeError(error: ApiError): SerializedError {
  const out: SerializedError = { code: error.code, message: error.message, requestId: error.requestId }
  if (error.fields?.length) out.fields = error.fields
  return out
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
  let fields: string[] | undefined

  try {
    const body: unknown = await response.clone().json()
    const envelope = (body as { error?: unknown } | null)?.error
    if (envelope && typeof envelope === 'object') {
      const e = envelope as Record<string, unknown>
      if (typeof e.code === 'string') code = e.code
      if (typeof e.message === 'string') message = e.message
      if (typeof e.request_id === 'string') requestId = e.request_id
      if (Array.isArray(e.fields)) fields = e.fields.filter((f): f is string => typeof f === 'string')
    }
  } catch {
    // Body wasn't JSON or wasn't the envelope shape — keep the status-derived code.
  }

  return new ApiError({ code, message, status: response.status, requestId, fields })
}

// --- Server Action boundary ---
//
// A production Next build replaces the message of any error THROWN out of a
// Server Action with a generic digest — the browser never sees Go's code,
// message, missing fields or request id. So actions return the error as a
// plain value instead (settleAction, server side) and the client turns it
// back into a thrown ApiError (unwrapActionResult), keeping every caller's
// ordinary try/catch contract.

const ACTION_ERROR = '__eerpActionError'

export interface ActionError {
  [ACTION_ERROR]: SerializedError & { status: number }
}

function isActionError(value: unknown): value is ActionError {
  return typeof value === 'object' && value !== null && ACTION_ERROR in value
}

/** Server side: run `fn`, returning its value or a serializable ActionError. */
export async function settleAction<T>(fn: () => Promise<T>): Promise<T | ActionError> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ApiError) return { [ACTION_ERROR]: { ...serializeError(e), status: e.status } }
    // Not from Go (network down, a bug in the BFF): its message may carry
    // internals, so the browser gets a generic one and the log keeps the rest.
    console.error('server action failed:', e)
    return {
      [ACTION_ERROR]: {
        code: 'INTERNAL_ERROR',
        message: 'The server could not complete this request. If it keeps happening, contact your administrator.',
        status: 0,
      },
    }
  }
}

/** Client side: throw the ApiError an ActionError carries; pass any other value through. */
export function unwrapActionResult<T>(value: T | ActionError): T {
  if (isActionError(value)) throw new ApiError(value[ACTION_ERROR])
  return value
}

/** `T`'s async functions, each also allowed to resolve to an ActionError —
 * the shape a host binds when its Server Actions use settleAction. */
export type Settled<T> = { [K in keyof T]: SettledFn<T[K]> }

// A naked type parameter, so it distributes over an optional member's `| undefined`.
type SettledFn<F> = F extends (...args: infer A) => Promise<infer R>
  ? (...args: A) => Promise<R | ActionError>
  : F

/**
 * Client side: wrap every function of a bound-actions object (EntityActions,
 * an Ops context value) so an ActionError result throws instead of resolving.
 */
export function unwrapActions<T extends object>(actions: T): T {
  return Object.fromEntries(
    Object.entries(actions).map(([key, fn]) => [
      key,
      typeof fn === 'function'
        ? (...args: unknown[]) => {
            const out: unknown = fn(...args)
            return out instanceof Promise ? out.then(unwrapActionResult) : unwrapActionResult(out)
          }
        : fn,
    ]),
  ) as T
}
