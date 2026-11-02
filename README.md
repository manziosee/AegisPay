# AegisPay

AegisPay is a sandbox-first, multi-tenant payment infrastructure platform. It gives businesses a consistent API for internal accounts and ledger operations, simulated collections/refunds, fraud assessment, reconciliation imports, and webhook events.

AegisPay’s internal ledger records activity inside the platform. It does not represent funds held in a bank and does not move money over a real payment network. This repository has no live payment connectors and must not be used to hold or process real funds.

## Current implementation

- Go REST API with PostgreSQL-backed users, sessions, organizations, memberships, role checks, tenant API keys, customers, accounts, collections, refunds, transfers, and ledger entries.
- Passwords are bcrypt hashed. Sessions are opaque, hashed in the database, expire after 12 hours, and can be revoked. API key secrets are SHA-256 hashed and shown only once.
- Composite database constraints enforce tenant ownership across customers, accounts, collections, transfers, and journal lines.
- Financial collection confirmation, refunds, internal transfers, and sandbox credits post balanced journal lines in transactions. Sensitive writes require `Idempotency-Key`; a matching retry replays the original response atomically.
- Transfers above `TRANSFER_APPROVAL_THRESHOLD_MINOR` (default 100,000,000) wait for a distinct authenticated user to approve or reject them.
- Sandbox collections can be confirmed only through an explicit simulation endpoint. They do not prove a provider payment was received.
- Python FastAPI risk scoring is called by the Go API. Assessments and review cases are saved; analysts can resolve cases with an audited note.
- JSON reconciliation imports match succeeded sandbox collections by exact reference, amount, and currency. Lines without an exact eligible match are marked unmatched or exception for review; this is not settlement matching against a payment provider.
- Outbox events are dispatched to registered HTTPS webhooks. Signing secrets are encrypted at rest with `WEBHOOK_ENCRYPTION_KEY`; signatures include a timestamp and HMAC-SHA256. Delivery uses at-least-once retries and blocks private or local destinations to reduce SSRF risk.
- Cursor pagination for customer, account, collection, and transfer lists.
- Redis-backed per-IP rate limits for registration, login, and API calls; Prometheus request counters at `/metrics`.
- Docker Compose, OpenAPI/Swagger UI, Kustomize development manifests, PostgreSQL backup/restore-to-new-database scripts, and a container vulnerability/secret/misconfiguration scan workflow.

The local bootstrap key in `.env` remains a privileged sandbox operator credential. Normal users can register an organization, log in, add already-registered users to their organization, change or suspend memberships, create additional organizations as an owner/admin, and create scoped sandbox API keys. The last active owner cannot be demoted or suspended. Email invitations, MFA, password recovery, login lockout across replicas, tenant PostgreSQL RLS, API-key expiration/rotation workflows, and a production identity provider are not implemented.

## Run locally

Requirements: Docker Engine with Compose v2 and OpenSSL.

```sh
./scripts/dev-secrets.sh
docker compose up --build -d
docker compose ps
```

If `.env` already exists from an earlier version, add a fresh `WEBHOOK_ENCRYPTION_KEY` before registering webhook endpoints:

```sh
printf 'WEBHOOK_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" >> .env
chmod 600 .env
```

The generator refuses to overwrite `.env` and writes new files with mode `600`. Never commit or reuse development secrets in hosted environments.

- API: `http://localhost:18080` (set `API_PORT=8080` to use the conventional port when it is available)
- Swagger UI: `http://localhost:8081`
- Prometheus: `http://localhost:9090`
- PostgreSQL and Redis stay private on the internal Compose network; use `docker compose exec postgres psql` and `docker compose exec redis redis-cli` for administration.
- Fraud service: private to the Compose network at `fraud:8090`

Use `Authorization: Bearer <AEGIS_API_KEY from .env>` for local operator calls. Or register a user with `POST /v1/auth/register` and use the returned bearer session. User sessions can choose an organization using `X-Organization-ID`; the API checks membership for that organization.

Example API flow:

```sh
API_KEY=$(sed -n 's/^AEGIS_API_KEY=//p' .env)
curl -s http://localhost:8080/health/ready
curl -s -H "Authorization: Bearer $API_KEY" http://localhost:8080/v1/organizations
curl -s -X POST http://localhost:8080/v1/customers \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"Demo customer","email":"demo@example.test"}'
curl -s -X POST http://localhost:8080/v1/accounts \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"currency":"RWF"}'
```

Use the returned account ID with `POST /v1/accounts/{id}/sandbox-credit`, including both an `Idempotency-Key` header and a positive amount. All amounts are integer units in the currency’s configured smallest unit. A sandbox credit is simulated and does not represent money received.

Stop containers and retain local data with `docker compose down`. `docker compose down -v` deletes the local database and Redis volumes.

## API and operations

The full API contract is [docs/api/openapi.yaml](docs/api/openapi.yaml). Swagger UI runs on port 8081 and Prometheus on port 9090, both bound to localhost. Lists use `limit` (1–100, default 25) and an opaque `cursor`. API errors include request IDs. The bootstrap key has all sandbox permissions; user roles and API key scopes restrict normal credentials.

To test internal money flows, create two same-currency accounts, sandbox-credit the first, and create a transfer with an idempotency key. A collection stays pending until `POST /v1/collections/{id}/sandbox-confirm` specifies the receiving account. A sandbox refund debits that account. No external provider is called for these operations.

Create a compressed local PostgreSQL archive with `scripts/backup-postgres.sh`. Restore it into a separate database using `scripts/restore-postgres-to-new-db.sh`; the restore script leaves the active database untouched. These local archives are not encrypted. Production backup encryption, retention, and restore drills must be configured in the selected hosting environment.

## Kubernetes development deployment

`infrastructure/kubernetes/base` is a development Kustomize base, not a production topology. It deploys API, fraud service, Swagger UI, PostgreSQL, Redis, and Prometheus. It expects a default StorageClass and a Secret named `aegispay-secrets`.

```sh
kubectl create namespace aegispay
kubectl -n aegispay create secret generic aegispay-secrets \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 32)" \
  --from-literal=APP_DB_PASSWORD="$(openssl rand -hex 32)" \
  --from-literal=REDIS_PASSWORD="$(openssl rand -hex 32)" \
  --from-literal=AEGIS_API_KEY="aegis_test_$(openssl rand -hex 32)" \
  --from-literal=WEBHOOK_ENCRYPTION_KEY="$(openssl rand -hex 32)"
# Build images and load them into kind/minikube before applying manifests.
kubectl apply -k infrastructure/kubernetes/base
```

Load local images with `kind load docker-image aegispay-api:local aegispay-fraud:local`, or use `minikube image load` for each image. Then use `kubectl port-forward svc/api 18080:8080`, `svc/swagger 8081:8080`, or `svc/prometheus 9090:9090` as needed.

Kubernetes Secret values are base64 encoded, not encrypted by default. Configure cluster secret encryption and RBAC or an external secrets manager before use. NetworkPolicies apply only when the cluster CNI enforces them. Update image registries, storage, TLS, resource limits, availability settings, secrets, monitoring, backups, and deployment controls for a hosted environment.

## Remaining before production

Real bank/mobile-money collection and payout integrations require authorized partners, credentials, settlement/reversal handling, and jurisdiction-specific approvals. Production also needs OIDC/MFA, user invitation and recovery flows, tenant RLS, access reviews, a separate migration job/role, TLS/private managed PostgreSQL and Redis, managed secrets, encrypted backups and restore drills, alerting, incident response, and environment-isolated CI/CD. Do not store raw card data.
