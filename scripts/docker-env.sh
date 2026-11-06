#!/bin/sh
# Writes the secrets compose.yaml needs into ./.env, generating any that are
# missing. Values already in .env are kept, so it is safe to re-run.
set -eu
cd "$(dirname "$0")/.."
touch .env

add() {
  if ! grep -q "^$1=" .env; then
    printf '%s=%s\n' "$1" "$2" >> .env
    echo "added $1"
  fi
}

add POSTGRES_PASSWORD "$(openssl rand -hex 24)"
add JWT_SECRET "$(openssl rand -base64 48 | tr -d '\n=+/')"
add EMAIL_CONFIG_ENCRYPTION_KEY "$(openssl rand -hex 32)"
chmod 600 .env
echo ".env is ready. Next: docker compose up -d"
