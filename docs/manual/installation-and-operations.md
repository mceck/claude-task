[Manual](README.md) › Operations

# Run and maintain an installation

This page is for the person operating the Claude Task server. You need server access, Docker and permission to manage its PostgreSQL database and persistent storage.

## Start the supplied Docker Compose stack

The repository includes a Compose stack with PostgreSQL 17 and the app, exposing port 3000. Set its required environment values before starting it.

1. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` for the first Admin. The password must have at least eight characters.
2. Generate a random 32-byte key, encoded as base64 or 64 hexadecimal characters, and set it as `SECRETS_MASTER_KEY`. Keep a secure backup of this key.
3. Set `APP_URL` to the URL Users will open. For HTTPS access, set `COOKIE_SECURE=true`.
4. Build and start the Compose services using the repository's `docker-compose.yml`.
5. Open the installation URL and log in with the initial Admin credentials.
6. Create a Credential and Agent in the web app. Its first Build also builds the platform's Base Image when needed.

The backend applies database migrations on startup. Initial Admin environment values create an Admin only when the database contains no Users; they do not reset an existing Admin password.

The supplied stack uses a mounted Docker socket to build Agent Images and start Agent Containers. Its Docker network is `claude-task-agents`; Agents reach the backend at `http://app:3000`. Agents need outbound access to download dependencies and reach Claude and repository services. Configure `DOCKER_GID` for your host's socket permissions when necessary.

> **Warning:** Keep `SECRETS_MASTER_KEY` with the database backup. Restoring the database with a different key prevents stored Credentials and other secrets from being decrypted.

## Configuration reference

These are backend environment settings. The supplied Compose file exposes a subset directly; add other settings to its app service when needed.

| Setting | Purpose and default |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL connection URL. Compose supplies its database URL. |
| `SECRETS_MASTER_KEY` | Required secret-encryption key that decodes to 32 bytes. Keep it stable. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | Initial Admin details. The default display name is `Admin`. |
| `HOST`, `PORT` | Listen address and port; defaults `0.0.0.0` and `3000`. |
| `APP_URL` | Public installation URL used for links; defaults to localhost and the configured port. |
| `COOKIE_SECURE` | Requires HTTPS for browser login cookies; backend default `true`, local Compose default `false`. |
| `TRUST_PROXY` | Trust proxy forwarding headers; default `false`. Set according to your reverse proxy deployment. |
| `DATA_DIR` | Attachment and avatar storage with `STORAGE_TYPE=disk`; backend default `./.data`, production image `/data`. |
| `STORAGE_TYPE` | Where attachment and avatar bytes live: `disk` (default) or `s3`. |
| `S3_BUCKET` | Bucket for `STORAGE_TYPE=s3`; it must already exist. |
| `S3_REGION` | Bucket region; default `us-east-1`. |
| `S3_ENDPOINT` | S3 API endpoint for RustFS, MinIO or another S3-compatible service; leave unset for AWS S3. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Static S3 credentials, set both or neither; otherwise the AWS credential chain is used. |
| `S3_FORCE_PATH_STYLE` | Path-style bucket addressing; defaults to `true` when `S3_ENDPOINT` is set and `false` for AWS S3. |
| `S3_PREFIX` | Optional key prefix, e.g. `claude-task/`, to share one bucket between installations. |
| `STATIC_DIR` | Built web app directory; production image `/app/public`. |
| `LOG_LEVEL` | Backend log detail; default `info`. |
| `DOCKER_SOCKET` | Docker socket; default `/var/run/docker.sock`. |
| `AGENT_BACKEND_URL` | Backend URL reachable from Agent Containers; host-mode default `http://host.docker.internal:3000`, Compose `http://app:3000`. |
| `AGENT_NETWORK` | Agent Docker network; empty uses Docker's default bridge. |
| `AGENT_STOP_WHEN_UNUSED` | Stop an Agent's container while the Agent has no work, and start it again when work arrives. Defaults to `true`; set `false` to keep every Agent's container running. See [Agents and credentials](admin-agents.md). |
| `AGENT_WIKI_IDLE_MINUTES` | Minutes after the last Job that a Wiki keeps its Agent's container running. Default `30`. |
| `AGENT_STOP_ON_SHUTDOWN` | Stop this installation's Agent Containers on graceful backend shutdown. Defaults to `true` in local development and `false` with `NODE_ENV=production`; the supplied Compose stack explicitly defaults to `true`. Set `false` to keep Agents running through backend restarts. |
| `CLAUDE_CODE_VERSION` | Pinned Claude Code version used in Agent Images; current default `2.1.310`. |
| `AGENT_COMMIT_EMAIL_DOMAIN` | Email domain used for Agent commits; default `agents.claude-task.local`. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | Optional environment-managed GitHub App connection. The key accepts literal `\n` line breaks. |
| `GITLAB_URL`, `GITLAB_TOKEN` | Optional environment-managed GitLab connection; URL defaults to `https://gitlab.com`. |
| `FCM_SERVICE_ACCOUNT_FILE` | Optional Firebase service-account file for native push notifications; mount the file and set its container path. |
| `AGENT_RUNTIME` | Default `docker`. `fake` simulates containers for tests and demos and does not run Claude. |

Terminate HTTPS at your reverse proxy and forward both HTTP and WebSocket traffic. The normal web frontend and backend share the same origin. Set public and Agent-facing URLs separately when only the proxy is reachable to Users.

