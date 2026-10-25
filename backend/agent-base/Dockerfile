# The Base Image every Agent's Dockerfile builds on (claude-task/agent-base). Built by the backend
# through the Docker socket with the repo's `runner/` as context; see src/agents/docker-runtime.ts.
FROM golang:1.26-bookworm AS runner
WORKDIR /src
COPY runner/go.mod runner/go.sum ./
RUN go mod download
COPY runner/ ./
ARG RUNNER_VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${RUNNER_VERSION}" -o /out/claude-task-runner ./cmd/runner \
 && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/git-credential-claude-task ./cmd/git-credential-claude-task

FROM buildpack-deps:noble
ARG CLAUDE_CODE_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git less openssh-client procps postgresql-16 postgresql-client-16 redis-server \
 && rm -rf /var/lib/apt/lists/*
# Claude Code lives outside /home/agent: the Agent Volume is mounted there and would hide
# (or freeze) anything installed in it.
RUN curl -fsSL https://claude.ai/install.sh -o /tmp/install.sh \
 && HOME=/opt/claude bash /tmp/install.sh "${CLAUDE_CODE_VERSION}" \
 && ln -s "$(readlink -f /opt/claude/.local/bin/claude)" /usr/local/bin/claude \
 && rm /tmp/install.sh \
 && claude --version
COPY --from=runner /out/claude-task-runner /usr/local/bin/claude-task-runner
COPY --from=runner /out/git-credential-claude-task /usr/local/bin/git-credential-claude-task
RUN git config --system credential.https://github.com.helper /usr/local/bin/git-credential-claude-task \
 && git config --system credential.https://github.com.useHttpPath true
# bypassPermissions refuses to run as root, hence a fixed non-root user.
RUN if getent passwd 1000 > /dev/null; then \
      usermod --login agent --home /home/agent --move-home --shell /bin/bash --groups '' "$(getent passwd 1000 | cut -d: -f1)"; \
    else \
      useradd --create-home --uid 1000 --shell /bin/bash agent; \
    fi
# Services run as agent, with their data in the persistent Agent Volume. Bind only
# to loopback: these are development services for this agent's repositories.
RUN printf '%s\n' \
    '#!/bin/bash' \
    'set -euo pipefail' \
    'export PATH="/usr/lib/postgresql/16/bin:$PATH"' \
    'data="$HOME/.local/share/claude-task"' \
    'mkdir -p "$data/postgres" "$data/redis" "$data/run"' \
    'chmod 700 "$data/run"' \
    'if [ ! -s "$data/postgres/PG_VERSION" ]; then' \
    '  initdb -D "$data/postgres" --username=agent --auth=trust' \
    'fi' \
    'pg_ctl -D "$data/postgres" -l "$data/postgres.log" -o "-h 127.0.0.1 -k $data/run" -w start' \
    'if ! psql -h 127.0.0.1 -U agent -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '\''agent'\''" | grep -qx 1; then' \
    '  createdb -h 127.0.0.1 -U agent agent' \
    'fi' \
    'redis-server --bind 127.0.0.1 --protected-mode yes --daemonize yes --dir "$data/redis" --appendonly yes --pidfile "$data/run/redis.pid" --logfile "$data/redis.log"' \
    'for attempt in {1..50}; do' \
    '  if redis-cli -h 127.0.0.1 ping; then break; fi' \
    '  sleep 0.1' \
    'done' \
    'redis-cli -h 127.0.0.1 ping' \
    'exec /usr/local/bin/claude-task-runner "$@"' \
    > /usr/local/bin/claude-task-entrypoint \
 && chmod 755 /usr/local/bin/claude-task-entrypoint \
 && printf '%s\n' 'export PATH="/home/agent/.local/share/mise/shims:$PATH"' > /etc/profile.d/mise.sh
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_TASK_CLAUDE_PATH=/usr/local/bin/claude \
    PATH=/home/agent/.local/share/mise/shims:/usr/lib/postgresql/16/bin:$PATH
USER agent
WORKDIR /home/agent
COPY --from=ghcr.io/jdx/mise:latest /usr/local/bin/mise /usr/local/bin/mise
RUN mise --version
ENTRYPOINT ["/usr/local/bin/claude-task-entrypoint"]
