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
      ;;
  esac
done
