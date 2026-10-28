#!/bin/bash
# Development services share the persistent Agent Volume and bind only to loopback.
set -euo pipefail

# The Runner token must reach only the Runner. /proc/1/environ, readable by the agent user and
# so by every tool, keeps the environment this process started with: re-exec without the token,
# handing it over on a pipe.
if [[ -n "${CLAUDE_TASK_RUNNER_TOKEN-}" ]]; then
  exec 3< <(printf '%s' "$CLAUDE_TASK_RUNNER_TOKEN")
  exec env -u CLAUDE_TASK_RUNNER_TOKEN "$0" "$@"
fi
runner_token=""
if { true <&3; } 2>/dev/null; then
  IFS= read -r runner_token <&3 || true
  exec 3<&-
fi
export PATH="/usr/lib/postgresql/16/bin:$PATH"
source /etc/profile.d/mise.sh
for plugin in /opt/mise/plugins/*; do
  if [[ -d "$plugin" && ! -e "$HOME/.local/share/mise/plugins/${plugin##*/}" ]]; then
    mise plugins link "${plugin##*/}" "$plugin" || echo "could not link mise plugin ${plugin##*/}" >&2
  fi
done
# MISE_NODE_COREPACK applies to new installs only: Node versions already in the Agent Volume get
# Corepack's pnpm and yarn here.
reshim=false
for bin in "$HOME"/.local/share/mise/installs/node/*/bin; do
  if [[ -x "$bin/corepack" && ! -e "$bin/pnpm" ]]; then
    PATH="$bin:$PATH" corepack enable || echo "could not enable corepack in ${bin%/bin}" >&2
    reshim=true
  fi
done
if $reshim; then mise reshim || true; fi
data="$HOME/.local/share/claude-task"
mkdir -p "$data/run"
chmod 700 "$data/run"

enabled() { [[ " ${CLAUDE_TASK_SERVICES-postgres redis} " == *" $1 "* ]]; }

pids=()
postgres_started=false
redis_started=false
cleanup() {
  trap - EXIT TERM INT
  for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  if $postgres_started; then pg_ctl -D "$data/postgres" -m fast -w stop || true; fi
  if $redis_started; then redis-cli -h 127.0.0.1 shutdown || true; fi
  wait || true
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

ready() {
  local service="$1"
  shift
  for attempt in {1..300}; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    for pid in "${pids[@]}"; do
      if ! kill -0 "$pid" 2>/dev/null; then
        echo "$service exited during startup" >&2
        tail -n 50 "$data/$service.log" >&2 || true
        return 1
      fi
    done
    sleep 0.2
  done
  echo "$service did not become ready" >&2
  tail -n 50 "$data/$service.log" >&2 || true
  return 1
}

if enabled postgres; then
  mkdir -p "$data/postgres"
  if [ ! -s "$data/postgres/PG_VERSION" ]; then
    initdb -D "$data/postgres" --username=agent --auth=trust
  fi
  # Nothing runs before the entrypoint, so a lock is left by a killed container; PIDs repeat in a
  # new one, which would fool pg_ctl's wait and postgres' own stale-lock check.
  rm -f "$data/postgres/postmaster.pid" /var/run/postgresql/.s.PGSQL.5432.lock
  # The socket goes in the clients' default directory, so plain `psql` and libpq apps connect too.
  pg_ctl -D "$data/postgres" -l "$data/postgres.log" -o "-h 127.0.0.1 -k /var/run/postgresql" -w start
  postgres_started=true
  if ! psql -h 127.0.0.1 -U agent -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'agent'" | grep -qx 1; then
    createdb -h 127.0.0.1 -U agent agent
  fi
fi

if enabled redis; then
  mkdir -p "$data/redis"
  redis-server --bind 127.0.0.1 --protected-mode yes --daemonize yes --dir "$data/redis" --appendonly yes --pidfile "$data/run/redis.pid" --logfile "$data/redis.log"
  redis_started=true
  ready redis redis-cli -h 127.0.0.1 ping
fi

if enabled mysql; then
  mkdir -p "$data/mysql" "$data/mysql-files"
  if [ ! -d "$data/mysql/mysql" ]; then
    mysqld --no-defaults --initialize-insecure --datadir="$data/mysql" --log-error="$data/mysql.log"
  fi
  rm -f /var/run/mysqld/mysqld.sock.lock
  mysqld --no-defaults --datadir="$data/mysql" --bind-address=127.0.0.1 --port=3306 \
    --socket=/var/run/mysqld/mysqld.sock --pid-file="$data/run/mysql.pid" --mysqlx=0 --secure-file-priv="$data/mysql-files" \
    --log-error="$data/mysql.log" &
  pids+=("$!")
  ready mysql mysql --no-defaults -u root -e 'SELECT 1'
  mysql --no-defaults -u root <<'SQL'
CREATE DATABASE IF NOT EXISTS agent;
CREATE USER IF NOT EXISTS 'agent'@'localhost' IDENTIFIED BY '';
CREATE USER IF NOT EXISTS 'agent'@'127.0.0.1' IDENTIFIED BY '';
GRANT ALL PRIVILEGES ON *.* TO 'agent'@'localhost' WITH GRANT OPTION;
GRANT ALL PRIVILEGES ON *.* TO 'agent'@'127.0.0.1' WITH GRANT OPTION;
SQL
fi

if enabled mailpit; then
  mkdir -p "$data/mailpit"
  mailpit --database "$data/mailpit/messages.db" --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025 \
    --disable-version-check >"$data/mailpit.log" 2>&1 &
  pids+=("$!")
  ready mailpit curl -fsS http://127.0.0.1:8025/readyz
fi

if enabled rustfs; then
  mkdir -p "$data/rustfs" "$data/rustfs-logs"
  RUSTFS_ACCESS_KEY=rustfsadmin RUSTFS_SECRET_KEY=rustfsadmin \
    RUSTFS_ADDRESS=127.0.0.1:9000 RUSTFS_CONSOLE_ADDRESS=127.0.0.1:9001 RUSTFS_CONSOLE_ENABLE=true \
    RUSTFS_OBS_LOG_DIRECTORY="$data/rustfs-logs" \
    rustfs "$data/rustfs" >"$data/rustfs.log" 2>&1 &
  pids+=("$!")
  ready rustfs curl -fsS http://127.0.0.1:9000/health/ready
fi

if enabled chrome; then
  # Nothing to start: the Playwright MCP server launches it on demand. Unconfigured, it would look for
  # Google Chrome, which has no Linux arm64 build, and run it headed, which needs a display. The
  # sandbox needs user namespaces, which Docker's default seccomp profile denies.
  export PLAYWRIGHT_MCP_BROWSER=chromium PLAYWRIGHT_MCP_EXECUTABLE_PATH=/usr/local/bin/chromium \
    PLAYWRIGHT_MCP_HEADLESS=true PLAYWRIGHT_MCP_SANDBOX=false
fi

CLAUDE_TASK_RUNNER_TOKEN="$runner_token" /usr/local/bin/claude-task-runner "$@" &
pids+=("$!")
unset runner_token
wait "${pids[-1]}"
