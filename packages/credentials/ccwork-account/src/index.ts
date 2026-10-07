/**
 * ccwork account provider: registers the sign-in flow, stores the token
 * record, and serves the wallet, catalog, and usage reads every consumer shares.
 * @module @deepseek-ai/dsh-ccwork-account
 */

import { arch, platform } from 'node:os'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { AuthorizationDeclinedError, AuthorizationError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type {
  CcworkAccountView, CcworkCatalog, CcworkOrganization, CcworkProfileRecord,
  CcworkTokenRecord, CcworkUsageDashboard, CcworkUsagePage, CcworkWallet,
} from './types.ts'
import { CcworkError, joinUrl } from './protocol.ts'
import {
  isDeviceDenied, isDeviceExpired, isDevicePending, isDeviceSlowDown,
  listOrganizations, logout, passwordLogin, pollDeviceAuthorization, readCatalog,
  readUsageDashboard, readUsageEvents, readWallet, refreshSession, register,
  sendVerificationCode, startDeviceAuthorization,
} from './api.ts'
import type { CallOptions, CcworkSession, UsageQuery } from './api.ts'
import {
  accessTokenUsable, conflictBackoffMs, issuerMatches, MAX_CONFLICT_RETRIES,
  profileRecord, recentlyRefreshed, selectOrganization, tokenRecord,
} from './session.ts'

/** Credential record holding the tokens. One writer: this provider. */
export const TOKENS_KEY = credentialKey('ccwork-account', 'default')
/** Credential record holding the chosen organization. Non-secret. */
export const PROFILE_KEY = credentialKey('ccwork-account', 'profile')

/** The client identifier ccwork records for device authorizations. */
const CLIENT_ID = 'ccwork-harness'

/** Deployment-specific ccwork addresses and deadlines. */
export interface Config {
  /** API base every request is made against, including its path prefix. */
  apiBaseUrl?: string
  /** Deadline for ordinary API requests. */
  requestTimeoutMs?: number
  /** Deadline for a single device-authorization poll. */
  pollTimeoutMs?: number
}

/** Validated deployment choices. */
export const Config = Schema.object({
  apiBaseUrl: Schema.string().default('https://ccwork.site/api'),
  requestTimeoutMs: Schema.natural().min(1).max(120_000).default(30_000),
  pollTimeoutMs: Schema.natural().min(1).max(120_000).default(30_000),
})

/** The message a sleeping poller waits on, cancellable by the attempt's signal. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** The stored ccwork session became unusable and was discarded.
     * @mode emit
     */
    'ccwork-account/session-expired'(): void
    /** The stored ccwork session was removed by sign-out.
     * @mode emit
     */
    'ccwork-account/signed-out'(): void
  }
}

/** One in-flight refresh, shared by every concurrent caller. */
interface RefreshState {
  promise?: Promise<string | undefined> | undefined
  refreshedAt: number
}

/**
 * `ctx.ccworkAccount`: authorization flow, token storage, and the wallet,
 * catalog, and usage reads for one ccwork deployment.
 */
export class CcworkAccount extends Service {
  static inject = ['credentials', 'authorization']
  /** Deployment addresses and deadlines. */
  static Config = Config

  private readonly base: string
  private readonly requestTimeout: number
  private readonly pollTimeout: number
  private readonly refreshState: RefreshState = { refreshedAt: 0 }
  private closed = false

