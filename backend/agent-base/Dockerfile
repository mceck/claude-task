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

FROM debian:bookworm-slim
ARG CLAUDE_CODE_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git less openssh-client procps \
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
RUN useradd --create-home --uid 1000 --shell /bin/bash agent
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_TASK_CLAUDE_PATH=/usr/local/bin/claude
USER agent
WORKDIR /home/agent
ENTRYPOINT ["/usr/local/bin/claude-task-runner"]
