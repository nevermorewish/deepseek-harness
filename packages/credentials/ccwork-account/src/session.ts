/**
 * Token-record shapes and the refresh decision, kept free of I/O so the
 * status-code rules can be tested directly. The rules here are the ones that
 * decide whether a working session survives a throttle or a concurrent
 * refresh; getting them wrong signs users out of healthy accounts.
 * @module @deepseek-ai/dsh-ccwork-account/session
 */

import { z } from 'zod'
import type { CcworkOrganization, CcworkProfileRecord, CcworkTokenRecord } from './types.ts'

/** One stored token record, validated before any field is trusted. */
export const tokenRecord: z.ZodType<CcworkTokenRecord> = z.object({
  version: z.literal(1),
  issuer: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accessExpiresAt: z.number(),
  refreshExpiresAt: z.number(),
  userId: z.string().optional(),
  username: z.string().optional(),
})

/** One stored organization record. */
export const profileRecord: z.ZodType<CcworkProfileRecord> = z.object({
  version: z.literal(1),
  organizationId: z.string().min(1),
  organizations: z.array(z.object({
    id: z.string().min(1),
    name: z.string(),
    type: z.string(),
    isDefault: z.boolean(),
  })),
})

/** How much of the access token's life must remain for it to be reused. */
export const ACCESS_EXPIRY_BUFFER_MS = 120_000

/** How long a just-refreshed token is reused without asking ccwork again. */
export const REFRESH_FRESHNESS_MS = 30_000

/** Delay before retrying a concurrent-refresh conflict. */
export const CONFLICT_BACKOFF_MS = 1_000

/** Extra random delay added to each conflict retry, to spread racing clients. */
export const CONFLICT_BACKOFF_JITTER_MS = 500

/** How many conflict retries follow the first attempt. */
export const MAX_CONFLICT_RETRIES = 2

/**
 * Decide whether a stored access token still serves requests.
 *
 * A token inside the freshness window is reused even when it is close to
 * expiry, because ccwork rate-limits its refresh endpoint and a burst of
 * requests would otherwise each start a refresh.
 *
 * @param record - the stored token record.
 * @param now - epoch milliseconds.
 * @returns true when the token can be used without refreshing.
 */
export function accessTokenUsable(record: CcworkTokenRecord, now: number): boolean {
  if (record.accessExpiresAt <= now + ACCESS_EXPIRY_BUFFER_MS) return false
  return true
}

/**
 * Whether a refresh that just succeeded is recent enough to reuse.
 * @param refreshedAt - epoch milliseconds of the last successful refresh.
 * @param now - epoch milliseconds.
 * @returns true when the result should be reused instead of refreshed again.
 */
export function recentlyRefreshed(refreshedAt: number, now: number): boolean {
  return now - refreshedAt < REFRESH_FRESHNESS_MS
}

/**
 * Whether the record's issuer still matches the configured API base. A record
 * from another deployment must be discarded rather than sent to the wrong host.
 * @param record - the stored token record.
 * @param issuer - the configured API base.
 * @returns true when the record belongs to this deployment.
 */
export function issuerMatches(record: CcworkTokenRecord, issuer: string): boolean {
  return record.issuer === issuer
}

/**
 * Pick the organization every spend-scoped read uses.
 *
 * The order is ccwork's own client order: a personal organization first, then
 * the account default, then whatever the server listed first. Choosing the
 * default first would show a different balance than ccwork's own desktop app
 * for an account whose default is a team.
 *
 * @param organizations - organizations as ccwork listed them.
 * @returns the chosen organization, or undefined when none exists.
 */
export function selectOrganization(
  organizations: readonly CcworkOrganization[],
): CcworkOrganization | undefined {
  return organizations.find(organization => organization.type === 'personal')
    ?? organizations.find(organization => organization.isDefault)
    ?? organizations[0]
}

/**
 * The first conflict-retry delay, jittered so two clients racing one refresh do
 * not retry in lockstep.
 * @param random - source of [0, 1); injected so tests are deterministic.
 * @returns milliseconds to wait.
 */
export function conflictBackoffMs(random: () => number): number {
  return CONFLICT_BACKOFF_MS + Math.floor(random() * CONFLICT_BACKOFF_JITTER_MS)
}
