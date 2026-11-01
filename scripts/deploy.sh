#!/usr/bin/env bash
# Interactive deploy for a fresh Amazon Linux EC2 instance: installs Docker, asks for the
# settings Claude Task needs, writes .env and starts docker compose. Run from a clone of the repo.
# State is kept in host directories under $CLAUDE_TASK_HOME (default ~/claude-task), no Docker volumes.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

ask() { # ask VAR "prompt" "default"
  local var=$1 prompt=$2 def=${3-} reply
  if [[ -n $def ]]; then read -r -p "$prompt [$def]: " reply; else read -r -p "$prompt: " reply; fi
  printf -v "$var" '%s' "${reply:-$def}"
}

ask_secret() { # ask_secret VAR "prompt" "default shown as generated"
  local var=$1 prompt=$2 def=${3-} reply
  read -r -s -p "$prompt${def:+ [leave empty to use the generated value]}: " reply; echo
  printf -v "$var" '%s' "${reply:-$def}"
}

yesno() { # yesno "prompt" y|n  -> 0 when yes
  local reply def=$2
  read -r -p "$1 [$([[ $def == y ]] && echo Y/n || echo y/N)]: " reply
  reply=${reply:-$def}
  [[ $reply =~ ^[Yy] ]]
}

gen() { openssl rand -hex "$1"; }

# --- Docker ---------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  sudo dnf install -y docker git openssl
  sudo systemctl enable --now docker
fi
sudo systemctl enable --now docker >/dev/null 2>&1 || true
sudo usermod -aG docker "$USER" || true

