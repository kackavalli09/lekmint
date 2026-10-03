# Static Netlify frontend, Start9 transaction service

The operator confirmed `lekmint.cash` as the existing public wallet address.
Preserve `https://lekmint.cash` and mint identity `https://lekmint.cash/api`;
set `PUBLIC_CANONICAL_ORIGIN=https://lekmint.cash` when preparing Netlify.
The distinct Start9 upstream has not been supplied or provisioned. Do not use
the public wallet origin as `START9_API_ORIGIN`, which would create a proxy loop.

This prepares a combined static site only: the existing wallet at `/`, admin at
`/admin/`, and same-origin `/api` requests proxied to Start9. It does not deploy,
create a Netlify site, change DNS, or run the ledger. Replit's existing builds and
preview routes are unchanged. The canvas/preview sandbox is not included.

## Before linking GitHub

1. Confirm the **existing public HTTPS origin** used by real wallets. Keep the
   exact scheme, hostname and port; do not substitute a Netlify subdomain or
   guess a new domain. Browser IndexedDB, local storage and admin sessions are
   origin-bound. Wallet token mint URLs still derive from `window.location.origin`
   plus `/api`; no proof-storage migration or automatic export is performed.
   Changing hostnames makes existing browser funds appear absent and changes
   minted token URLs. Back up/export using **Recover → Export Local Backup**
   before any operator migration.
2. Provision Start9 with a **different**, publicly reachable HTTPS hostname and
   trusted certificate. `START9_API_ORIGIN` is that origin only, **not** `/api`.
   Verify `/api/readyz` returns HTTP 200 and `status: "ready", mode: "active"`.
   Maintenance, standby, timeouts, malformed bodies, and non-200 statuses display
   an outage banner. The upstream must never resolve back to this Netlify site
   through DNS aliases or redirects (origin-string validation cannot detect this).
3. Keep a single active transaction authority. Do not activate Replit standby
   and Start9 together. Do not reroute failed mutations automatically; retain
   pending requests/proofs and reconcile through existing recovery procedures.

## Link and prepare

1. Push the reviewed code to the existing GitHub repository. In Netlify use
   **Add new site / Import an existing project / GitHub**, authorize only the
   intended repository, and choose the production branch.
2. Use repository root as base directory, `netlify.toml` as configuration.
   Build command: `node --test ops/netlify/build.test.mjs && node ops/netlify/build.mjs`.
   Publish directory: `ops/netlify/dist`. Use Node 22 and the repository's pnpm
   version/lockfile; allow Netlify to install workspace dependencies with pnpm.
   Do not run the root recursive build (it includes backend and sandbox).
3. Set explicit build variables:
   - `PUBLIC_CANONICAL_ORIGIN`: the **existing** wallet public HTTPS origin.
   - `START9_API_ORIGIN`: Start9's distinct HTTPS origin, without credentials,
     query, fragment or path (one trailing slash is accepted).
   These are not passwords. Do not put auth tokens, database URLs, signing keys
   or API credentials in `VITE_*` variables or redirect destinations.
   Missing/invalid origins or an origin matching the public/Netlify site URL
   fail preparation. `PORT` and `BASE_PATH` overrides are local to these two
   child builds; they never alter Replit's configuration.
4. Disable automatic deploy previews and branch deploys initially, or scope
   upstream variables strictly to production. Preview hostnames must not issue
   real money transactions or create tokens pointing at a disposable hostname.
   Public canonical origin is a build safety check, **not** a storage-domain
   override or browser redirect; opening a preview does not access canonical
   browser proofs. The helper never chooses a target domain for you.
5. Before any domain cutover, inspect the generated `_redirects`, verify static
   files under `/admin/assets/`, direct wallet routes, `/admin` → `/admin/`,
   admin login, and exact `/api` plus `/api/*` failure responses. API 401/404/503
   must stay API responses and never return wallet HTML. Test an upstream
   outage, recovery and readiness timeouts. Do not infer proxy correctness from
   local Replit routes; validate on an isolated Netlify site before DNS changes.
6. Only with explicit operator approval, attach the **existing** public domain
   and arrange certificate/DNS cutover. This repository performs neither.
   Preserve recovery access on the old service until checks pass. Rollback must
   route to the intended active backend, not accidentally awaken a standby.

## Proxy security and operations

Generated rules place forced exact `/api` and `/api/*` rewrites first, then the
exact `/admin` redirect and separate admin SPA fallback. API failures do not
reach the wallet fallback. Existing admin assets are not forcibly rewritten.
`/__mockup` and descendants return 404. API cache headers request `no-store`;
the readiness endpoint must itself also send `Cache-Control: no-store`.

Netlify proxying does **not** add authentication, make the upstream private,
or enforce server-side transaction maintenance. Preserve upstream bearer/admin
authentication, TLS, rate limiting, and server maintenance/standby mutation
guards. Review forwarded `Host`/`Origin`/`X-Forwarded-*` behavior on an actual
Netlify deploy; configure server public origin to the existing canonical origin
and trust only the required proxy ingress. Never blindly trust spoofable
forwarded headers or configure wildcard CORS to fix a proxy issue. Do not embed
an upstream credential in `_redirects`; it is a published artifact. Ensure
upstream redirects cannot send clients to a different mint/browser origin.

The small banner polls only `GET /api/readyz`, once a minute while the tab is
visible, with an 8-second timeout and no immediate retry/replay. It never clears
storage, remounts the wallet, auto-recovers or repeats a failed transaction.
Manual recovery remains reachable; **Recover → Export Local Backup** reads all
four existing IndexedDB stores in a single read-only transaction and downloads
an unencrypted JSON recovery backup without network access or proof mutation.
Protect this file as cash; it includes token secrets, pending blindings and
history (including previously sent bearer tokens). Automatic import is not
provided, and an export is not a transferable Cashu token. It is advisory: server-side
guards are authoritative and a ready result can become stale immediately.
Existing page-specific transaction workflows have their own behavior; the
banner does not change or replay them.

**Billing caveat:** static hosting is inexpensive, not guaranteed free.
Each open visible wallet/admin tab makes readiness requests; Netlify proxy
requests/bandwidth and build usage may count toward plan credits/limits, as may
Start9 ingress. Configure billing alerts and monitor costs, request volume,
availability and certificates. Suspended/hidden tabs pause banner polling.

## Local preparation checks (no publication)

`node --test ops/netlify/build.test.mjs` tests strict origin validation, recursion
rejection and rule ordering without credentials or network access.

With real operator-approved origins in your environment, run
`node ops/netlify/build.mjs` to build only the two frontends and generate the
publish directory. This never starts a server or deploys anything. Placeholder
domains in tests are deliberately non-resolving and are not deployment defaults.