  /**
   * @param ctx - context owning this account implementation.
   * @param config - resolved deployment choices.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'ccworkAccount')
    const resolved = Config(config)
    this.base = (resolved.apiBaseUrl ?? 'https://ccwork.site/api').replace(/\/+$/u, '')
    this.requestTimeout = resolved.requestTimeoutMs ?? 30_000
    this.pollTimeout = resolved.pollTimeoutMs ?? 30_000
    ctx.authorization.registerFlow({
      key: TOKENS_KEY,
      label: 'ccwork',
      methods: [
        { id: 'device', label: 'Approve in a browser' },
        { id: 'password', label: 'Sign in with a password' },
        { id: 'register', label: 'Create an account' },
      ],
      run: session => this.run(session),
    })
    ctx.on('credentials/record-updated', (key) => { if (key === TOKENS_KEY) this.refreshState.refreshedAt = 0 })
    ctx.effect(() => async () => {
      this.closed = true
      this.refreshState.promise = undefined
    }, 'ccwork-account: lifetime')
  }

  /** Options for one call against the configured base. */
  private callOptions(signal?: AbortSignal, timeoutMs = this.requestTimeout): CallOptions {
    return { timeoutMs, ...signal === undefined ? {} : { signal } }
  }

  /**
   * Read the stored token record, discarding one issued by another deployment.
   * @returns the record, or undefined when absent or unusable.
   */
  private async readTokens(): Promise<CcworkTokenRecord | undefined> {
    const record = await this.ctx.credentials.readRecord(TOKENS_KEY)
    if (record === undefined) return undefined
    if (record.kind !== 'grant') return undefined
    const parsed = tokenRecord.safeParse(record.payload)
    if (!parsed.success) return undefined
    return parsed.data
  }

  /**
   * Read the stored organization record.
   * @returns the record, or undefined when absent or malformed.
   */
  private async readProfile(): Promise<CcworkProfileRecord | undefined> {
    const record = await this.ctx.credentials.readRecord(PROFILE_KEY)
    if (record === undefined || record.kind !== 'grant') return undefined
    const parsed = profileRecord.safeParse(record.payload)
    return parsed.success ? parsed.data : undefined
  }

  /** Persist a freshly issued session. */
  private async writeTokens(session: CcworkSession): Promise<void> {
    const now = Date.now()
    const payload: CcworkTokenRecord = {
      version: 1,
      issuer: this.base,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      accessExpiresAt: now + session.accessExpiresInMs,
      // ccwork reports the access lifetime; the refresh token outlives it by a
      // wide margin whose exact value the client is not told, so it is tracked
      // as expired only by the server's own answer at the next refresh.
      refreshExpiresAt: Number.POSITIVE_INFINITY,
      ...session.userId === undefined ? {} : { userId: session.userId },
      ...session.username === undefined ? {} : { username: session.username },
    }
    await this.ctx.credentials.modifyRecord(TOKENS_KEY, () => Promise.resolve({ kind: 'grant', payload }))
    this.refreshState.refreshedAt = now
  }

  /** Drop both records and tell watchers. */
  private async discard(reason: 'expired' | 'signed-out'): Promise<void> {
    await this.ctx.credentials.deleteRecord(TOKENS_KEY)
    await this.ctx.credentials.deleteRecord(PROFILE_KEY)
    this.refreshState.refreshedAt = 0
    this.ctx.emit(reason === 'expired' ? 'ccwork-account/session-expired' : 'ccwork-account/signed-out')
  }

  /**
   * Resolve a usable access token, refreshing when the stored one is near
   * expiry. Concurrent callers share one refresh.
   * @param signal - withdraws the refresh.
   * @returns the token, or undefined when signed out.
   */
  async resolveAccessToken(signal?: AbortSignal): Promise<string | undefined> {
    if (this.closed) return undefined
    const record = await this.readTokens()
    if (record === undefined) return undefined
    if (!issuerMatches(record, this.base)) {
      await this.ctx.credentials.deleteRecord(TOKENS_KEY)
      return undefined
    }
    if (accessTokenUsable(record, Date.now())) return record.accessToken
    if (this.refreshState.promise === undefined) {
      this.refreshState.promise = this.refresh(record, signal).finally(() => { this.refreshState.promise = undefined })
    }
    return this.refreshState.promise
  }

