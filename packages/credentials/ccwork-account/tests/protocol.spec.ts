/**
 * The classification rules that decide whether a working session survives a
 * failed refresh. These are the regression line for the failure mode where a
 * throttle signs a user out of a healthy account.
 */
import { describe, expect, it } from 'vitest'
import { classifyFailure, CcworkError, decimalString, joinUrl, readEnvelope, usageEventsPath, walletPath } from '../src/protocol.ts'

/** Build a Response with a JSON body. */
function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('classifyFailure', () => {
  it('keeps credentials when the business code is a throttle, even on HTTP 401', () => {
    // ccwork has answered a throttled refresh with 401; a status-first check
    // would discard the credentials of a user who is merely rate limited.
    expect(classifyFailure(401, 'RATE_LIMITED')).toBe('throttled')
  })

  it('keeps credentials when the business code names a concurrent refresh', () => {
    expect(classifyFailure(409, 'REFRESH_CONFLICT')).toBe('conflict')
  })

  it('discards credentials for a determined rejection', () => {
    expect(classifyFailure(401, undefined)).toBe('rejected')
    expect(classifyFailure(403, undefined)).toBe('rejected')
    expect(classifyFailure(404, undefined)).toBe('rejected')
  })

  it('keeps credentials for a throttle expressed as a status', () => {
    expect(classifyFailure(429, undefined)).toBe('throttled')
  })

  it('keeps credentials for a concurrent refresh expressed as a status', () => {
    expect(classifyFailure(409, undefined)).toBe('conflict')
  })

  it('keeps credentials for a server fault or a transport failure', () => {
    expect(classifyFailure(500, undefined)).toBe('transient')
    expect(classifyFailure(0, undefined)).toBe('transient')
  })

  it('treats other client errors as invalid rather than as a rejection', () => {
    expect(classifyFailure(422, undefined)).toBe('invalid')
  })
})

describe('readEnvelope', () => {
  it('returns the data of a successful envelope', async () => {
    await expect(readEnvelope(response(200, { success: true, code: 'SUCCESS', data: { id: 'x' } }))).resolves.toEqual({ id: 'x' })
  })

  it('throws a classified error carrying the business code', async () => {
    const failure = await readEnvelope(response(400, { success: false, code: 'SLOW_DOWN', message: 'too fast', data: null }))
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CcworkError)
    // SLOW_DOWN is not a rejection, so the credentials must survive it.
    expect((failure as CcworkError).kind).toBe('invalid')
    expect((failure as CcworkError).options?.code).toBe('SLOW_DOWN')
    expect((failure as CcworkError).message).toBe('too fast')
  })

  it('classifies a pending device authorization without discarding anything', async () => {
    const failure = await readEnvelope(response(400, { success: false, code: 'AUTHORIZATION_PENDING', data: null }))
      .catch((error: unknown) => error)
    expect((failure as CcworkError).options?.code).toBe('AUTHORIZATION_PENDING')
  })

  it('reports a non-JSON body as invalid', async () => {
    const failure = await readEnvelope(new Response('not json', { status: 200 })).catch((error: unknown) => error)
    expect((failure as CcworkError).kind).toBe('invalid')
  })
})

describe('url composition', () => {
  it('joins a base and a path with exactly one slash', () => {
    expect(joinUrl('https://ccwork.site/api', '/auth/login')).toBe('https://ccwork.site/api/auth/login')
    expect(joinUrl('https://ccwork.site/api/', '/auth/login')).toBe('https://ccwork.site/api/auth/login')
  })

  it('encodes the organization id in scoped paths', () => {
    expect(walletPath('org 1')).toBe('/wallet/organizations/org%201/wallet')
    expect(usageEventsPath('org 1')).toBe('/services/billing/organizations/org%201/usage-events')
  })
})

describe('decimalString', () => {
  it('preserves a precise decimal string', () => {
    expect(decimalString('42.5000')).toBe('42.5000')
  })

  it('accepts a number and renders it as a string', () => {
    expect(decimalString(7)).toBe('7')
  })

  it('rejects values that are not finite numbers', () => {
    expect(decimalString('')).toBeUndefined()
    expect(decimalString('abc')).toBeUndefined()
    expect(decimalString(Number.NaN)).toBeUndefined()
    expect(decimalString(null)).toBeUndefined()
  })
})