## Attachment storage

Attachments and avatar images are stored in `DATA_DIR` by default. To keep them in an S3-compatible bucket instead, create the bucket and set `STORAGE_TYPE=s3` with its settings:

```ini
STORAGE_TYPE=s3
S3_BUCKET=claude-task-files
S3_REGION=us-east-1
# Local RustFS/MinIO or another S3-compatible service; leave unset for AWS S3.
S3_ENDPOINT=http://127.0.0.1:9000
S3_ACCESS_KEY_ID=rustfsadmin
S3_SECRET_ACCESS_KEY=rustfsadmin
# Multiple installations: keep their objects apart.
S3_PREFIX=installation-a/
```

With the supplied Compose stack, export the same variables (or put them in `.env`); the app service passes them through. The backend still streams every download through its own authenticated endpoints, so the bucket stays private.

The setting is read at startup and does not migrate existing blobs: attachments written to the previous location are no longer found. Move the objects yourself (keeping their ids as object keys) before switching an installation with existing files.

## Stop or restart the backend

The backend handles `SIGINT` and `SIGTERM` as graceful shutdown requests. Whether Agent Containers stop with it depends on `AGENT_STOP_ON_SHUTDOWN`.

With this setting enabled, the backend stops scheduling new work, finishes in-flight scheduling and maintenance operations, and stops the containers belonging to its stored Agents. Active Jobs are interrupted when their containers stop. Each container has 10 seconds to stop its processes. The supplied Compose stack allows 30 seconds for the app's shutdown. Missing or already stopped containers are accepted; failed stops are logged and make the shutdown finish with an error.

Stopping keeps the containers, images and Agent Volumes, including Worktrees, Claude transcripts and Development Service data. On the next backend start, the containers of Agents that have work are started again and interrupted work recovers through the normal Session resume flow.

With the setting disabled, Agent Containers keep running while the backend restarts and their Runners reconnect afterward. Closing a browser or native app leaves both the backend and its Agents running.

## Local development services

The repository's `monade.yaml` starts the backend, frontend and a local Mailpit service automatically when used with the team's local service manager:

| Service | Command | Port | Local domain |
| --- | --- | --- | --- |
| Backend | `pnpm dev:backend` | `3000` | `claude-task-api.localhost` |
| Web app | `pnpm dev:frontend` | `5173` | `claude-task.localhost` |
| Mailpit | `mailpit` | `8025` | `mailpit.test` |

This host-side Mailpit service is separate from Mailpit selected under an Agent's **Services**. An Agent's Mailpit runs inside its own container and keeps its data in that Agent's Volume. See [Agents and credentials](admin-agents.md#prepare-the-development-environment) for the Agent environment.

## Recover Admin access

The CLI can create an Admin or promote and reactivate a User with the given email. Its verified help command and output are:

```console
$ pnpm --filter @claude-task/backend cli --help
Usage:
  cli create-admin --email <email> [--password <password>] [--name <display name>]

Creates an admin, or promotes and reactivates an existing user with that email.
The password can also come from ADMIN_PASSWORD. Without one, a new user gets a
generated temporary password (printed once) and an existing user keeps theirs.
```

From a source checkout with dependencies installed, provide `DATABASE_URL` in the process environment and use the `create-admin` command shown above. An explicit password, including one inherited from `ADMIN_PASSWORD`, sets the password. Without one, a new User receives a temporary password printed once; an existing User keeps their password. Do not assume the CLI loads `backend/.env` automatically.

In the production image the equivalent CLI entry point is `node dist/cli.js`, with the same arguments and the container's configured database connection.

## Back up and upgrade

Back up the PostgreSQL database, the app data volume, every Agent Volume and the secret-encryption key. The database holds Tasks, Comments, settings and history; the app data volume holds uploaded files; Agent Volumes hold Worktrees, Claude transcripts and Development Service data. Take a coordinated backup while writes and Agent work are stopped to keep the copies consistent. Remote repository branches and pull requests stay on their code host.

For an upgrade, preserve those volumes and the master key, then rebuild and restart the app. Database migrations run at startup. A change to the platform's Base Image, Runner or pinned Claude version automatically schedules affected Agent Builds. Each working Agent switches to its successful new image when idle. Review failed Builds in **Agents** → the Agent → **Builds**.

## Diagnose an unavailable Agent

Check its Build log first, then **Container logs** and the Runner connection status. A Runner that cannot reach `AGENT_BACKEND_URL` leaves the Agent `offline`. A Development Service that cannot start can cause repeated container restarts. A failed Extension synchronization prevents new Jobs and shows its error on the Agent page.

An Agent without work has no running container, so it shows `offline` until a Comment, a reopened Task or a reassignment gives it work; that is not a fault. Use **Recreate when idle** for a planned container replacement. **Restart** and **Force recreate** interrupt active work, which resumes after reconnection. Avoid deleting an Agent to fix an ordinary startup failure: deletion removes its persistent storage.

## Related

- [Agents and credentials](admin-agents.md): configure and inspect an Agent in the web app.
- [Users and access](admin-users.md): manage ordinary login recovery.
- [Troubleshooting](troubleshooting.md): recognize errors reported to Users.

---

← [Extensions and environment](admin-extensions.md) · [Roles and limits](roles-and-limits.md) →
