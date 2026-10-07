/**
 * The ccwork HTTP calls this provider makes. Every function takes the API base
 * explicitly so a test can point them at a stub server, and every response goes
 * through one classifier, so a throttle and a dead credential can never be
 * mistaken for each other.
 * @module @deepseek-ai/dsh-ccwork-account/api
 */

import type { CcworkCatalog, CcworkCatalogModel, CcworkOrganization, CcworkUsageDashboard, CcworkUsageEvent, CcworkUsagePage, CcworkWallet } from './types.ts'
import { CcworkError, decimalString, joinUrl, PATHS, readEnvelope, usageDashboardPath, usageEventsPath, walletPath } from './protocol.ts'

/** One signed-in session as ccwork returned it, normalized. */
export interface CcworkSession {
  /** Bearer token for API requests. */
  readonly accessToken: string
  /** Token exchanged at the refresh endpoint; rotated on every refresh. */
  readonly refreshToken: string
  /** Access-token lifetime in milliseconds, from the server's `expires_in`. */
  readonly accessExpiresInMs: number
  /** Stable user id, when ccwork returned one. */
  readonly userId?: string
  /** Display name, when ccwork returned one. */
  readonly username?: string
}

/** The wire shape of a ccwork login or refresh response. */
interface SessionWire {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  user?: { id?: unknown; username?: unknown; nickname?: unknown } | null
}

/** What a caller needs to ask the human to approve a device login. */
export interface DeviceChallenge {
  /** Secret polled at the token endpoint. */
  readonly deviceCode: string
  /** Short code the human types on the verification page. */
  readonly userCode: string
  /** Page the human opens. */
  readonly verificationUri: string
  /** The same page with the code pre-filled. */
  readonly verificationUriComplete: string
  /** How long the challenge stays valid, in milliseconds. */
  readonly expiresInMs: number
  /** Minimum delay between polls, in milliseconds. */
  readonly intervalMs: number
}

/** Options shared by every call. */
export interface CallOptions {
  /** Deadline for this one request. */
  readonly timeoutMs: number
  /** Withdraws the request. */
  readonly signal?: AbortSignal
}

/** One request to the ccwork API. */
interface RequestOptions extends CallOptions {
  readonly method: 'GET' | 'POST'
  readonly path: string
  /** Bearer token, when the route is authenticated. */
  readonly token?: string
  /** Organization scope, sent as `X-TabTin-Organization-Id`. */
  readonly organizationId?: string
  readonly body?: unknown
}

/** Compose request headers, including the organization scope ccwork bills against. */
function headersOf(options: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
  if (options.organizationId !== undefined) headers['X-TabTin-Organization-Id'] = options.organizationId
  return headers
}

/**
 * Send one request and unwrap its envelope.
 * @param base - configured API base.
 * @param options - method, path, credential, scope, body, and deadline.
 * @returns the envelope's `data`.
 * @throws {CcworkError} classified from the status and envelope code.
 */
async function request<T>(base: string, options: RequestOptions): Promise<T> {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let response: Response
  try {
    response = await fetch(joinUrl(base, options.path), {
      method: options.method,
      headers: headersOf(options),
      signal,
      ...options.body === undefined ? {} : { body: JSON.stringify(options.body) },
    })
  } catch (error) {
    // A caller-initiated abort is the caller's own outcome, not a transport
    // failure; only a deadline or a network fault becomes a transient error.
    if (options.signal?.aborted === true) throw error
    throw new CcworkError(`ccwork request to ${options.path} did not complete`, 'transient', { cause: error, status: 0 })
  }
  return readEnvelope<T>(response)
}

/** Normalize one login or refresh response. */
function toSession(wire: SessionWire): CcworkSession {
  const accessToken = wire.access_token
  const refreshToken = wire.refresh_token
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new CcworkError('ccwork login response carried no access token', 'invalid')
  }
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    throw new CcworkError('ccwork login response carried no refresh token', 'invalid')
  }
  // ccwork reports seconds; a missing or nonsensical value falls back to the
  // documented 24-hour default rather than expiring the token immediately.
  const seconds = typeof wire.expires_in === 'number' && wire.expires_in > 0 ? wire.expires_in : 86_400
  const user = wire.user ?? undefined
  const id = user?.id
  const name = user?.nickname ?? user?.username
  return {
    accessToken,
    refreshToken,
    accessExpiresInMs: seconds * 1_000,
    ...typeof id === 'string' ? { userId: id } : {},
    ...typeof name === 'string' && name !== '' ? { username: name } : {},
  }
}

