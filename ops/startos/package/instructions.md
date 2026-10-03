# Isolated test candidate — not a production installation

This package contains the real API and PostgreSQL images. It has a distinct
package ID, no network interfaces and no activation action. Standby is hardcoded.
Do not upload production data, secrets or signing keys to it.

Installation/device tests require separate approval and an isolated test device.
Nothing is initialized automatically. Without a deliberately provisioned
synthetic PostgreSQL 16 cluster and config files, startup will fail closed.

Expected private volumes:
- postgres: cluster in `pgdata/`, owned by the image's postgres user.
- config: raw synthetic DATABASE_URL, SESSION_SECRET, ADMIN_API_KEY files,
  mode 0600, readable by the image's node user.
- config/pgpass: mode 0600, owned/readable by the PostgreSQL probe process user,
  authenticating `lek_probe` to database `lek` over 127.0.0.1:5432.
  The probe role needs only CONNECT for SELECT 1.

Shared loopback between subcontainers, image user IDs, read-only config mounts,
startup dependencies and reverse shutdown order require actual device tests.
Successful liveness is NOT transaction readiness. `/api/readyz` must return 503.
Native backup and restore intentionally refuse. Never copy live raw PGDATA.
No database migrations, seeds, key generation or cluster initialization run.

Do not route a public domain to this package or use it with real funds.