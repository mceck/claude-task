#!/bin/bash
# Runs as root while building an Agent image, before its custom Dockerfile instructions.
set -euo pipefail

packages=()
for service in "$@"; do
  case "$service" in
    postgres) packages+=(postgresql-16 postgresql-client-16) ;;
    redis) packages+=(redis-server) ;;
    mysql) packages+=(mysql-server-core-8.0 mysql-client-8.0) ;;
    mailpit) ;;
    rustfs) packages+=(unzip) ;;
    chrome) ;;
    *) echo "Unknown agent service: $service" >&2; exit 1 ;;
  esac
done

if ((${#packages[@]})); then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${packages[@]}"
  rm -rf /var/lib/apt/lists/*
fi

for service in "$@"; do
  case "$service" in
    # Clients look for the server sockets in their default directories, so the agent user owns them.
    postgres)
      install -d -o agent -g "$(id -g agent)" -m 755 /var/run/postgresql
      ;;
    mysql)
      install -d -o agent -g "$(id -g agent)" -m 755 /var/run/mysqld
      ;;
    mailpit)
      case "$(dpkg --print-architecture)" in
        amd64) arch=amd64 ;;
        arm64) arch=arm64 ;;
        *) echo 'Mailpit requires amd64 or arm64' >&2; exit 1 ;;
      esac
      curl -fSL --retry 3 "https://github.com/axllent/mailpit/releases/download/v1.32.0/mailpit-linux-${arch}.tar.gz" -o /tmp/mailpit.tar.gz
      tar -xzf /tmp/mailpit.tar.gz -C /usr/local/bin mailpit
      chmod 755 /usr/local/bin/mailpit
      rm /tmp/mailpit.tar.gz
      ;;
    rustfs)
      case "$(dpkg --print-architecture)" in
        amd64) arch=x86_64 ;;
        arm64) arch=aarch64 ;;
        *) echo 'RustFS requires amd64 or arm64' >&2; exit 1 ;;
      esac
      curl -fSL --retry 3 "https://github.com/rustfs/rustfs/releases/download/1.0.4/rustfs-linux-${arch}-gnu-v1.0.4.zip" -o /tmp/rustfs.zip
      unzip -jo /tmp/rustfs.zip rustfs -d /usr/local/bin
      chmod 755 /usr/local/bin/rustfs
      rm /tmp/rustfs.zip
      # Projects that start `minio server` get RustFS instead.
      ln -sf /usr/local/lib/claude-task/minio /usr/local/bin/minio
      ;;
    # Playwright's Chromium build, with the system libraries browsers need (installing those needs
    # root, which the agent lacks), so projects' own Playwright browsers run too.
    chrome)
      export MISE_DATA_DIR=/tmp/chrome-mise MISE_CACHE_DIR=/tmp/chrome-mise/cache
      PLAYWRIGHT_BROWSERS_PATH=/opt/chrome mise exec node@22 -- npx --yes playwright@1.64.0 install --with-deps chromium
      chrome="$(find /opt/chrome -path '*/chromium-*' -type f -name chrome -perm -u+x | head -n 1)"
      if [[ -z "$chrome" ]]; then echo 'Chromium binary not found after install' >&2; exit 1; fi
      ln -sf "$chrome" /usr/local/bin/chromium
      chmod -R a+rX /opt/chrome
      rm -rf /tmp/chrome-mise /root/.npm /var/lib/apt/lists/*
      unset MISE_DATA_DIR MISE_CACHE_DIR
      ;;
  esac
done
