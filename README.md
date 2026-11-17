# Cloud identity backend — version 4

This document describes the version-4 backend. Deployment and release evidence is recorded in outputs/production_release_report.md; older local-readiness reports are historical.
The existing public URL is `https://qodra-pharmacy-api.onrender.com` and is also the Flutter default. `BACKEND_URL` can override it. Never include backend secrets in Flutter.

## Requirements

Node >=22; existing Supabase project; existing Render service (Root Directory blank for the supplied standalone repository; `backend` only for the full Flutter repository), build `npm ci`, start `npm start`, liveness `/health`. Keep the existing `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPER_ADMIN_USERNAME`, `SUPER_ADMIN_PASSWORD`. Add an independent `SESSION_SECRET` containing at least 32 random bytes of material, e.g. a securely generated 64-character hex string. Startup refuses a missing/short signing secret. Do not change production variables without explicit approval. Keep the signing secret stable: rotation invalidates tokens and changes provisioning request fingerprints, so first reconcile pending requests. Do not use the Supabase key as the signing secret. `RENDER_GIT_COMMIT` supplies the public build identifier.

The approved rollout requires migrations 003 and 004. Migrations 001 and 002 are historical prerequisites; inspect the production schema before applying anything. Migration 003 is additive, includes a bounded orphan/duplicate/association preflight, and aborts the transaction if data cannot be safely associated. It adds an account pharmacy FK, permanent Shop ID enforcement, session revocation/version triggers, idempotency ledger, archive metadata, and service-role-only RPCs. No local SQLite identities are automatically imported.

Migration 003 remains unchanged from the prior handoff. Migration 004 replaces only the management RPC to add Shop Admin activity controls, reject null status inputs, and allow safe restore retries. It records schema version 4; readiness requires it. Both migrations have isolated native PostgreSQL coverage.

The supplied production source repository is **standalone**: `raiarslan1744/Pharmacy-backend`, branch `main`. Its observed commit `72a1287c5878d8b9d77bdca579eb64aae0d826cf` contains only health/login routes. Leave Render Root Directory **blank** for this repo. The project's root render.yaml with `rootDir: backend` applies only to the full Flutter project layout. Run `python tools/prepare_render_bundle.py` to prepare a standalone source ZIP locally; never push it without approval because Render may auto-deploy. Verify live Render settings/deployed commit before release.

## HTTP contract

All responses use JSON and `Cache-Control: no-store`. Tokens belong in Authorization headers only. HTTPS is required on the public service. Secrets, tokens, plaintext passwords and request bodies are not logged.

| Method | Path | Access and behavior |
| --- | --- | --- |
| GET | `/health` | Public process liveness, 200 |
| GET | `/version` | Public API version `4` and Render commit or `local` |
| GET | `/ready` | 200 only after bootstrap and visible migration version 4; otherwise 503 |
| POST | `/api/login` | `{username,password,shopId}`; Super Admin uses empty Shop ID |
| POST | `/api/logout` | Bearer Super Admin token; revoke this session, 200 |
| GET | `/api/admin/shops` | Bearer Super Admin token; cloud pharmacy list, no password hashes |
| POST | `/api/admin/shops` | Bearer token and `Idempotency-Key`, create atomically or replay original result, 201 |
| POST | `/api/admin/shops/manage` | Bearer token; `{shopId,action,payload}`, transaction RPC, 200 |

Every protected request checks HMAC signature, expiry, active global Super Admin role, persistent session ID, revocation, stored expiry and account credential version. New logins create independent random UUID sessions with a maximum eight-hour life. Disabling or changing account credentials increments the version and revokes existing sessions through database triggers. Old stateless tokens are rejected. Logout needs connectivity; Flutter retains the session and shows an error if revocation cannot be confirmed.

Creation body: `{shopId,name,address,phone,username,password,isLifetime,licenseExpiryDate}`. Password must be 12–1024 characters with no surrounding whitespace; scrypt hashes stay server-side. Non-lifetime new shops require a future ISO expiry. Lifetime uses null expiry. `Idempotency-Key` must be 16–128 ASCII letters, digits, underscores or hyphens. Flutter derives a stable key from backend origin, Super Admin username and permanent Shop ID, without password material. Retry identical details with the same key, including after an unknown timeout. A conflicting payload returns 400; another key colliding with an existing identity returns 409. Do not delete idempotency records while clients may retry. Replays return the original result even after its license expires. The SQL primary key serializes competing requests for the same actor/key; both inserts and the result ledger commit in one transaction.

Management actions: `account` payload `{active:true|false}` disables/enables the single Shop Admin without changing its permanent Shop ID; `update` payload `{name,address,phone,username,password?}`; `status` `{status:'active'|'suspended'}`; `license` `{isLifetime,licenseExpiryDate}`; `archive` or `restore` `{confirmationShopId}`. Password hashes supplied by clients are discarded. Archive suspends access and retains all records. No hard-delete API exists. Flutter retrieves the authoritative cloud list on entry, refresh, creation and management. It supports suspend/reactivate, edit Shop Admin username/password and shop details, disable/enable the Shop Admin, renew licenses, deactivate (archive), and restore. Pending operations block duplicate submission. Errors never fall back to SQLite; unknown write outcomes require refreshing cloud status. A failed list request clears the displayed list and shows a retryable error. Cloud Super Admin's own credential settings remain disabled rather than modifying local credentials. Explicit `LOCAL_AUTH=true` retains legacy offline development flows.

Errors: 400 input/key conflict/state, 401 invalid/expired/revoked token, 403 unauthorized/inactive account or suspended/expired shop login, 404 unknown route/shop, 409 duplicate identity, 413 oversized body, 429 rate limit, 503 backend/database/unconfirmed write outcome. A 503/timeout after creation does not prove rollback: retry identical details/key. Limits are per-process (60 logins and 10 creates/minute), not a distributed rate limiter.

## Compatibility and verification

Shop Admin login is username + password + permanent Shop ID; it works from a second device once the backend and schema are deployed. Missing, invalid and expired non-lifetime licenses fail closed. Inventory, sales and finance remain device-local. Cloud login never falls back to SQLite. Explicit local mode retains SHA-256 local credentials and offline flows; hashes are not converted or uploaded.

Run `npm test` in backend. Run `flutter test` and `flutter test --dart-define=LOCAL_AUTH=true` at project root; tests specific to the other mode explicitly skip. Run `flutter analyze`. For PGlite validation: `npm ci --prefix tools/validation`, then `node tools/validation/validate.mjs`. This uses PGlite's PostgreSQL engine, not a JavaScript database mock, but uses one connection and does not prove native multi-connection concurrency, Supabase role/exposure configuration, Render connectivity or production backfill. Native PostgreSQL validation is available via `node tools/validation/native.mjs`. It creates its own local-only PostgreSQL 17.6 cluster, takes no production connection settings, tests distinct server connections contending on an actual PostgreSQL lock, and stops the cluster in finally. Read `outputs/final_production_readiness_report.md` for current results, deployment order and rollback; it supersedes the previous handoff.

## Release verification tool

release-smoke.mjs is inert unless PHARMACY_RUN_RELEASE_CHECK=1 and a validated PHARMACY_RELEASE_CHECK_ID are explicitly supplied. It verifies only the confirmed Pharmacy service/project, uses existing server-side credentials without printing them, operates on designated release test shops, and archives those test shops. It is not part of the normal startup command. The release verification switch is disabled after testing.
