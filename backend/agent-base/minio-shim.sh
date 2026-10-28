#!/usr/bin/env bash
# `minio`, backed by RustFS: runs `minio server` command lines, MinIO environment variables and
# MinIO certificate directories on `rustfs server`, so projects that start MinIO work unchanged.
# Installed as /usr/local/bin/minio when an Agent selects RustFS (see install-services.sh).
# Works with bash 3.2 (macOS) too.
set -euo pipefail

RUSTFS_BIN="${RUSTFS_BIN:-rustfs}"
quiet=0

die() { echo "minio: $*" >&2; exit 1; }
warn() { ((quiet)) || echo "minio: $*" >&2; }

usage() {
  cat <<'EOF'
minio: MinIO-compatible front for RustFS.

Usage: minio [--certs-dir DIR] [--quiet] server [FLAGS] DIR1 [DIR2...]
       minio --version | --help

Translated MinIO flags:
  --address ADDR            S3 API address (default :9000)
  --console-address ADDR    console address (default: first free port after the API's)
  --certs-dir, -S DIR       public.crt/private.key (and <domain>/ subdirectories), served
                            through RustFS's --tls-path (default ~/.minio/certs when present)
  --quiet                   no messages from this shim
MinIO flags without a RustFS equivalent (--config, --config-dir, --ftp, --sftp, --json, ...)
are ignored with a warning. RustFS's own flags pass through (rustfs server --help); give
unknown flags as --flag=value. Missing local storage directories are created, like MinIO does.

Translated MinIO environment (it wins over the RUSTFS_* equivalent):
  MINIO_ROOT_USER[_FILE], MINIO_ACCESS_KEY      -> RUSTFS_ACCESS_KEY[_FILE]
  MINIO_ROOT_PASSWORD[_FILE], MINIO_SECRET_KEY  -> RUSTFS_SECRET_KEY[_FILE]
  MINIO_VOLUMES, MINIO_ADDRESS, MINIO_CONSOLE_ADDRESS, MINIO_DOMAIN,
  MINIO_SITE_REGION/MINIO_REGION_NAME/MINIO_REGION, MINIO_BROWSER=off
Credentials default to minioadmin / minioadmin, as in MinIO.

RUSTFS_BIN selects the rustfs binary (default: rustfs on the PATH).
EOF
}

print_version() {
  local v
  v="$("$RUSTFS_BIN" --version 2>/dev/null | head -n 1)" || v="rustfs (not found)"
  echo "minio version RustFS shim ($v)"
}

# Fails unless flag $1 has a value in $2.
need_value() {
  if [[ $# -lt 2 || -z "$2" || "$2" == -* ]]; then die "missing value for $1"; fi
}

# Sets $1 from the first non-empty variable among the rest.
from_env() {
  local target=$1 src
  shift
  for src in "$@"; do
    if [[ -n "${!src:-}" ]]; then export "$target=${!src}"; return 0; fi
  done
  return 1
}

# MinIO reads *_FILE secrets relative to /run/secrets first (Docker secrets).
secret_file() {
  if [[ -f "/run/secrets/$1" ]]; then echo "/run/secrets/$1"; else echo "$1"; fi
}

# Prints a volume's local directories, expanding MinIO's {N...M} ellipses (zero padding kept).
expand_volume() {
  local v=$1
  if [[ "$v" =~ ^(.*)\{([0-9]+)\.\.\.([0-9]+)\}(.*)$ ]]; then
    local pre=${BASH_REMATCH[1]} from=${BASH_REMATCH[2]} to=${BASH_REMATCH[3]} post=${BASH_REMATCH[4]} i
    for ((i = 10#$from; i <= 10#$to; i++)); do
      expand_volume "$pre$(printf "%0${#from}d" "$i")$post"
    done
  else
    echo "$v"
  fi
}

# True when something listens on host:port.
port_busy() {
  (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null
}

# A MinIO --certs-dir as a RustFS --tls-path: RustFS wants rustfs_cert.pem / rustfs_key.pem,
# so MinIO's public.crt / private.key are linked under those names in a private directory, one
# per certificate directory, rebuilt on every start.
tls_path_for() {
  local dir sub name out
  dir="$(cd "$1" && pwd)"
  if [[ -f "$dir/rustfs_cert.pem" ]]; then echo "$dir"; return; fi
  out="${TMPDIR:-/tmp}"
  out="${out%/}/minio-certs-$(id -u)-$(printf '%s' "$dir" | cksum | cut -d ' ' -f 1)"
  rm -rf "$out"
  (umask 077 && mkdir "$out")
  for sub in "$dir" "$dir"/*/; do
    sub=${sub%/}
    [[ -f "$sub/public.crt" && -f "$sub/private.key" ]] || continue
    name=${sub#"$dir"}
    mkdir -p "$out$name"
    ln -s "$sub/public.crt" "$out$name/rustfs_cert.pem"
    ln -s "$sub/private.key" "$out$name/rustfs_key.pem"
  done
  if [[ -d "$dir/CAs" ]] && [[ -n "$(ls -A "$dir/CAs")" ]]; then warn "ignoring $dir/CAs (not translated for RustFS)"; fi
  if [[ -z "$(ls -A "$out")" ]]; then rmdir "$out"; return 1; fi
  echo "$out"
}

certs_dir=""
args=()
volumes=()
rustfs_flags=" "
address=""
console_address=""

# MinIO accepts single-dash long flags (-address); RustFS doesn't.
normalize() {
  if [[ "$1" =~ ^-[a-z][a-z-]+(=.*)?$ ]]; then echo "-$1"; else echo "$1"; fi
}

# Global flags, then the command.
command=""
while (($#)); do
  arg="$(normalize "$1")"
  case "$arg" in
    -h|--help|help) usage; exit 0 ;;
    -v|--version|version) print_version; exit 0 ;;
    --certs-dir|-S) need_value "$@"; certs_dir=$2; shift 2 ;;
    --certs-dir=*|-S=*) certs_dir=${arg#*=}; shift ;;
    --quiet) quiet=1; shift ;;
    --anonymous|--json|--no-compat) shift ;;
    server) command=server; shift; break ;;
    -*) die "unknown flag: $1 (see minio --help)" ;;
    *) die "'$1' is not supported: this minio only runs 'server', on RustFS" ;;
  esac
done
[[ -n "$command" ]] || { usage >&2; exit 1; }

while (($#)); do
  arg="$(normalize "$1")"
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --address) need_value "$@"; address=$2; shift 2 ;;
    --address=*) address=${arg#*=}; shift ;;
    --console-address) need_value "$@"; console_address=$2; shift 2 ;;
    --console-address=*) console_address=${arg#*=}; shift ;;
    --certs-dir|-S) need_value "$@"; certs_dir=$2; shift 2 ;;
    --certs-dir=*|-S=*) certs_dir=${arg#*=}; shift ;;
    --quiet) quiet=1; shift ;;
    --anonymous|--json|--no-compat|--sync) shift ;;
    --config-dir|-C|--config|--ftp|--sftp|--listeners|--interface|--dns-cache-ttl|--max-idle-conns-per-host|\
    --memlimit|--idle-timeout|--read-header-timeout|--conn-user-timeout|--shutdown-timeout|--send-buf-size|\
    --recv-buf-size|--crossdomain-xml|--log-dir|--log-size|--ilm-expiry-workers|--ilm-expiry-queue-size)
      need_value "$@"; warn "ignoring $1 $2 (no RustFS equivalent)"; shift 2 ;;
    --config-dir=*|-C=*|--config=*|--ftp=*|--sftp=*|--listeners=*|--interface=*|--dns-cache-ttl=*|\
    --max-idle-conns-per-host=*|--memlimit=*|--idle-timeout=*|--read-header-timeout=*|--conn-user-timeout=*|\
    --shutdown-timeout=*|--send-buf-size=*|--recv-buf-size=*|--crossdomain-xml=*|--log-dir=*|--log-size=*|\
    --ilm-expiry-workers=*|--ilm-expiry-queue-size=*)
      warn "ignoring $1 (no RustFS equivalent)"; shift ;;
    # RustFS's own flags (rustfs 1.0.4) that take a value.
    --server-domains|--access-key|--access-key-file|--secret-key|--secret-key-file|--obs-endpoint|--tls-path|\
    --license|--region|--kms-backend|--kms-key-dir|--kms-local-master-key|--kms-vault-address|--kms-vault-token|\
    --kms-vault-mount-path|--kms-default-key-id|--buffer-profile)
      need_value "$@"; args+=("$arg" "$2"); rustfs_flags+="$arg "; shift 2 ;;
    --) shift; volumes+=("$@"); break ;;
    -*) args+=("$arg"); rustfs_flags+="${arg%%=*} "; shift ;;
    *) volumes+=("$1"); shift ;;
  esac
done

has_flag() { [[ "$rustfs_flags" == *" $1 "* ]]; }

# Credentials: MinIO's variables win; files first, as in MinIO.
if [[ -n "${MINIO_ROOT_USER_FILE:-}" ]]; then
  export RUSTFS_ACCESS_KEY_FILE="$(secret_file "$MINIO_ROOT_USER_FILE")"; unset RUSTFS_ACCESS_KEY
elif from_env RUSTFS_ACCESS_KEY MINIO_ROOT_USER MINIO_ACCESS_KEY; then
  unset RUSTFS_ACCESS_KEY_FILE
fi
if [[ -n "${MINIO_ROOT_PASSWORD_FILE:-}" ]]; then
  export RUSTFS_SECRET_KEY_FILE="$(secret_file "$MINIO_ROOT_PASSWORD_FILE")"; unset RUSTFS_SECRET_KEY
elif from_env RUSTFS_SECRET_KEY MINIO_ROOT_PASSWORD MINIO_SECRET_KEY; then
  unset RUSTFS_SECRET_KEY_FILE
fi
if [[ -z "${RUSTFS_ACCESS_KEY:-}${RUSTFS_ACCESS_KEY_FILE:-}" ]] && ! has_flag --access-key && ! has_flag --access-key-file; then
  export RUSTFS_ACCESS_KEY=minioadmin
fi
if [[ -z "${RUSTFS_SECRET_KEY:-}${RUSTFS_SECRET_KEY_FILE:-}" ]] && ! has_flag --secret-key && ! has_flag --secret-key-file; then
  export RUSTFS_SECRET_KEY=minioadmin
fi

from_env RUSTFS_VOLUMES MINIO_VOLUMES || true
from_env RUSTFS_ADDRESS MINIO_ADDRESS || true
from_env RUSTFS_CONSOLE_ADDRESS MINIO_CONSOLE_ADDRESS || true
from_env RUSTFS_SERVER_DOMAINS MINIO_DOMAIN || true
from_env RUSTFS_REGION MINIO_SITE_REGION MINIO_REGION_NAME MINIO_REGION || true
case "$(printf '%s' "${MINIO_BROWSER:-}" | tr '[:upper:]' '[:lower:]')" in
  off|false|0|no) export RUSTFS_CONSOLE_ENABLE=false ;;
  *) export RUSTFS_CONSOLE_ENABLE="${RUSTFS_CONSOLE_ENABLE:-true}" ;;
esac

# Storage: MinIO creates missing local directories, RustFS refuses to start without them.
if ((${#volumes[@]} == 0)); then
  [[ -n "${RUSTFS_VOLUMES:-}" ]] || die "no storage directory given (minio server DIR1 [DIR2...])"
  read -r -a declared <<<"$RUSTFS_VOLUMES"
else
  declared=("${volumes[@]}")
fi
local_dirs=0
for volume in "${declared[@]}"; do
  [[ "$volume" == *://* ]] && continue
  while IFS= read -r dir; do
    mkdir -p "$dir" || die "cannot create storage directory $dir"
    local_dirs=$((local_dirs + 1))
  done < <(expand_volume "$volume")
done
# MinIO serves several directories of one disk; RustFS only does with this escape hatch.
if ((local_dirs > 1)); then export RUSTFS_UNSAFE_BYPASS_DISK_CHECK="${RUSTFS_UNSAFE_BYPASS_DISK_CHECK:-true}"; fi

# TLS from a MinIO certificate directory, explicit or the default one.
if ! has_flag --tls-path && [[ -z "${RUSTFS_TLS_PATH:-}" ]]; then
  if [[ -z "$certs_dir" && -f "${HOME:-}/.minio/certs/public.crt" ]]; then certs_dir="$HOME/.minio/certs"; fi
  if [[ -n "$certs_dir" ]]; then
    [[ -d "$certs_dir" ]] || die "certificate directory not found: $certs_dir"
    if tls="$(tls_path_for "$certs_dir")"; then args+=(--tls-path "$tls"); else warn "no certificates in $certs_dir, serving plain HTTP"; fi
  fi
fi

# Addresses. MinIO picks a random console port when none is given; a free one next to the
# API's keeps the console reachable when another server already holds RustFS's :9001.
address="${address:-${RUSTFS_ADDRESS:-:9000}}"
[[ "$address" == *:* ]] || die "invalid --address $address (expected [HOST]:PORT)"
args+=(--address "$address")
if [[ -z "$console_address" && -z "${RUSTFS_CONSOLE_ADDRESS:-}" && "$RUSTFS_CONSOLE_ENABLE" != false ]]; then
  host=${address%:*}
  port=${address##*:}
  probe=${host#[}; probe=${probe%]}
  case "$probe" in ''|0.0.0.0|::) probe=127.0.0.1 ;; esac
  if [[ "$port" =~ ^[0-9]+$ ]]; then
    for ((candidate = port + 1; candidate <= port + 100 && candidate <= 65535; candidate++)); do
      if ! port_busy "$probe" "$candidate"; then console_address="$host:$candidate"; break; fi
    done
  fi
fi
if [[ -n "$console_address" ]]; then args+=(--console-address "$console_address"); fi

command -v "$RUSTFS_BIN" >/dev/null 2>&1 || die "rustfs not found (set RUSTFS_BIN)"
if [[ "$RUSTFS_CONSOLE_ENABLE" == false ]]; then
  warn "starting RustFS: API $address, console off"
else
  warn "starting RustFS: API $address, console ${console_address:-${RUSTFS_CONSOLE_ADDRESS:-:9001}}"
fi
exec "$RUSTFS_BIN" server ${args[@]+"${args[@]}"} ${volumes[@]+"${volumes[@]}"}