if ! docker compose version >/dev/null 2>&1 && ! sudo docker compose version >/dev/null 2>&1; then
  say "Installing the Docker Compose and Buildx plugins"
  case "$(uname -m)" in aarch64) arch=aarch64; barch=arm64 ;; *) arch=x86_64; barch=amd64 ;; esac
  sudo mkdir -p /usr/local/lib/docker/cli-plugins
  sudo curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$arch" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  bx=$(curl -fsSL https://api.github.com/repos/docker/buildx/releases/latest | grep -o '"tag_name": *"[^"]*"' | cut -d'"' -f4)
  sudo curl -fsSL "https://github.com/docker/buildx/releases/download/$bx/buildx-$bx.linux-$barch" \
    -o /usr/local/lib/docker/cli-plugins/docker-buildx
  sudo chmod +x /usr/local/lib/docker/cli-plugins/*
fi

# The new docker group is not active in this shell yet, so fall back to sudo.
if docker info >/dev/null 2>&1; then DOCKER=(docker); else DOCKER=(sudo -E docker); fi

# --- Settings -------------------------------------------------------------
if [[ -f .env ]]; then
  yesno ".env already exists. Overwrite it (a backup is kept)?" n || { echo "Keeping .env, starting the stack."; SKIP_ASK=1; }
  [[ -z ${SKIP_ASK-} ]] && cp .env ".env.bak.$(date +%s)"
fi

if [[ -z ${SKIP_ASK-} ]]; then
  say "Claude Task settings"
  token=$(curl -fsS -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)
  PUBLIC_IP=$(curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)

  ask CLAUDE_TASK_HOME "Directory for persistent data" "$HOME/claude-task"
  ask APP_URL "Public URL of the app" "http://${PUBLIC_IP:-localhost}:3000"
  ask ADMIN_EMAIL "Admin email" "admin@example.com"
  GEN_PW=$(gen 8)
  ask_secret ADMIN_PASSWORD "Admin password" "$GEN_PW"
  SECRETS_MASTER_KEY=$(gen 32)
  COOKIE_SECURE=false
  [[ $APP_URL == https://* ]] && COOKIE_SECURE=true

  say "Database"
  DATABASE_URL="" COMPOSE_PROFILES=""
  if yesno "Include Postgres in the compose (otherwise use an external one)?" y; then
    COMPOSE_PROFILES="db"
  else
    ask DATABASE_URL "External DATABASE_URL (postgres://user:pass@host:5432/db)"
    [[ -n $DATABASE_URL ]] || { echo "DATABASE_URL is required"; exit 1; }
  fi

  say "Attachment storage"
  STORAGE_TYPE=disk S3_BUCKET="" S3_REGION="" S3_ENDPOINT="" S3_ACCESS_KEY_ID="" S3_SECRET_ACCESS_KEY="" S3_FORCE_PATH_STYLE="" S3_PREFIX=""
  if yesno "Use S3 for attachments?" n; then
    STORAGE_TYPE=s3
    ask S3_BUCKET "S3 bucket"
    ask S3_REGION "S3 region" "us-east-1"
    ask S3_ENDPOINT "S3 endpoint (empty for AWS)"
    ask S3_ACCESS_KEY_ID "Access key id (empty to use the instance role)"
    [[ -n $S3_ACCESS_KEY_ID ]] && ask_secret S3_SECRET_ACCESS_KEY "Secret access key"
    ask S3_PREFIX "Key prefix (optional)"
    ask S3_FORCE_PATH_STYLE "Force path style (true/false, empty for default)"
  fi

  say "Voice relay (TURN)"
  VOICE_TURN_HOST="" VOICE_TURN_SECRET="" VOICE_TURN_EXTERNAL_IP="" VOICE_TURN_PORT=3478
  if yesno "Include the TURN server?" n; then
    COMPOSE_PROFILES="${COMPOSE_PROFILES:+$COMPOSE_PROFILES,}turn"
    ask VOICE_TURN_EXTERNAL_IP "TURN public IP" "$PUBLIC_IP"
    ask VOICE_TURN_HOST "TURN host name clients connect to" "$VOICE_TURN_EXTERNAL_IP"
    VOICE_TURN_SECRET=$(gen 24)
    echo "Open in the security group: UDP+TCP $VOICE_TURN_PORT and UDP 30000-30199."
  fi

  say "Git providers (optional, leave empty to skip)"
  ask GITHUB_APP_ID "GitHub App id"
  GITHUB_APP_PRIVATE_KEY=""
  if [[ -n $GITHUB_APP_ID ]]; then
    ask pem "Path to the GitHub App private key .pem"
    [[ -f $pem ]] && GITHUB_APP_PRIVATE_KEY=$(<"$pem")
  fi
  ask GITLAB_URL "GitLab URL" "https://gitlab.com"
  ask_secret GITLAB_TOKEN "GitLab token (optional)"

  mkdir -p "$CLAUDE_TASK_HOME/data" "$CLAUDE_TASK_HOME/postgres"
  umask 077
  {
    q() { printf "%s='%s'\n" "$1" "${!1//\'/\'\\\'\'}"; }
    for v in CLAUDE_TASK_HOME APP_URL ADMIN_EMAIL ADMIN_PASSWORD SECRETS_MASTER_KEY COOKIE_SECURE \
      COMPOSE_PROFILES DATABASE_URL STORAGE_TYPE S3_BUCKET S3_REGION S3_ENDPOINT S3_ACCESS_KEY_ID \
      S3_SECRET_ACCESS_KEY S3_FORCE_PATH_STYLE S3_PREFIX VOICE_TURN_HOST VOICE_TURN_SECRET \
      VOICE_TURN_EXTERNAL_IP VOICE_TURN_PORT GITLAB_URL GITLAB_TOKEN; do q "$v"; done
    # Multi-line PEM: compose .env supports quoted newlines.
    printf "GITHUB_APP_ID='%s'\n" "$GITHUB_APP_ID"
    printf 'GITHUB_APP_PRIVATE_KEY="%s"\n' "${GITHUB_APP_PRIVATE_KEY//$'\n'/\\n}"
  } > .env
  chmod 600 .env
  echo "Admin password: $ADMIN_PASSWORD (also in $REPO_DIR/.env)"
fi

# --- Run ------------------------------------------------------------------
# Read only what the script needs; compose reads .env itself (sourcing it would override its parsing).
env_get() { sed -n "s/^$1='\(.*\)'\$/\1/p" .env | head -n1; }
CLAUDE_TASK_HOME=$(env_get CLAUDE_TASK_HOME); CLAUDE_TASK_HOME=${CLAUDE_TASK_HOME:-$HOME/claude-task}
APP_URL=$(env_get APP_URL)
mkdir -p "$CLAUDE_TASK_HOME/data" "$CLAUDE_TASK_HOME/postgres"
# The app runs as uid 1000 (node) and Postgres as uid 999: bind mounts need matching owners.
sudo chown -R 1000:1000 "$CLAUDE_TASK_HOME/data"
sudo chown -R 999:999 "$CLAUDE_TASK_HOME/postgres"
export DOCKER_GID=$(getent group docker | cut -d: -f3)

say "Building and starting Claude Task"
"${DOCKER[@]}" compose up -d --build
say "Done. Open ${APP_URL:-the app URL}"
