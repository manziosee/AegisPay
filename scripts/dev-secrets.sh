#!/usr/bin/env sh
set -eu

if [ -e .env ]; then
  echo '.env already exists; refusing to overwrite it.' >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo 'openssl is required to generate local secrets.' >&2
  exit 1
fi

admin_secret=$(openssl rand -hex 32)
app_secret=$(openssl rand -hex 32)
redis_secret=$(openssl rand -hex 32)
api_secret=$(openssl rand -hex 32)
encryption_key=$(openssl rand -hex 32)
proxy_secret=$(openssl rand -hex 32)
cat > .env <<EOF_ENV
POSTGRES_DB=aegispay
POSTGRES_USER=aegispay_admin
POSTGRES_PASSWORD=$admin_secret
APP_DB_USER=aegispay_app
APP_DB_PASSWORD=$app_secret
REDIS_PASSWORD=$redis_secret
API_PORT=18080
AEGIS_API_KEY=aegis_test_$api_secret
ENCRYPTION_KEYS=k1:$encryption_key
TRUSTED_PROXY_SECRET=$proxy_secret
AEGIS_ORGANIZATION_ID=org_sandbox
EOF_ENV
chmod 600 .env
echo 'Created .env with unique local credentials (mode 600).'
