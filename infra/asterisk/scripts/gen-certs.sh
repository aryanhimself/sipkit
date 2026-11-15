#!/usr/bin/env bash
# Generate a local development CA and a server certificate for Asterisk WSS.
#
#   ./gen-certs.sh                 # SANs: localhost, 127.0.0.1, ::1, asterisk, asterisk-gateway
#   ./gen-certs.sh pbx.lan 192.168.1.50   # add extra DNS names / IPs
#
# Output (infra/asterisk/certs/, git-ignored):
#   ca.crt / ca.key        dev CA  -> import ca.crt into your OS/browser trust store
#   server.crt / server.key  used by Asterisk (http.conf tlscertfile/tlsprivatekey)
#
# DEV ONLY. Never use these certs in production (use a real CA, e.g. Let's Encrypt).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${CERT_DIR:-$HERE/../certs}"
DAYS="${CERT_DAYS:-825}"
mkdir -p "$OUT"
cd "$OUT"

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required" >&2
  exit 1
fi

# Build the SAN list
san="DNS:localhost,DNS:asterisk,DNS:asterisk-gateway,IP:127.0.0.1,IP:::1"
for extra in "$@"; do
  if [[ "$extra" =~ ^[0-9.]+$ || "$extra" == *:* ]]; then
    san="$san,IP:$extra"
  else
    san="$san,DNS:$extra"
  fi
done

if [[ ! -f ca.key || ! -f ca.crt ]]; then
  echo "==> creating dev CA"
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days "$DAYS" \
    -keyout ca.key -out ca.crt \
    -subj "/CN=sipkit Dev CA/O=sipkit (development only)" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
else
  echo "==> reusing existing dev CA (delete ca.* to regenerate)"
fi

echo "==> creating server certificate for: $san"
cat > server.ext <<EOF
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$san
EOF

openssl req -newkey rsa:2048 -nodes -sha256 \
  -keyout server.key -out server.csr \
  -subj "/CN=localhost/O=sipkit dev PBX"
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days "$DAYS" -sha256 -extfile server.ext
rm -f server.csr server.ext

# The entrypoint copies the key into the container with 0600 / asterisk owner.
chmod 0644 server.crt ca.crt
chmod 0600 server.key ca.key

echo
echo "Done. Files in: $OUT"
echo "Next: trust ca.crt (see infra/asterisk/README.md, 'Trusting the certificate')."
