#!/bin/bash
# copy-certs.sh — Copies Caddy-provisioned TLS certs for coturn
#
# Run this after Caddy has provisioned certs for your TURN domain.
# Set up a cron job to run daily for automatic renewal handling:
#   0 3 * * * /path/to/copy-certs.sh && docker compose restart coturn

set -euo pipefail

TURN_DOMAIN="${TURN_DOMAIN:-turn.yourdomain.com}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CERT_DIR="${SCRIPT_DIR}/certs"

# Caddy cert storage (default path for system-installed Caddy)
CADDY_DATA="/var/lib/caddy/.local/share/caddy"
CADDY_CERT_DIR="${CADDY_DATA}/certificates/acme-v02.api.letsencrypt.org-directory/${TURN_DOMAIN}"

if [ ! -f "${CADDY_CERT_DIR}/${TURN_DOMAIN}.crt" ]; then
    echo "ERROR: Cert not found at ${CADDY_CERT_DIR}/"
    echo "Make sure Caddy has provisioned certs for ${TURN_DOMAIN}"
    echo "Check: sudo ls -la ${CADDY_CERT_DIR}/"
    exit 1
fi

mkdir -p "${CERT_DIR}"

cp "${CADDY_CERT_DIR}/${TURN_DOMAIN}.crt" "${CERT_DIR}/cert.pem"
cp "${CADDY_CERT_DIR}/${TURN_DOMAIN}.key" "${CERT_DIR}/key.pem"

chmod 644 "${CERT_DIR}/cert.pem"
chmod 600 "${CERT_DIR}/key.pem"

echo "✓ Certs copied to ${CERT_DIR}/"
echo "  cert.pem  $(stat -c '%s bytes' "${CERT_DIR}/cert.pem" 2>/dev/null || stat -f '%z bytes' "${CERT_DIR}/cert.pem")"
echo "  key.pem   $(stat -c '%s bytes' "${CERT_DIR}/key.pem" 2>/dev/null || stat -f '%z bytes' "${CERT_DIR}/key.pem")"
