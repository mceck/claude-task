# The Base Image every Agent's Dockerfile builds on (claude-task/agent-base). Built by the backend
# through the Docker socket with `runner/` and these scripts as context; see src/agents/docker-runtime.ts.
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
ARG NODE_VERSION=26
ARG PYTHON_VERSION=3.14
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl fd-find ffmpeg git imagemagick jq less libvips-tools \
      openssh-client poppler-utils procps ripgrep sqlite3 vim \
 && rm -rf /var/lib/apt/lists/*
COPY --from=runner /out/claude-task-runner /usr/local/bin/claude-task-runner
COPY --from=runner /out/git-credential-claude-task /usr/local/bin/git-credential-claude-task
# The Git Proxy host is runtime configuration, so the helper serves every host and denies
# anything but the current Job's clone URL.
RUN git config --system credential.helper /usr/local/bin/git-credential-claude-task \
 && git config --system credential.useHttpPath true
# bypassPermissions refuses to run as root, hence a fixed non-root user.
RUN if getent passwd 1000 > /dev/null; then \
      usermod --login agent --home /home/agent --move-home --shell /bin/bash --groups '' "$(getent passwd 1000 | cut -d: -f1)"; \
    else \
      useradd --create-home --uid 1000 --shell /bin/bash agent; \
    fi
# The backend includes these scripts in the Base Image context and its version hash.
COPY agent-base/install-services.sh /usr/local/bin/claude-task-install-services
COPY agent-base/entrypoint.sh /usr/local/bin/claude-task-entrypoint
COPY agent-base/minio-shim.sh /usr/local/lib/claude-task/minio
RUN chmod 755 /usr/local/bin/claude-task-install-services /usr/local/bin/claude-task-entrypoint /usr/local/lib/claude-task/minio \
 && printf '%s\n' 'eval "$(mise activate bash --shims)"' > /etc/profile.d/mise.sh
# Every Node mise installs gets Corepack's pnpm and yarn, at the version a package.json's
# packageManager names, downloaded without the prompt that would stall a Job.
ENV DISABLE_AUTOUPDATER=1 \
    MISE_NODE_COREPACK=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CLAUDE_TASK_SERVICES="" \
    PATH=/usr/lib/postgresql/16/bin:$PATH
COPY --from=ghcr.io/jdx/mise:latest /usr/local/bin/mise /usr/local/bin/mise
# Login shells load mise's activation script for this build and inherited Agent Dockerfiles.
SHELL ["/bin/bash", "-lc"]
# Base tools live outside /home/agent so mounting an Agent Volume keeps them visible and
# rebuilding the image updates them. Mise manages the shims and lets repository configs
# override every default, including Claude Code.
RUN mkdir -p /etc/mise \
 && printf '[tools]\nclaude = "%s"\nnode = "%s"\npython = "%s"\n' \
      "${CLAUDE_CODE_VERSION}" "${NODE_VERSION}" "${PYTHON_VERSION}" > /etc/mise/config.toml \
 && mise install --system --yes \
 && mise reshim --system
RUN claude --version \
 && node --version \
 && npm --version \
 && python --version
# Plugins live outside /home/agent for the same reason as Claude Code; the entrypoint links them
# into the Agent Volume's mise data.
RUN mise --version \
 && MISE_DATA_DIR=/opt/mise mise plugins add flutter \
 && chown -R agent: /opt/mise /usr/local/share/mise
USER agent
WORKDIR /home/agent
ENTRYPOINT ["/usr/local/bin/claude-task-entrypoint"]
