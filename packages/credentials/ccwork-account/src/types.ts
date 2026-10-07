/**
 * Wire-safe types for the ccwork account provider, free of cordis/service
 * imports so browser type chains can consume them without loading this
 * package's Context augmentation.
 * @module @deepseek-ai/dsh-ccwork-account/types
 */

/** One ccwork organization the signed-in account can spend from. */
export interface CcworkOrganization {
  /** Organization identifier used by every wallet, catalog, and billing path. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Whether this is a personal (single-member) organization. */
  readonly type: string
  /** Whether ccwork marks this organization as the account default. */
  readonly isDefault: boolean
}

/** What the account provider currently holds, without any secret. */
export interface CcworkAccountView {
  /** `signed-out` when no token record is stored. */
  readonly status: 'signed-out' | 'signed-in'
  /** Stable ccwork user id from the login response, when signed in. */
  readonly userId?: string | undefined
  /** Display name from the login response, when signed in. */
  readonly username?: string | undefined
  /** Organization every wallet, catalog, and usage read is scoped to. */
  readonly organizationId?: string | undefined
}

/**
 * A credit balance read from ccwork. The precise decimal is the display value;
 * the integer form loses the fraction ccwork charges in.
 */
export interface CcworkWallet {
  /** Organization the balance belongs to. */
  readonly organizationId: string
  /** Exact spendable credits as ccwork formatted them. */
  readonly availableCredits: string
  /** Exact credits held by in-flight work. */
  readonly frozenCredits: string
  /** Exact total credits, frozen included. */
  readonly totalCredits: string
}

/** One model entry from the ccwork catalog. */
export interface CcworkCatalogModel {
  /** Model id sent as `model` on an inference request. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Maximum prompt-plus-completion context ccwork advertises. */
  readonly contextWindow?: number | undefined
  /** Maximum completion tokens ccwork advertises. */
  readonly maxTokens?: number | undefined
  /** Whether the model accepts image input. */
  readonly supportsVision: boolean
}

/** The catalog ccwork serves for one organization. */
export interface CcworkCatalog {
  /** Selectable models. */
  readonly models: readonly CcworkCatalogModel[]
  /** Organization the catalog was read for, sent as `X-TabTin-Organization-Id`. */
  readonly organizationId: string
}

/** One consumption record from the ccwork billing ledger. */
export interface CcworkUsageEvent {
  /** Ledger row id. */
  readonly id: string
  /** Meter the row belongs to, such as `llm.tokens`. */
  readonly meterKey: string
  /** Consumed quantity in `unit`. */
  readonly quantity: string
  /** Unit of `quantity`. */
  readonly unit: string
  /** Credits charged, as ccwork formatted them. */
  readonly credits: string
  /** Business type that produced the row. */
  readonly bizType: string
  /** Human-facing task or session name, when ccwork resolved one. */
  readonly taskName?: string
  /** Model that produced the row, when the row is an LLM charge. */
  readonly modelName?: string
  /** ISO timestamp of when consumption occurred. */
  readonly occurredAt: string
}

/** One page of the consumption ledger. */
export interface CcworkUsagePage {
  /** Total rows matching the query, across every page. */
  readonly total: number
  /** The requested page, newest first. */
  readonly events: readonly CcworkUsageEvent[]
}

/** Aggregated spend over a trailing window. */
export interface CcworkUsageDashboard {
  /** Window length in days, as requested. */
  readonly periodDays: number
  /** Credits charged in the current calendar month. */
  readonly currentMonthTotalCredits: string
  /** Credits charged today. */
  readonly todayTotalCredits?: string
  /** Percentage change against the previous month, when ccwork computed one. */
  readonly monthOverMonthPct?: number
}

/** The shape written to the `ccwork-account/default` credential record. */
export interface CcworkTokenRecord {
  /** Record version, so a future shape can be rejected rather than misread. */
  readonly version: 1
  /** API base the tokens were issued by; a mismatch discards the record. */
  readonly issuer: string
  /** Bearer token for API requests. */
  readonly accessToken: string
  /** Token exchanged at `/auth/refresh-token`; rotated on every refresh. */
  readonly refreshToken: string
  /** Epoch milliseconds the access token expires at. */
  readonly accessExpiresAt: number
  /** Epoch milliseconds the refresh token expires at. */
  readonly refreshExpiresAt: number
  /** Stable ccwork user id. */
  readonly userId?: string | undefined
  /** Display name at login time. */
  readonly username?: string | undefined
}

/** The shape written to the `ccwork-account/profile` credential record. */
export interface CcworkProfileRecord {
  /** Record version. */
  readonly version: 1
  /** Organization every spend-scoped read uses. */
  readonly organizationId: string
  /** Every organization the account can read, for a future switcher. */
  readonly organizations: readonly CcworkOrganization[]
}
