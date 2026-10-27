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
| `DATA_DIR` | Attachment and avatar storage; backend default `./.data`, production image `/data`. |
| `STATIC_DIR` | Built web app directory; production image `/app/public`. |
| `LOG_LEVEL` | Backend log detail; default `info`. |
| `DOCKER_SOCKET` | Docker socket; default `/var/run/docker.sock`. |
| `AGENT_BACKEND_URL` | Backend URL reachable from Agent Containers; host-mode default `http://host.docker.internal:3000`, Compose `http://app:3000`. |
| `AGENT_NETWORK` | Agent Docker network; empty uses Docker's default bridge. |
| `CLAUDE_CODE_VERSION` | Pinned Claude Code version used in Agent Images; current default `2.1.310`. |
| `AGENT_COMMIT_EMAIL_DOMAIN` | Email domain used for Agent commits; default `agents.claude-task.local`. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | Optional environment-managed GitHub App connection. The key accepts literal `\n` line breaks. |
| `GITLAB_URL`, `GITLAB_TOKEN` | Optional environment-managed GitLab connection; URL defaults to `https://gitlab.com`. |
| `FCM_SERVICE_ACCOUNT_FILE` | Optional Firebase service-account file for native push notifications; mount the file and set its container path. |
| `AGENT_RUNTIME` | Default `docker`. `fake` simulates containers for tests and demos and does not run Claude. |

Terminate HTTPS at your reverse proxy and forward both HTTP and WebSocket traffic. The normal web frontend and backend share the same origin. Set public and Agent-facing URLs separately when only the proxy is reachable to Users.

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

Use **Recreate when idle** for a planned container replacement. **Restart** and **Force recreate** interrupt active work, which resumes after reconnection. Avoid deleting an Agent to fix an ordinary startup failure: deletion removes its persistent storage.

## Related

- [Agents and credentials](admin-agents.md): configure and inspect an Agent in the web app.
- [Users and access](admin-users.md): manage ordinary login recovery.
- [Troubleshooting](troubleshooting.md): recognize errors reported to Users.

---

← [Extensions and environment](admin-extensions.md) · [Roles and limits](roles-and-limits.md) →