/**
 * Sign in with an account identifier and password.
 * @param base - configured API base.
 * @param credentials - identifier (email, phone, or username), password, and the long-session flag.
 * @param options - deadline and cancellation.
 * @returns the new session.
 */
export async function passwordLogin(
  base: string,
  credentials: { username: string; password: string; rememberMe?: boolean },
  options: CallOptions,
): Promise<CcworkSession> {
  const wire = await request<SessionWire>(base, {
    method: 'POST',
    path: PATHS.LOGIN,
    body: {
      username: credentials.username,
      password: credentials.password,
      ...credentials.rememberMe === undefined ? {} : { remember_me: credentials.rememberMe },
    },
    ...options,
  })
  return toSession(wire)
}

/**
 * Create an account. ccwork signs the new user in, so no second call is needed.
 * @param base - configured API base.
 * @param input - the registration fields, with exactly one of email or phone.
 * @param options - deadline and cancellation.
 * @returns the new session.
 */
export async function register(
  base: string,
  input: { email?: string; phone?: string; password: string; nickname?: string; verificationCode: string; inviteCode?: string },
  options: CallOptions,
): Promise<CcworkSession> {
  const wire = await request<SessionWire>(base, {
    method: 'POST',
    path: PATHS.REGISTER,
    body: {
      ...input.email === undefined ? {} : { email: input.email },
      ...input.phone === undefined ? {} : { phone: input.phone },
      password: input.password,
      ...input.nickname === undefined ? {} : { nickname: input.nickname },
      verification_code: input.verificationCode,
      ...input.inviteCode === undefined ? {} : { invite_code: input.inviteCode },
    },
    ...options,
  })
  return toSession(wire)
}

/**
 * Ask ccwork to send a registration verification code.
 * @param base - configured API base.
 * @param input - the destination identifier and optional invite code.
 * @param options - deadline and cancellation.
 * @returns nothing; failures throw {@link CcworkError}.
 */
export async function sendVerificationCode(
  base: string,
  input: { username: string; inviteCode?: string },
  options: CallOptions,
): Promise<void> {
  await request<unknown>(base, {
    method: 'POST',
    path: PATHS.SEND_VERIFICATION_CODE,
    body: {
      username: input.username,
      code_type: 'register',
      ...input.inviteCode === undefined ? {} : { invite_code: input.inviteCode },
    },
    ...options,
  })
}

/**
 * Rotate the session. ccwork issues a new refresh token with every rotation, so
 * the caller must persist both tokens it returns.
 * @param base - configured API base.
 * @param refreshToken - the current refresh token.
 * @param options - deadline and cancellation.
 * @returns the rotated session.
 */
export async function refreshSession(base: string, refreshToken: string, options: CallOptions): Promise<CcworkSession> {
  const wire = await request<SessionWire>(base, {
    method: 'POST',
    path: PATHS.REFRESH,
    body: { refresh_token: refreshToken },
    ...options,
  })
  return toSession(wire)
}

/**
 * Revoke the session server-side. Best-effort: a failure must not stop local
 * sign-out.
 * @param base - configured API base.
 * @param token - the access token.
 * @param options - deadline and cancellation.
 * @returns nothing; failures throw {@link CcworkError}.
 */
export async function logout(base: string, token: string, options: CallOptions): Promise<void> {
  await request<unknown>(base, { method: 'POST', path: PATHS.LOGOUT, token, ...options })
}

/**
 * Begin a device authorization.
 * @param base - configured API base.
 * @param clientId - the client identifier ccwork records.
 * @param deviceName - the device label the approval page shows.
 * @param options - deadline and cancellation.
 * @returns what the human needs to approve the login.
 */
export async function startDeviceAuthorization(
  base: string,
  clientId: string,
  deviceName: string,
  options: CallOptions,
): Promise<DeviceChallenge> {
  const wire = await request<{
    device_code?: unknown
    user_code?: unknown
    verification_uri?: unknown
    verification_uri_complete?: unknown
    expires_in?: unknown
    interval?: unknown
  }>(base, {
    method: 'POST',
    path: PATHS.DEVICE_CODE,
    body: { client_id: clientId, device_name: deviceName },
    ...options,
  })
  const deviceCode = wire.device_code
  const userCode = wire.user_code
  if (typeof deviceCode !== 'string' || deviceCode === '' || typeof userCode !== 'string' || userCode === '') {
    throw new CcworkError('ccwork device response carried no device code', 'invalid')
  }
  const seconds = typeof wire.expires_in === 'number' && wire.expires_in > 0 ? wire.expires_in : 900
  const interval = typeof wire.interval === 'number' && wire.interval > 0 ? wire.interval : 5
  const uri = typeof wire.verification_uri === 'string' ? wire.verification_uri : ''
  const complete = typeof wire.verification_uri_complete === 'string' ? wire.verification_uri_complete : uri
  return {
    deviceCode,
    userCode,
    verificationUri: uri,
    verificationUriComplete: complete,
    expiresInMs: seconds * 1_000,
    intervalMs: interval * 1_000,
  }
}

