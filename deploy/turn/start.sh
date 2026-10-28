#!/bin/sh
set -eu

: "${VOICE_TURN_HOST:?Set VOICE_TURN_HOST to the public TURN hostname; it has no default}"
: "${VOICE_TURN_SECRET:?Set VOICE_TURN_SECRET to the same value as the backend}"
: "${VOICE_TURN_EXTERNAL_IP:?Set VOICE_TURN_EXTERNAL_IP to the relay public IPv4 address}"
case "$VOICE_TURN_HOST" in
  *[!a-zA-Z0-9.-]*|.*|*..*|*.) echo 'VOICE_TURN_HOST must be a hostname without protocol, port or path' >&2; exit 1 ;;
esac
case "$VOICE_TURN_SECRET" in
  *[!a-zA-Z0-9_+/=-]*) echo 'VOICE_TURN_SECRET must contain only base64 or hexadecimal characters' >&2; exit 1 ;;
esac
if [ "${#VOICE_TURN_SECRET}" -lt 32 ]; then
  echo 'VOICE_TURN_SECRET must contain at least 32 characters' >&2; exit 1
fi
case "$VOICE_TURN_EXTERNAL_IP" in
  *[!0-9.]*) echo 'VOICE_TURN_EXTERNAL_IP must be an IPv4 address' >&2; exit 1 ;;
esac
if ! printf '%s\n' "$VOICE_TURN_EXTERNAL_IP" | awk -F. 'NF != 4 {exit 1} {for (i=1; i<=4; i++) if ($i == "" || $i > 255) exit 1}'; then
  echo 'VOICE_TURN_EXTERNAL_IP must be an IPv4 address' >&2; exit 1
fi

umask 077
config=$(mktemp /tmp/claude-task-turn.XXXXXX)
cat /etc/coturn/base.conf > "$config"
# One relay network: map its concrete container address to the public address.
relay_ip=$(hostname -i | tr ' ' '\n' | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && $0 !~ /^127\./ {print; exit}')
if [ -z "$relay_ip" ]; then
  echo 'Could not determine the container IPv4 relay address' >&2; exit 1
fi
printf '\nrealm=%s\nstatic-auth-secret=%s\nrelay-ip=%s\nexternal-ip=%s/%s\n' "$VOICE_TURN_HOST" "$VOICE_TURN_SECRET" "$relay_ip" "$VOICE_TURN_EXTERNAL_IP" "$relay_ip" >> "$config"
if [ -n "${VOICE_TURN_TLS_PORT:-}" ]; then
  case "$VOICE_TURN_TLS_PORT" in
    *[!0-9]*) echo 'VOICE_TURN_TLS_PORT must be a valid public TCP port' >&2; exit 1 ;;
  esac
  if [ "$VOICE_TURN_TLS_PORT" -lt 1 ] || [ "$VOICE_TURN_TLS_PORT" -gt 65535 ]; then
    echo 'VOICE_TURN_TLS_PORT must be between 1 and 65535' >&2; exit 1
  fi
  if [ ! -r /certs/fullchain.pem ] || [ ! -r /certs/privkey.pem ]; then
    echo 'TURN TLS requires readable /certs/fullchain.pem and /certs/privkey.pem' >&2; exit 1
  fi
  printf 'tls-listening-port=5349\ncert=/certs/fullchain.pem\npkey=/certs/privkey.pem\n' >> "$config"
else
  printf 'no-tls\n' >> "$config"
fi
exec turnserver -c "$config"
