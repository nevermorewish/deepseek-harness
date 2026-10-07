/**
 * ccwork HTTP vocabulary: envelope parsing, URL composition, and the error
 * classification every caller branches on. No cordis imports, so tests can
 * drive it directly.
 * @module @deepseek-ai/dsh-ccwork-account/protocol
 */

/** Paths this provider calls, relative to the configured API base. */
export const PATHS = {
  LOGIN: '/auth/login',
  REGISTER: '/auth/register',
  REFRESH: '/auth/refresh-token',
  LOGOUT: '/auth/logout',
  DEVICE_CODE: '/auth/device/code',
  DEVICE_TOKEN: '/auth/device/token',
  SEND_VERIFICATION_CODE: '/auth/send-verification-code',
  ORGANIZATIONS: '/context/organizations',
  CATALOG: '/services/llm/catalog',
} as const

/**
 * Join one base and one path, tolerating exactly one slash between them, so a
 * configured base may or may not end in `/`.
 * @param base - configured API base, such as `https://ccwork.site/api`.
 * @param path - absolute path from {@link PATHS}.
 * @returns the absolute URL.
 */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/u, '')}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * The wallet path for one organization.
 * @param organizationId - organization to read.
 * @returns the path.
 */
export function walletPath(organizationId: string): string {
  return `/wallet/organizations/${encodeURIComponent(organizationId)}/wallet`
}

/**
 * The consumption-ledger path for one organization.
 * @param organizationId - organization to read.
 * @returns the path.
 */
export function usageEventsPath(organizationId: string): string {
  return `/services/billing/organizations/${encodeURIComponent(organizationId)}/usage-events`
}

/**
 * The dashboard path for one organization.
 * @param organizationId - organization to read.
 * @returns the path.
 */
export function usageDashboardPath(organizationId: string): string {
  return `/services/billing/organizations/${encodeURIComponent(organizationId)}/usage-dashboard`
}

/** The envelope ccwork wraps every response in. */
interface Envelope {
  success?: unknown
  code?: unknown
  message?: unknown
  data?: unknown
}

/**
 * How a failed ccwork call must be handled. The distinction is the whole point:
 * only `rejected` may discard stored credentials, because treating a throttle
 * or a concurrent refresh as a rejection signs the user out of a working
 * session.
 */
export type CcworkFailureKind =
  /** Server says the credential is invalid; discard it. */
  | 'rejected'
  /** The caller is asking too often; keep credentials and retry later. */
  | 'throttled'
  /** Another writer already refreshed; keep credentials and re-read. */
  | 'conflict'
  /** Server fault; keep credentials and retry later. */
  | 'transient'
  /** The request itself is wrong; keep credentials, do not retry blindly. */
  | 'invalid'

/** A classified ccwork failure carrying what the caller needs to react. */
export class CcworkError extends Error {
  /**
   * @param message - diagnostic text, safe to log.
   * @param kind - how the caller must react.
   * @param options - optional underlying cause, HTTP status, and response code.
   */
  constructor(
    message: string,
    readonly kind: CcworkFailureKind,
    readonly options?: { cause?: unknown; status?: number; code?: string | undefined },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CcworkError'
  }
}

/** Business codes ccwork uses for rate limiting, which it has also sent with HTTP 401. */
const THROTTLE_CODES = new Set(['RATE_LIMITED', 'RATE_LIMIT_EXCEEDED'])
/** Business codes naming a concurrent refresh rather than a dead credential. */
const CONFLICT_CODES = new Set(['REFRESH_CONFLICT', 'CONCURRENT_REFRESH'])
/** Business codes naming a credential the server no longer accepts. */
const REJECTED_CODES = new Set(['TOKEN_INVALID', 'TOKEN_EXPIRED', 'INVALID_TOKEN', 'UNAUTHORIZED', 'USER_NOT_FOUND', 'ACCOUNT_DISABLED'])

/**
 * Classify one failure from its HTTP status and the envelope's business code.
 *
 * The business code is read before the status because ccwork has answered a
 * throttled refresh with HTTP 401, and a status-first check would discard the
 * credentials of a user who is merely being rate limited.
 *
 * @param status - HTTP status; 0 when fetch rejected before a response.
 * @param code - envelope `code`, when the body carried one.
 * @returns the failure kind.
 */
export function classifyFailure(status: number, code: string | undefined): CcworkFailureKind {
  if (code !== undefined) {
    if (THROTTLE_CODES.has(code)) return 'throttled'
    if (CONFLICT_CODES.has(code)) return 'conflict'
    if (REJECTED_CODES.has(code)) return 'rejected'
  }
  if (status === 401 || status === 403 || status === 404) return 'rejected'
  if (status === 408 || status === 425 || status === 429) return 'throttled'
  if (status === 409) return 'conflict'
  if (status === 0 || status >= 500) return 'transient'
  return 'invalid'
}

/**
 * Read one ccwork response: unwrap the envelope, or throw a classified error.
 * @param response - the fetch response.
 * @returns the envelope's `data`.
 * @throws {CcworkError} classified from the status and envelope code.
 */
export async function readEnvelope<T>(response: Response): Promise<T> {
  const text = await response.text()
  let body: Envelope | undefined
  try {
    body = text === '' ? undefined : JSON.parse(text) as Envelope
  } catch (error) {
    // A non-JSON body from an error status is still an error; from a success
    // status it is a broken contract, which `invalid` reports.
    throw new CcworkError(`ccwork returned a non-JSON response (HTTP ${response.status})`, 'invalid', { cause: error, status: response.status })
  }
  const code = typeof body?.code === 'string' ? body.code : undefined
  const message = typeof body?.message === 'string' ? body.message : undefined
  if (!response.ok || body?.success === false) {
    throw new CcworkError(message ?? `ccwork request failed (HTTP ${response.status})`, classifyFailure(response.status, code), { status: response.status, code })
  }
  if (body === undefined || !('data' in body)) {
    throw new CcworkError('ccwork response carried no data', 'invalid', { status: response.status })
  }
  return body.data as T
}

/**
 * Read a decimal string ccwork formatted, preserving precision.
 * ccwork sends precise credit values as strings and coarse ones as integers; a
 * number is accepted and re-stringified so callers always see a decimal string.
 * @param value - the raw field.
 * @returns the decimal string, or undefined when absent or unparseable.
 */
export function decimalString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}