  /**
   * Rotate the stored session, applying ccwork's status semantics: only a
   * determined rejection discards the credentials, while a throttle or a
   * concurrent rotation keeps them.
   * @param record - the record to rotate.
   * @param signal - withdraws the rotation.
   * @returns the new access token, or undefined when the session is rejected.
   */
  private async refresh(record: CcworkTokenRecord, signal?: AbortSignal): Promise<string | undefined> {
    // A refresh that just succeeded is reused rather than repeated: ccwork
    // rate-limits this endpoint, and a burst would otherwise start one per call.
    if (recentlyRefreshed(this.refreshState.refreshedAt, Date.now()) && accessTokenUsable(record, Date.now())) {
      return record.accessToken
    }
    let lastError: unknown
    for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
      try {
        const session = await refreshSession(this.base, record.refreshToken, this.callOptions(signal))
        await this.writeTokens(session)
        return session.accessToken
      } catch (error) {
        if (!(error instanceof CcworkError)) throw error
        lastError = error
        if (error.kind === 'rejected') {
          await this.discard('expired')
          return undefined
        }
        if (error.kind === 'conflict') {
          // Another writer rotated first. Re-read before retrying: their fresh
          // token may already be stored, in which case no retry is needed.
          const stored = await this.readTokens()
          if (stored !== undefined && stored.refreshToken !== record.refreshToken) {
            if (accessTokenUsable(stored, Date.now())) return stored.accessToken
            record = stored
          }
          await delay(conflictBackoffMs(Math.random), AbortSignal.timeout(this.requestTimeout))
          continue
        }
        if (error.kind === 'throttled') {
          // Keep the credentials. Serve the still-valid token rather than
          // failing a request the user already has authorization for.
          if (accessTokenUsable(record, Date.now())) return record.accessToken
          throw error
        }
        // Transient and invalid both keep the credential; the caller retries.
        throw error
      }
    }
    throw lastError instanceof Error ? lastError : new CcworkError('ccwork refresh did not settle', 'transient')
  }

  /** Run one sign-in attempt under the caller's chosen method. */
  private async run(session: AuthorizationSession): Promise<void> {
    switch (session.method) {
      case 'device': {
        await this.runDevice(session)
        return
      }
      case 'password': {
        await this.runPassword(session)
        return
      }
      case 'register': {
        await this.runRegister(session)
        return
      }
      default: {
        throw new AuthorizationError(`unknown ccwork sign-in method "${session.method}"`, 'UNKNOWN_METHOD')
      }
    }
  }

  /** Commit a freshly authorized session under the running attempt. */
  private async commit(session: AuthorizationSession, authorized: CcworkSession): Promise<void> {
    const organizations = await listOrganizations(this.base, authorized.accessToken, this.callOptions(session.signal))
    const chosen = selectOrganization(organizations)
    if (chosen === undefined) throw new CcworkError('ccwork reported no organization for this account', 'invalid')
    const tokens: CcworkTokenRecord = {
      version: 1,
      issuer: this.base,
      accessToken: authorized.accessToken,
      refreshToken: authorized.refreshToken,
      accessExpiresAt: Date.now() + authorized.accessExpiresInMs,
      refreshExpiresAt: Number.POSITIVE_INFINITY,
      ...authorized.userId === undefined ? {} : { userId: authorized.userId },
      ...authorized.username === undefined ? {} : { username: authorized.username },
    }
    const profile: CcworkProfileRecord = { version: 1, organizationId: chosen.id, organizations }
    await session.commit({ kind: 'grant', payload: tokens } satisfies CredentialRecord)
    await this.ctx.credentials.modifyRecord(PROFILE_KEY, () => Promise.resolve({ kind: 'grant', payload: profile } satisfies CredentialRecord))
    this.refreshState.refreshedAt = Date.now()
  }

  /** Device authorization: show the code, then poll until approved. */
  private async runDevice(session: AuthorizationSession): Promise<void> {
    const challenge = await startDeviceAuthorization(
      this.base, CLIENT_ID, `${platform()} ${arch()}`, this.callOptions(session.signal, this.pollTimeout),
    )
    session.notify({
      message: 'Open the page below and confirm the code to sign in to ccwork.',
      url: challenge.verificationUriComplete,
      code: challenge.userCode,
    })
    const deadline = Date.now() + challenge.expiresInMs
    let interval = challenge.intervalMs
    while (Date.now() < deadline) {
      if (session.signal.aborted) throw new AuthorizationError('ccwork sign-in was withdrawn', 'ABORTED')
      await delay(interval, session.signal)
      try {
        const options = this.callOptions(session.signal, this.pollTimeout)
        const authorized = await pollDeviceAuthorization(this.base, challenge.deviceCode, options)
        await this.commit(session, authorized)
        return
      } catch (error) {
        if (isDevicePending(error)) continue
        if (isDeviceSlowDown(error)) {
          interval += challenge.intervalMs
          continue
        }
        if (isDeviceDenied(error)) throw new AuthorizationDeclinedError('ccwork sign-in was denied in the browser')
        if (isDeviceExpired(error)) throw new AuthorizationError('the ccwork approval code expired', 'EXPIRED')
        throw error
      }
    }
    throw new AuthorizationError('the ccwork approval code expired', 'EXPIRED')
  }

  /** Password sign-in. The password is prompted as a secret, never notified. */
  private async runPassword(session: AuthorizationSession): Promise<void> {
    const username = await session.prompt({ kind: 'text', message: 'ccwork email, phone number, or username' })
    const password = await session.prompt({ kind: 'secret', message: 'ccwork password' })
    const remember = await session.prompt({
      kind: 'select',
      message: 'How long should this sign-in last?',
      options: [
        { id: 'no', label: 'Until it expires (24 hours)' },
        { id: 'yes', label: 'Keep me signed in (30 days)' },
      ],
    })
    const authorized = await passwordLogin(this.base, {
      username,
      password,
      rememberMe: remember === 'yes',
    }, this.callOptions(session.signal))
    await this.commit(session, authorized)
  }

  /** Account creation, which ccwork signs in immediately on success. */
  private async runRegister(session: AuthorizationSession): Promise<void> {
    const kind = await session.prompt({
      kind: 'select',
      message: 'How should the new account be identified?',
      options: [{ id: 'email', label: 'Email address' }, { id: 'phone', label: 'Phone number' }],
    })
    const identifier = await session.prompt({ kind: 'text', message: kind === 'phone' ? 'Phone number' : 'Email address' })
    const inviteCode = await session.prompt({ kind: 'text', message: 'Invite code, if you have one' })
    await sendVerificationCode(this.base, {
      username: identifier,
      ...inviteCode === '' ? {} : { inviteCode },
    }, this.callOptions(session.signal))
    const verificationCode = await session.prompt({ kind: 'text', message: 'The verification code ccwork just sent' })
    const nickname = await session.prompt({ kind: 'text', message: 'Display name (optional)' })
    const password = await session.prompt({ kind: 'secret', message: 'Choose a password' })
    const authorized = await register(this.base, {
      ...kind === 'phone' ? { phone: identifier } : { email: identifier },
      password,
      ...nickname === '' ? {} : { nickname },
      verificationCode,
      ...inviteCode === '' ? {} : { inviteCode },
    }, this.callOptions(session.signal))
    await this.commit(session, authorized)
  }

  /**
   * Read what the provider currently holds, without any secret.
   * @returns the account view.
   */
  async getState(): Promise<CcworkAccountView> {
    const tokens = await this.readTokens()
    if (tokens === undefined) return { status: 'signed-out' }
    const profile = await this.readProfile()
    return {
      status: 'signed-in',
      ...tokens.userId === undefined ? {} : { userId: tokens.userId },
      ...tokens.username === undefined ? {} : { username: tokens.username },
      ...profile === undefined ? {} : { organizationId: profile.organizationId },
    }
  }

  /**
   * List the organizations the account can read.
   * @param signal - withdraws the request.
   * @returns the organizations, or an empty list when signed out.
   */
  async getOrganizations(signal?: AbortSignal): Promise<readonly CcworkOrganization[]> {
    const token = await this.resolveAccessToken(signal)
    if (token === undefined) return []
    try {
      return await listOrganizations(this.base, token, this.callOptions(signal))
    } catch (error) {
      if (error instanceof CcworkError && error.kind === 'rejected') await this.discard('expired')
      return []
    }
  }

  /**
   * Read the credits available to the account's organization.
   * @param signal - withdraws the request.
   * @returns the balance, or undefined when signed out or unreadable.
   */
  async getWallet(signal?: AbortSignal): Promise<CcworkWallet | undefined> {
    return this.withOrganization(signal, (token, organizationId) =>
      readWallet(this.base, token, organizationId, this.callOptions(signal)))
  }

  /**
   * Read the model catalog for the account's organization.
   * @param signal - withdraws the request.
   * @returns the catalog, or undefined when signed out or unreadable.
   */
  async getCatalog(signal?: AbortSignal): Promise<CcworkCatalog | undefined> {
    return this.withOrganization(signal, (token, organizationId) =>
      readCatalog(this.base, token, organizationId, this.callOptions(signal)))
  }

  /**
   * Read one page of the consumption ledger.
   * @param query - paging and time bounds.
   * @param signal - withdraws the request.
   * @returns the page, or undefined when signed out or unreadable.
   */
  async getUsageEvents(query: UsageQuery, signal?: AbortSignal): Promise<CcworkUsagePage | undefined> {
    return this.withOrganization(signal, (token, organizationId) =>
      readUsageEvents(this.base, token, organizationId, query, this.callOptions(signal)))
  }

  /**
   * Read aggregated spend over a trailing window.
   * @param days - window length.
   * @param signal - withdraws the request.
   * @returns the aggregate, or undefined when signed out or unreadable.
   */
  async getUsageDashboard(days: number, signal?: AbortSignal): Promise<CcworkUsageDashboard | undefined> {
    return this.withOrganization(signal, (token, organizationId) =>
      readUsageDashboard(this.base, token, organizationId, days, this.callOptions(signal)))
  }

  /**
   * Run one organization-scoped read against a token this call resolved.
   *
   * A read that the server rejects clears the stored session, because the
   * rejection is the only signal that the refresh token is no longer usable.
   *
   * @param signal - withdraws the request.
   * @param read - the call, given a token and the chosen organization.
   * @returns the read's value, or undefined when signed out, unselected, or unreadable.
   */
  private async withOrganization<T>(
    signal: AbortSignal | undefined,
    read: (token: string, organizationId: string) => Promise<T>,
  ): Promise<T | undefined> {
    const token = await this.resolveAccessToken(signal)
    if (token === undefined) return undefined
    const profile = await this.readProfile()
    if (profile === undefined || profile.organizationId === '') return undefined
    try {
      return await read(token, profile.organizationId)
    } catch (error) {
      if (error instanceof CcworkError && (error.kind === 'rejected' || error.kind === 'invalid')) {
        if (error.kind === 'rejected') await this.discard('expired')
      }
      return undefined
    }
  }

  /**
   * Remove the stored session, locally first, then revoking it in the
   * background. A remote failure never restores local sign-out.
   * @returns the signed-out view.
   */
  async signOut(): Promise<CcworkAccountView> {
    const record = await this.readTokens()
    await this.discard('signed-out')
    if (record !== undefined) {
      void logout(this.base, record.accessToken, this.callOptions())
        .catch((error: unknown) => { this.ctx.logger.debug('ccwork logout did not complete: %o', error) })
    }
    return { status: 'signed-out' }
  }

  /**
   * The URL a user opens to top up the account, for a surface to link.
   * @returns the top-up page for the configured deployment.
   */
  topUpUrl(): string {
    return joinUrl(this.base.replace(/\/api$/u, ''), '/top_up')
  }
}

export default CcworkAccount