/**
 * Poll once for a device authorization's result.
 * @param base - configured API base.
 * @param deviceCode - the challenge's secret.
 * @param options - deadline and cancellation.
 * @returns the session once the human approved.
 * @throws {CcworkError} whose `options.code` is the RFC 8628 status while pending, slow, expired, or denied.
 */
export async function pollDeviceAuthorization(base: string, deviceCode: string, options: CallOptions): Promise<CcworkSession> {
  const wire = await request<SessionWire>(base, {
    method: 'POST',
    path: PATHS.DEVICE_TOKEN,
    body: { device_code: deviceCode },
    ...options,
  })
  return toSession(wire)
}

/**
 * List the organizations the account can read.
 * @param base - configured API base.
 * @param token - the access token.
 * @param options - deadline and cancellation.
 * @returns the organizations, normalized.
 */
export async function listOrganizations(base: string, token: string, options: CallOptions): Promise<CcworkOrganization[]> {
  const wire = await request<{ organizations?: unknown } | readonly unknown[]>(base, {
    method: 'GET',
    path: PATHS.ORGANIZATIONS,
    token,
    ...options,
  })
  // ccwork pages this list; accept either the envelope's object or a bare array
  // so a shape change does not read as "the account has no organizations".
  const listed = (wire as { organizations?: unknown }).organizations
  const rows = Array.isArray(wire) ? wire : Array.isArray(listed) ? listed : []
  const organizations: CcworkOrganization[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const id = record.id
    if (typeof id !== 'string' || id === '') continue
    organizations.push({
      id,
      name: typeof record.name === 'string' ? record.name : id,
      type: typeof record.type === 'string' ? record.type : 'personal',
      isDefault: record.is_default === true,
    })
  }
  return organizations
}

/**
 * Read one organization's credit balance.
 * @param base - configured API base.
 * @param token - the access token.
 * @param organizationId - organization to read.
 * @param options - deadline and cancellation.
 * @returns the balance, with ccwork's precise decimal strings preserved.
 */
export async function readWallet(base: string, token: string, organizationId: string, options: CallOptions): Promise<CcworkWallet> {
  const wire = await request<Record<string, unknown>>(base, {
    method: 'GET',
    path: walletPath(organizationId),
    token,
    organizationId,
    ...options,
  })
  return {
    organizationId,
    availableCredits: decimalString(wire.available_credits_precise) ?? decimalString(wire.available_credits) ?? '0',
    frozenCredits: decimalString(wire.credits_frozen_precise) ?? decimalString(wire.credits_frozen) ?? '0',
    totalCredits: decimalString(wire.credits_precise) ?? decimalString(wire.credits) ?? '0',
  }
}

/**
 * Read the model catalog for one organization.
 * @param base - configured API base.
 * @param token - the access token.
 * @param organizationId - organization to read.
 * @param options - deadline and cancellation.
 * @returns the selectable models.
 */
export async function readCatalog(base: string, token: string, organizationId: string, options: CallOptions): Promise<CcworkCatalog> {
  const query = `?use_case=chat&organization_id=${encodeURIComponent(organizationId)}`
  const wire = await request<{ models?: unknown }>(base, {
    method: 'GET',
    path: `${PATHS.CATALOG}${query}`,
    token,
    organizationId,
    ...options,
  })
  const rows = Array.isArray(wire.models) ? wire.models : []
  const models: CcworkCatalogModel[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const id = record.model_name ?? record.id
    if (typeof id !== 'string' || id === '') continue
    const display = record.display_name ?? record.name
    const contextWindow = record.context_window_tokens ?? record.max_input_tokens
    models.push({
      id,
      name: typeof display === 'string' && display !== '' ? display : id,
      ...typeof contextWindow === 'number' && contextWindow > 0 ? { contextWindow } : {},
      ...typeof record.max_output_tokens === 'number' && record.max_output_tokens > 0 ? { maxTokens: record.max_output_tokens } : {},
      supportsVision: record.supports_vision === true,
    })
  }
  return { models, organizationId }
}

