# AegisPay infrastructure

The repository contains a sandbox-first Docker Compose stack and a development Kubernetes starter. It does not provide authorized payment rails or a production cloud deployment.

## Local services

```sh
./scripts/dev-secrets.sh
docker compose up --build -d
docker compose ps
```

Compose runs the Next.js business dashboard, Go API, PostgreSQL, Redis, FastAPI fraud service, Swagger UI, and Prometheus. The dashboard is published only on localhost port 3000 and proxies its authenticated API calls to the API service over the internal Compose network. The API can reach the internal data network and a separate egress network for validated public HTTPS webhook delivery. PostgreSQL/Redis use persistent volumes and stay on the internal network without host port publication. Swagger and Prometheus are bound to localhost; the API also has an egress network for validated public HTTPS webhook delivery. Redis backs per-IP rate limits. `/metrics` is scraped from the private API service.

Use `scripts/backup-postgres.sh` for a local compressed archive and `scripts/restore-postgres-to-new-db.sh ARCHIVE.dump` to restore into a separate database. These scripts are for development and do not encrypt archives.

## Kubernetes

`infrastructure/kubernetes/base` deploys the API, fraud, Swagger UI, Prometheus, PostgreSQL, and Redis. It requires the `aegispay-secrets` Secret and a default StorageClass. Build/load the API and fraud images into the cluster before applying the Kustomize base. The manifests are for a single-replica development environment.

For hosted deployment, select a cloud and use managed encrypted PostgreSQL/Redis, private networking, TLS at a controlled edge, external secret management, encrypted object storage/backups, tested restores, resource limits, multi-zone availability, monitoring/alerts, separate sandbox/live accounts and CI/CD identities. Migration execution should use a dedicated one-off migration job and least-privilege role, not API startup.

## Security and financial boundary

The bootstrap API key is a privileged local sandbox key. Normal sessions and tenant API keys carry an organization context, and relational constraints match tenant IDs on financial ownership relationships. The API uses bcrypt for passwords, hashed opaque sessions/API keys, Redis rate limiting, transaction-scoped idempotency, double-entry journal lines, approval separation for configured high-value transfers, and public HTTPS-only webhooks with encrypted signing secrets, timestamped HMACs, bounded retries, and private-address blocking.

The service still lacks OIDC, password recovery, database row-level security, automated invitation delivery, provider settlement ingestion, and payment provider adapters. Optional TOTP MFA is available for user sessions, but does not replace a production identity provider or account-recovery process. Sandbox reconciliation can compare net settlement plus a declared provider fee with the original collection gross amount, and unmatched lines can be manually resolved with an audit note; this is not a live provider settlement integration. API keys support optional expiry and manual rotation, and invitations return a one-time token for caller-managed delivery. Per-currency single-transaction, daily volume, and approval thresholds can be configured for sandbox collections/transfers. Real funds, custody, payout, and settlement are not enabled. Do not handle cardholder data.
