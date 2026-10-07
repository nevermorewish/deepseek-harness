---
description: "Authorize a ccwork account, keep its tokens in the existing local credential store, and read the wallet, model catalog, and consumption ledger the account is billed against."
kind: "package-reference"
---

# @deepseek-ai/dsh-ccwork-account

English | [中文](README.zh.md)

This package signs the harness in to a ccwork deployment and answers what that account may spend. It owns one credential record holding the tokens and one non-secret record holding the chosen organization. Every wallet, catalog, and usage read is scoped to that organization, which ccwork requires on the request.

## Summary

Sign in through a device authorization approved in a browser, a password prompt, or account registration. Tokens live in the existing local credential store, so the CLI, the Web host, and the Desktop host share one sign-in. Only a determined server rejection discards them; a throttle or a concurrent rotation keeps them.

## Table of Contents

- [Use this package](#use-this-package)
- [Sign-in methods](#sign-in-methods)
- [Token lifetime and refresh](#token-lifetime-and-refresh)
- [Organization selection](#organization-selection)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The plugin registers an authorization flow for the `ccwork-account/default` credential key, so any surface that lists what a user may authorize offers it, and `ctx.authorization.begin` runs it. Configuration names the deployment:

```yaml
- id: ccwork-account
  config:
    apiBaseUrl: https://ccwork.site/api
```

`apiBaseUrl` defaults to the ccwork deployment the harness ships against. A stored record whose `issuer` differs from the configured base is deleted at startup rather than sent to the wrong host.

The wallet reads `available_credits_precise`, `credits_frozen_precise`, and `credits_precise`, preserving ccwork's decimal strings. The integer forms ccwork also sends lose the fraction credits are charged in, so they are only a fallback. The catalog read maps `context_window_tokens` and `max_output_tokens`, and the usage read fixes its meter to `llm.tokens` so LLM spend is not mixed with the storage and media rows the same endpoint serves.

<a id="sign-in-methods"></a>
## Sign-in methods

`device` leads the flow's method list. The provider posts to `/auth/device/code`, reports the short code and the pre-filled verification URL as separate notice fields — a notice carries a message, a page, and a code, and a surface renders each — then polls `/auth/device/token` at the interval ccwork returns until the human approves. The RFC 8628 outcomes are handled distinctly: `AUTHORIZATION_PENDING` keeps polling, `SLOW_DOWN` widens the interval, `ACCESS_DENIED` settles the attempt as declined rather than failed, and `EXPIRED_TOKEN` fails it.

`password` prompts for the identifier and the password. The password is collected as a `secret` prompt so a surface masks it and keeps it out of logs; it is never placed in a notice. The identifier accepts an email address, a phone number, or a username, because ccwork resolves all three from one field.

`register` creates an account through `/auth/send-verification-code` and `/auth/register`. The invite code is requested as an optional field because the deployment decides whether it is required — ccwork's own settings default both ways depending on the profile it runs, so the flow accepts an empty answer and lets the server reject a missing one. Registration returns a session directly, so no second sign-in follows.

<a id="token-lifetime-and-refresh"></a>
## Token lifetime and refresh

ccwork issues a 24-hour access token (`remember_me` extends it to 7 days) and rotates both tokens on every refresh. A refresh happens inside one `modifyRecord` read-decide-replace, so two processes sharing one credential store cannot rotate the same refresh token concurrently and lose whichever wrote first.

A refresh that succeeded within the last 30 seconds is reused rather than repeated, because ccwork rate-limits that endpoint and a burst of requests would otherwise start one refresh each. An access token inside a two-minute expiry buffer is treated as expiring.

The failure classes are the reason this logic is separate from storage. The envelope's business code is read before the HTTP status, because ccwork has answered a throttled refresh with 401: a status-first check would sign out a user who is merely being rate limited.

- A throttle (`RATE_LIMITED`, or HTTP 408/425/429) keeps the credentials. If the stored access token is still valid it is served rather than failing a request the user already authorized.
- A concurrent rotation (`REFRESH_CONFLICT`, or HTTP 409) keeps the credentials. The store is re-read first, because the other writer's fresh token may already be there, and only then is the request retried with jittered backoff, at most twice.
- A determined rejection (HTTP 401/403/404, or a code naming an invalid token, unknown user, or disabled account) discards both records and emits `ccwork-account/session-expired`.
- A server fault or a transport failure keeps the credentials and surfaces an error for the caller to retry.

Sign-out deletes the local records first and revokes the session in the background; a failed revocation never restores local sign-out.

<a id="organization-selection"></a>
## Organization selection

ccwork carries no organization on the login response, so the provider lists `/context/organizations` after authorizing and picks one. ccwork's own client order is used — a personal organization first, then the account default, then the first listed — because choosing the default first would show a different balance than ccwork's desktop app for an account whose default is a team.

The choice and the full list are stored in the non-secret `ccwork-account/profile` record. The chosen id is sent as `X-TabTin-Organization-Id` on every wallet, catalog, and usage read.

<a id="model-experience"></a>
## Model Experience

None. Account credentials affect HTTP authentication and never enter model prompts, Session logs, or tool results.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Tokens are stored in the shared local credential document, which this package does not encrypt and which the Desktop host does not seal with Electron `safeStorage`. On a single-user machine that is the same protection the harness already gives an API key; a multi-user or remote Web host shares the signed-in account with every browser that reaches it. Moving the token record behind an encrypting credential provider is deferred and needs no change here, because the storage seam is replaceable.
- No organization switcher is offered. The account's organizations are recorded for one, but the provider only auto-selects; a team whose spend the user wants to inspect instead of their personal organization has no UI path yet.
- `refreshExpiresAt` is recorded as unbounded because ccwork does not tell the client how long a refresh token lives. Expiry is therefore discovered from the server's own rejection at the next refresh rather than predicted, which is correct but means the first request after expiry pays for the discovery.
- The wallet is read on demand and not polled, and the provider receives no signal when spend occurs elsewhere, so a visible balance can be stale until the surface refreshes it. ccwork exposes no push channel this package subscribes to.