/** One page request against the consumption ledger. */
export interface UsageQuery {
  /** Rows to return; ccwork defaults to 20. */
  readonly limit?: number
  /** Rows to skip. */
  readonly offset?: number
  /** Lower bound on `occurred_at`, as an ISO timestamp. */
  readonly occurredAfter?: string
  /** Upper bound on `occurred_at`, as an ISO timestamp. */
  readonly occurredBefore?: string
}

/**
 * Read one page of the consumption ledger, newest first.
 *
 * The meter filter is fixed to `llm.tokens` so LLM spend is not mixed with
 * storage and media audit rows, which the same endpoint also serves.
 *
 * @param base - configured API base.
 * @param token - the access token.
 * @param organizationId - organization to read.
 * @param query - paging and time bounds.
 * @param options - deadline and cancellation.
 * @returns the page.
 */
export async function readUsageEvents(
  base: string,
  token: string,
  organizationId: string,
  query: UsageQuery,
  options: CallOptions,
): Promise<CcworkUsagePage> {
  const params = new URLSearchParams()
  params.set('limit', String(query.limit ?? 20))
  params.set('offset', String(query.offset ?? 0))
  params.set('meter_key', 'llm.tokens')
  if (query.occurredAfter !== undefined) params.set('occurred_after', query.occurredAfter)
  if (query.occurredBefore !== undefined) params.set('occurred_before', query.occurredBefore)
  const wire = await request<{ total?: unknown; events?: unknown }>(base, {
    method: 'GET',
    path: `${usageEventsPath(organizationId)}?${params.toString()}`,
    token,
    organizationId,
    ...options,
  })
  const rows = Array.isArray(wire.events) ? wire.events : []
  const events: CcworkUsageEvent[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const occurredAt = record.occurred_at
    if (typeof occurredAt !== 'string') continue
    const taskName = record.task_name
    const modelName = record.model_name
    events.push({
      id: typeof record.id === 'string' ? record.id : `${occurredAt}:${events.length}`,
      meterKey: typeof record.meter_key === 'string' ? record.meter_key : 'llm.tokens',
      quantity: decimalString(record.quantity) ?? '0',
      unit: typeof record.unit === 'string' ? record.unit : '',
      credits: decimalString(record.display_credits) ?? decimalString(record.amount) ?? '0',
      bizType: typeof record.biz_type === 'string' ? record.biz_type : '',
      ...typeof taskName === 'string' && taskName !== '' ? { taskName } : {},
      ...typeof modelName === 'string' && modelName !== '' ? { modelName } : {},
      occurredAt,
    })
  }
  // ccwork's default ordering is not guaranteed, so order here rather than
  // trusting the server to have done it.
  events.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
  return { total: typeof wire.total === 'number' ? wire.total : events.length, events }
}

/**
 * Read aggregated spend for one organization.
 * @param base - configured API base.
 * @param token - the access token.
 * @param organizationId - organization to read.
 * @param days - trailing window length.
 * @param options - deadline and cancellation.
 * @returns the aggregate.
 */
export async function readUsageDashboard(
  base: string,
  token: string,
  organizationId: string,
  days: number,
  options: CallOptions,
): Promise<CcworkUsageDashboard> {
  const wire = await request<Record<string, unknown>>(base, {
    method: 'GET',
    path: `${usageDashboardPath(organizationId)}?days=${String(days)}`,
    token,
    organizationId,
    ...options,
  })
  const today = decimalString(wire.today_total_credits)
  const monthOverMonth = wire.month_over_month_pct
  return {
    periodDays: typeof wire.period_days === 'number' ? wire.period_days : days,
    currentMonthTotalCredits: decimalString(wire.current_month_total_credits) ?? '0',
    ...today === undefined ? {} : { todayTotalCredits: today },
    ...typeof monthOverMonth === 'number' && Number.isFinite(monthOverMonth) ? { monthOverMonthPct: monthOverMonth } : {},
  }
}

/** Whether an error is the pending state of a device authorization. */
export function isDevicePending(error: unknown): boolean {
  return error instanceof CcworkError && error.options?.code === 'AUTHORIZATION_PENDING'
}

/** Whether an error is a device authorization the human refused. */
export function isDeviceDenied(error: unknown): boolean {
  return error instanceof CcworkError && error.options?.code === 'ACCESS_DENIED'
}

/** Whether an error is an expired or unknown device authorization. */
export function isDeviceExpired(error: unknown): boolean {
  return error instanceof CcworkError && error.options?.code === 'EXPIRED_TOKEN'
}

/** Whether an error asks the poller to slow down. */
export function isDeviceSlowDown(error: unknown): boolean {
  return error instanceof CcworkError && error.options?.code === 'SLOW_DOWN'
}
