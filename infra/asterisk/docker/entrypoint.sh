#!/bin/sh
# Render Asterisk config from /config into /etc/asterisk, install TLS certs,
# then run Asterisk in the foreground.
#
#   /config/*.conf       copied as-is
#   /config/*.conf.tmpl  rendered with envsubst (ONLY the variables listed in
#                        SUBST_VARS are replaced, so dialplan ${EXTEN} etc. survive)
#   /certs/server.crt, /certs/server.key  -> /etc/asterisk/keys/ (0600, asterisk)
set -eu

SUBST_VARS='${EXTERNAL_IP} ${LOCAL_NET} ${CONTAINER_IP} ${RTP_START} ${RTP_END}
${DEV_SIP_PASSWORD}
${GW_BROWSER_USER} ${GW_BROWSER_PASSWORD}
${UPSTREAM_HOST} ${UPSTREAM_PORT} ${UPSTREAM_DOMAIN} ${UPSTREAM_USER} ${UPSTREAM_PASSWORD} ${UPSTREAM_CODECS}'

if [ ! -d /config ]; then
  echo "entrypoint: /config is not mounted" >&2
  exit 1
fi

for f in /config/*; do
  name=$(basename "$f")
  case "$name" in
    *.tmpl)
      envsubst "$SUBST_VARS" < "$f" > "/etc/asterisk/${name%.tmpl}"
      ;;
    *.conf)
      cp "$f" "/etc/asterisk/$name"
      ;;
  esac
done

mkdir -p /etc/asterisk/keys /var/run/asterisk /var/log/asterisk /var/spool/asterisk /var/lib/asterisk
if [ -f /certs/server.crt ] && [ -f /certs/server.key ]; then
  install -o asterisk -g asterisk -m 0644 /certs/server.crt /etc/asterisk/keys/server.crt
  install -o asterisk -g asterisk -m 0600 /certs/server.key /etc/asterisk/keys/server.key
else
  echo "entrypoint: /certs/server.crt or /certs/server.key missing." >&2
  echo "entrypoint: run infra/asterisk/scripts/gen-certs.sh first (WSS will not work without them)." >&2
  exit 1
fi

chown -R asterisk:asterisk /etc/asterisk /var/run/asterisk /var/log/asterisk /var/spool/asterisk /var/lib/asterisk

# -f foreground, -T timestamps, -U/-G drop privileges, -vvv verbose to stdout
exec /usr/sbin/asterisk -f -T -vvv -U asterisk -G asterisk
