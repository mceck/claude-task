---
status: in-progress
---

# Remote Hosts

## Specs

- [Workers](../specs/workers.md) (Concepts, Hosts, Assigning a Host to a Worker, Worker State, Worker Containers and the reconciler, Cleanup, Backend shutdown, Fake runtime, Architecture, Deployment, Configuration settings, Data model, Decisions)
- [Agent sessions](../specs/agent-sessions.md) (Job start: backend URLs per Host)
- [Runner](../specs/runner.md) (backend URL of a Worker Container)
- [Git integration](../specs/git-integration.md) (Git Proxy URL per Host)
- [Clients](../specs/clients.md) (Workers list and Hosts tab, Worker page, native Worker sheet)
- [Users and auth](../specs/users-and-auth.md) (Admins manage Hosts)

## Problem Statement

Every Worker Container of an Installation runs on the machine of the backend, through the Docker socket mounted into it. When that machine runs out of CPU, memory or disk, the only option is a bigger machine: an Admin who has another server, a workstation with a GPU or an arm64 box cannot put it to work for the team. Toolchains that need a different machine (another architecture, more memory, a machine inside a private network close to some service) cannot be offered as Workers at all.

Admins want to run one container on a new machine, with access to that machine's Docker socket, connect it to Claude Task, and have Workers run there exactly as they run today: built from their Dockerfile, scaled between their minimum and cap, with their Runners, Development Services, Worker Volume and Agent Profiles, without opening ports on that machine.

## Solution

A Worker runs on a **Host**: the machine whose Docker daemon runs its Worker Containers. The machine of the backend is the **Local Host**, as today. An Admin can add **Remote Hosts**:

1. On the Workers page, a new *Hosts* tab lists the Hosts. An Admin creates a Remote Host with a name; the page shows its **Host Token** once, with the commands to build and start the **Host Controller** on the machine (or to run `scripts/deploy.sh host` there).
2. The Host Controller dials out to the backend over a WebSocket and tunnels the backend's Docker API calls to its machine's Docker socket. The backend keeps doing all the Docker work (Builds, Worker Containers, Agent Profile synchronization, logs, Cleanup) through that tunnel, exactly as it does through the local socket.
3. An Admin picks the Host of each Worker when creating it, and can move a Worker to another Host while none of its Projects has a started open Session: the Worker starts over on the new Host with empty volumes, which the page warns about.
4. Worker Containers on a Remote Host reach the backend directly, at the URL the Host Controller connected with (or an Admin's override per Host), over `https` unless the Host explicitly allows insecure connections.
5. If a Host Controller disconnects, running Worker Containers whose Runner is connected keep taking Jobs; Docker work on that Host waits until the Controller is back, and Admin actions that need Docker answer "Host disconnected".
6. An Installation may also run with no Local Host (`LOCAL_HOST=false`), with only Remote Hosts.

## User Stories

1. As an Admin, I want to add a Remote Host from the Workers page, so that I can put another machine to work for the team.
2. As an Admin, I want the Host Token shown only once, with the commands to build and run the Host Controller ready to copy, so that connecting a machine takes one paste and the secret is not readable later.
3. As an Admin, I want to connect a machine behind NAT or a firewall with no inbound port, so that I can use machines that are not reachable from the backend.
4. As an Admin, I want to regenerate a Host's token, so that I can lock out a leaked token; the Controller using the old one is disconnected.
5. As an Admin, I want a Host Controller with an unknown or old token refused, so that nobody can attach a machine without my token.
6. As an Admin, I want to see each Host's connection state, last contact, Controller and Docker versions, OS, architecture, CPUs, memory, Workers and running containers, so that I can tell whether it is healthy and why a Dockerfile behaves differently there.
7. As a Member, I want to see the Hosts and which Host each Worker runs on, without changing them, so that I understand where my Projects run.
8. As an Admin, I want to choose the Host of a Worker when I create it, with the Local Host preselected when there is one, so that the common case needs no choice.
9. As an Admin, I want a Worker on a Remote Host to build its image, start its containers, scale, synchronize Agent Profiles, show logs and be cleaned up exactly like a Worker on the Local Host, so that Hosts change nothing about how Workers behave.
10. As an Admin, I want images built on the Remote Host itself, from what the backend sends, so that an arm64 Host gets native images and updating the backend updates every Host's images without touching the machines.
11. As an Admin, I want a Host Controller that speaks an incompatible protocol refused with a message telling me to rebuild it, so that version skew is explicit instead of breaking Builds.
12. As an Admin, I want Worker Containers on a Remote Host to reach the backend at the URL the Controller connected with, or at an override I set on the Host, so that a VPN or internal address works.
13. As an Admin, I want Remote Hosts to require `https`/`wss` unless I explicitly allow insecure connections on the Host, so that tokens and code do not cross the network in clear by mistake.
14. As an Admin, I want to set the Docker network the Worker Containers of a Remote Host join, so that they can reach services on that machine's networks.
15. As an Admin, I want changing a Host's backend URL or network to recreate its Worker Containers as soon as each is free, so that the change takes effect without interrupting Jobs.
16. As an Admin, I want to move a Worker to another Host, with a clear warning that it starts over with empty volumes and loses its Development Service data, so that I can rebalance machines knowingly.
17. As a User, I want a Worker's move refused while one of its Projects has a started open Session or an active Job, listing the Tasks to close, so that no conversation silently loses its transcript.
18. As an Admin, I want the resources a moved Worker left on its old Host removed, right away when the old Host is connected and by the next Cleanup otherwise, so that a move does not leave its volumes and images behind.
19. As a User, I want Jobs on running containers to keep going when their Host Controller disconnects, so that a Controller restart or a network blip on the control path does not stop work.
20. As an Admin, I want Builds, synchronizations, scaling and Cleanup on a disconnected Host to wait and resume when its Controller reconnects, so that nothing fails permanently because of a temporary disconnection.
21. As an Admin, I want Restart, Force recreate, Logs and Rebuild to answer "Host disconnected" while the Worker's Host is disconnected, so that I know why they cannot run.
22. As a User, I want a Worker whose Host is disconnected and that has no connected Runner to show `host_offline`, and a Worker with connected Runners on a disconnected Host to show its usual state with a banner, so that I can tell an unreachable machine from an idle Worker.
23. As an Admin, I want to delete a Remote Host that no Worker uses, with its containers, volumes and images removed from the machine when its Controller is connected, and a warning about leftovers when it is not, so that retiring a machine is clean.
24. As an Admin, I want deleting a Host that Workers use refused, naming those Workers, so that no Worker is left without a Host.
25. As an Admin, I want a deleted Host's Controller to stop reconnecting, so that a retired machine does not hammer the backend.
26. As an Admin, I want each Cleanup to cover every Host, with disconnected Hosts reported as still to answer and cleaned when their Controller reconnects, so that every machine's disk is reclaimed.
27. As an Admin, I want `WORKER_STOP_ON_SHUTDOWN` to stop the Worker Containers of connected Remote Hosts too, so that a development backend leaves no container running anywhere.
28. As an operator, I want to run an Installation with `LOCAL_HOST=false`, so that the backend can run without a Docker socket with only Remote Hosts.
29. As an operator upgrading, I want my existing Workers to land on the Local Host with nothing to do, so that the upgrade is invisible.
30. As an operator, I want `scripts/deploy.sh host` to set up a fresh machine as a Remote Host (Docker, Controller image, URL and token), so that adding a machine is as easy as installing the backend.
31. As a native app User, I want the Worker sheet to show the Worker's Host and the `host_offline` state, so that the app tells the same story as the web app.

## Implementation Decisions

### Model and data

- New `hosts` table: id, kind (`local` or `remote`), name (unique ignoring case), description, Host Token hash (remote only, unique), backend URL override (nullable), allow insecure flag (default false), Docker network (nullable), the URL the Controller last reported, Controller version, protocol version, Docker version, OS, architecture, CPUs, memory in bytes, connected at, disconnected at, last connection error (nullable, up to 2,000 characters), the Cleanup whose Docker part waits for this Host (nullable, set null on Cleanup deletion), created and updated times. A unique partial index allows at most one `local` row.
- `workers.host_id`: not null, references `hosts` with restrict on delete.
- The migration inserts the Local Host row (name "Local") and assigns every existing Worker to it, so existing Installations change nothing.
- Cleanups gain `hosts_pending` (integer, default 0): Hosts whose Docker part has not run yet.
- Shared types: a `Host` payload (id, kind, name, description, state, connected at, disconnected at, Controller version, Docker version, OS, architecture, CPUs, memory bytes, effective backend URL, backend URL override, allow insecure, network, error, Workers as id and name, running containers count); the Worker payload gains its Host as id, name and state; `WorkerState` gains `host_offline`; the Cleanup payload gains hosts pending. A `HOST_PROTOCOL_VERSION` constant (starting at 1) and the Host Controller WebSocket path live in the shared package.

### Local Host

- `LOCAL_HOST` setting, default `true`. With `false`, the backend creates no runtime for the Local Host.
- The Local Host's name ("Local") cannot be edited, it has no token, no backend URL override, no network field (it uses `AGENT_BACKEND_URL` and `AGENT_NETWORK` as today) and no allow-insecure flag (the `https` rule does not apply to it). Deleting it is answered with `409` ("The Local Host cannot be deleted").
- Its state is `connected` when the last Docker ping through the local socket succeeded. The backend pings at startup and on every 30-second scheduler tick. With `LOCAL_HOST=false` its state is `disconnected` with the error "Local Host disabled (LOCAL_HOST=false)".
- With `LOCAL_HOST=false`, the Local Host is listed only while some Worker still uses it. It is never offered in the Host pickers, and a request choosing it is answered with `400` ("Unknown host").

### Remote Hosts API

| Request | Who | Notes |
| --- | --- | --- |
| `GET /hosts`, `GET /hosts/:id` | Every User | |
| `POST /hosts` | Admins | Answered `201` with the Host, its token and the connect commands |
| `PATCH /hosts/:id` | Admins | Name, description, backend URL override, allow insecure, network |
| `POST /hosts/:id/token` | Admins | Regenerates: answered with the new token and the connect commands |
| `DELETE /hosts/:id` | Admins | See Deleting a Remote Host |

- Field rules: name 1 to 100 characters, trimmed, unique ignoring case across all Hosts including "Local" (a duplicate gets `409`); description up to 2,000 characters; backend URL override: an absolute `http` or `https` URL without query or fragment, trailing slashes removed, and `https` unless allow insecure is on (otherwise `400` "The backend URL must use https unless insecure connections are allowed"); network: empty, or 1 to 128 characters from `[A-Za-z0-9_.-]` starting with a letter or digit. Turning allow insecure off while the override is `http` is answered with the same `400`.
- The Host Token is 256 random bits, URL-safe, stored only as a SHA-256 hash, returned only by create and regenerate. Regenerating closes the current Controller connection with close code 4007 ("token regenerated").
- The connect commands the API returns (the web app shows them):
  1. from a clone of the repository at the backend's version: `docker build --target host-controller -t claude-task/host-controller .`
  2. `docker run -d --name claude-task-host-controller --restart unless-stopped -v /var/run/docker.sock:/var/run/docker.sock -e CLAUDE_TASK_URL=<APP_URL> -e CLAUDE_TASK_HOST_TOKEN=<token> claude-task/host-controller`, with `-e CLAUDE_TASK_ALLOW_INSECURE=true` added when `APP_URL` is `http` and the Host allows insecure connections;
  3. the alternative `scripts/deploy.sh host`, which asks for the URL and the token.
- Real-time events on the `workers` topic: `host.updated` with the Host, `host.deleted` with its id. A Worker whose Host changes state is republished on the `workers` and `worker:<id>` topics, since its state and banner depend on it.

### Host Controller connection

- WebSocket endpoint at the shared Host Controller path, authenticated by the Host Token as a bearer token. An unknown token is answered with `401`. A second connection for the same Host replaces the first (close code 4001, "replaced").
- The Controller's first message is a JSON text message `hello` with its protocol version, Controller version and the backend URL it was configured with. The backend then:
  - closes with 4005 ("incompatible controller") when the protocol version differs from `HOST_PROTOCOL_VERSION`, recording the error "The Host Controller speaks protocol ‹n›, this backend needs ‹m›: rebuild it from this version";
  - closes with 4006 ("insecure") when the reported URL is `http` and the Host does not allow insecure connections, recording the error "The Host Controller connects over http, but this Host does not allow insecure connections";
  - otherwise stores the reported URL and versions, reads Docker's version and system info through the tunnel (Docker version, OS, architecture, CPUs, memory), clears the error, sets connected at, publishes the Host and its Workers, runs the Docker part of a pending Cleanup for this Host and reconciles each of its Workers.
- The backend pings every 30 seconds and drops a connection that misses a whole round, as for Runners. A dropped connection sets disconnected at, publishes the Host and its Workers, and fails every open tunnel stream.
- Close codes: 4001 replaced, 4004 host deleted, 4005 incompatible controller, 4006 insecure, 4007 token regenerated. The Controller retries with exponential backoff from 1 second up to 30 seconds, forever, except after a `401` answer or close code 4004. After those it stays running without reconnecting and logs the reason, so that `--restart unless-stopped` does not turn the refusal into a loop.

### The tunnel

- After `hello`, the WebSocket carries binary frames that multiplex byte streams to the Host's Docker socket: one byte op, a four-byte big-endian stream id, then the payload. Ops: `open` (backend to Controller: dial the Docker socket for this stream id), `data` (both ways), `end` (both ways: the sender will write no more), `close` (both ways: the stream is over, optional UTF-8 error text as payload). The backend allocates the stream ids.
- The tunnel is HTTP-agnostic: each stream is a raw connection to the Docker socket, so ordinary requests, streamed build contexts, build output, logs and hijacked `exec` connections work unchanged.
- On the backend, a tunnel HTTP agent creates each connection as a duplex stream over a new tunnel stream. The Remote Host's `DockerRuntime` uses a dockerode client built with that agent instead of a socket path (prior art: docker-modem's SSH agent, which works the same way).
- Backpressure: the backend pauses the source of a stream while the WebSocket's buffered amount exceeds 4 MiB, and resumes it once the buffer drains. The Controller's writes block until sent.
- A Docker call that fails because the tunnel closed raises a Host-disconnected error.

### Host Controller program

- A Go binary in the `runner` module (its own command, with its package under the module's internal packages), using the module's existing WebSocket library. Environment: `CLAUDE_TASK_URL` (required, the backend's base URL), `CLAUDE_TASK_HOST_TOKEN` (required), `CLAUDE_TASK_ALLOW_INSECURE` (default `false`), `DOCKER_SOCKET` (default `/var/run/docker.sock`). A missing variable, or an `http` URL without `CLAUDE_TASK_ALLOW_INSECURE=true`, is logged and leaves the process running without connecting.
- It derives the WebSocket URL from `CLAUDE_TASK_URL` (`http`→`ws`, `https`→`wss`, plus the Host Controller path), sends `hello`, then serves tunnel streams. It holds no state and runs no Docker logic of its own.
- The image is a `host-controller` stage of the repository's `Dockerfile`, placed before the backend's final stage so that a plain `docker build` still produces the backend. It contains the static binary and CA certificates, and runs as root inside its container: it holds the Docker socket, which is root on the machine anyway, and a non-root user would need the socket's group id, which differs per machine.
- `scripts/deploy.sh host`: installs Docker when missing (as the backend setup does), asks for the backend URL and the Host Token (and whether to allow insecure connections when the URL is `http`), builds the Controller image from the clone and starts it with the run command above, replacing an existing `claude-task-host-controller` container.

### Runtimes per Host

- `ctx.runtime` becomes a registry of runtimes per Host: it returns the runtime of a Host or of a Worker's Host, or raises Host-disconnected. Local Host: a `DockerRuntime` on `DOCKER_SOCKET`. Remote Host: a `DockerRuntime` on the tunnel, created when the Controller completes `hello` and dropped when it disconnects.
- `DockerRuntime` takes its Docker client and its network per Host instead of reading them from the global configuration. Before creating a container on a network other than the default bridge, it creates the network when missing, labelled with the Installation id.
- The Platform Version is computed by the backend from its bundled sources, the same for every Host. Each Host builds its own Base Image at that version when missing, from the context the backend sends.
- `AGENT_RUNTIME=fake`: the Local Host gets a fake runtime that is always connected (unless `LOCAL_HOST=false`). A Remote Host gets its own fake runtime when a fake Controller (the test harness) completes `hello`, and the harness exposes each Host's fake runtime and Runner tokens per (Worker, slot).

### Backend URL per Host

- The effective backend URL of a Host is `AGENT_BACKEND_URL` for the Local Host, and the override, or else the URL the Controller last reported, for a Remote Host.
- Everything a Worker Container uses to reach the backend derives from its Worker's Host's effective backend URL: the Runner WebSocket URL in the container environment, the Git Proxy clone URL and the MCP URL in the Job start, the attachment fetch URLs in delivered Messages and the upload URLs of Task Tool file requests.
- The desired container specification compared by the reconciler gains the backend URL and the network, so changing a Host's override, its network, or the URL its Controller reports recreates each Worker Container as soon as it is free, under the existing recreation rule.

### Assigning a Host to a Worker

- `POST /workers` takes a `hostId`. When it is omitted, the default is the Local Host when it is enabled, otherwise the only Host when exactly one exists, otherwise the request is answered with `400` ("Choose a host"). An unknown or unselectable Host gets `400` ("Unknown host").
- Duplicating a Worker keeps the source's Host.
- `PATCH /workers/:id` with a different `hostId` (Admins) moves the Worker. It is refused with `409` while any Project of the Worker has a started Session outside a `closed`-category Status (listing their Task Keys, with the wiki hint as in the Project rule) or while the Worker has an active Job. The Project rule's check is reused per Project. When accepted, in one transaction:
  - the Worker's Host changes; its current image, image state (`none`) and image Platform Version are cleared;
  - its Worker Container records are deleted (Jobs keep their slot number; Sessions keep their last slot, which is only a dispatch preference);
  - its Agent Profile synchronization records are deleted, so every Agent synchronizes again on the new Host;
  - a pending Worker Volume cleanup request of the Worker is settled with zero counts.
  
  After commit, the old containers' Runner connections close with code 4002 ("container recreated"). The old Host's resources of the Worker are removed in the background when the old Host is connected, and by the next Cleanup otherwise. The Worker is reconciled, which starts a Build on the new Host. Its Queue, Projects and Build history stay.
- Moving a Worker is applied immediately on its own, not through "Save Docker configuration".

### Disconnected Hosts

- The reconciler skips the Workers of a disconnected Host: no Builds, starts, stops, recreations, inspections or idle stops. In particular a Worker Container whose Runner stays away past the reconnect timeout is not recreated while its Host is disconnected.
- A Build requested while the Host is disconnected (configuration change, platform upgrade) sets the Worker's pending Build flag and starts when the Host reconnects. A Build whose Host disconnects mid-way is marked failed with the note "The Host disconnected during this build" and its pending Build flag is set, so it runs again on reconnection.
- Agent Profile synchronizations do not start on a disconnected Host; the entries waiting for them keep waiting.
- Dispatch keeps working: a Worker Container whose last observed state is running, with its Runner connected, takes Jobs whatever its Host's connection.
- Restart, Force recreate, Logs and Rebuild on a Worker whose Host is disconnected are answered with `409` ("Host disconnected"). Recreate when idle still records its request, applied once the Host is back.
- Worker State order: `disabled`, then `host_offline` (Host disconnected and no Runner of the Worker connected), then `building`/`build_failed`, `offline`, `working`/`idle`. The Worker page shows a banner "Host ‹name› is disconnected: containers cannot be started, stopped or rebuilt until it reconnects" whenever its Host is disconnected and the state is not `host_offline`.
- Schedules are not skipped for a disconnected Host: their Queue Entries wait like any other.

### Deleting a Remote Host

- Refused with `409` naming the Workers that use it.
- Otherwise the record is deleted at once (the token stops working) and the request is answered `204`. When the Controller is connected, the backend then removes through the tunnel, in the background, every container, volume, Worker Image and network labelled with this Installation's id, and untags Base Images without force, then closes the connection with 4004 ("host deleted"). A failure there is logged. When the Controller is disconnected, nothing is removed. The web app's confirmation warns that resources stay on the machine and must be removed by hand.

### Cleanup per Host

- The Docker part of a Cleanup runs once per connected Host, with the Workers of that Host as the known Workers. Resources of Workers that no longer exist, or no longer run on that Host, are therefore leftovers there. Base Images are kept for the Claude Code versions of that Host's Workers, and the Build checks (any Build running, a Worker's Build running) are made per Host.
- A disconnected Host gets the Cleanup as pending (its pending Cleanup set, the Cleanup's hosts pending increased). When its Controller reconnects, its Docker part runs and its counts, space and errors are added to that Cleanup, which then decreases hosts pending. A newer Cleanup replaces a pending one.
- Removing slots above the cap inspects containers, so it runs only for Workers on connected Hosts; the others are picked up by a later Cleanup.
- The old Base Images step after a successful Build runs on that Worker's Host, keeping the versions of that Host's Workers.
- The Cleanup dialog and summary line show the Hosts still to answer next to the Worker Volumes still to answer.

### Shutdown

- With `WORKER_STOP_ON_SHUTDOWN` enabled, the backend stops the Worker Containers of the Local Host and of every connected Remote Host, before closing Controller connections. A Remote Host that is disconnected is skipped, and the skip is logged.

### Web app

- Workers page: tabs *Workers* and *Hosts*. The Workers list gains a Host column.
- Hosts tab: one row per Host with its name, kind, state dot (green connected, grey disconnected), last contact, Controller and Docker versions, OS and architecture, CPUs and memory, Workers (links) and running containers, plus its error when set. Admins get "Add host", and Edit, Regenerate token and Delete per Remote Host.
- Add host: a dialog with name, description, backend URL override, allow insecure and network. On success it switches to a "Connect the machine" view that shows the token and the three connect commands, each with a copy button, and the note "This token is shown only once". Regenerate token asks for confirmation (the connected Controller will be disconnected), then shows the same view.
- Delete host: a confirmation. When the Host is disconnected, it adds "The Controller is disconnected: containers, volumes and images stay on the machine and must be removed by hand". A `409` shows the Workers to move first.
- Worker create form: a Host select (Admins), preselected according to the API default. Configuration tab: a Host select applied on its own after a confirmation dialog: "The worker will start over on ‹host› with empty volumes: Development Service data is lost, and the first Job of each Project rebuilds the image, clones the repository and reinstalls tools." A `409` shows the listed Tasks.
- Worker page header: the Host name. The banner above follows the disconnected-Hosts rule. The state dot and label support `host_offline`, coloured like `offline`, labelled "host offline".
- Workers topic handlers update the Hosts list on `host.updated` and `host.deleted`.

### Native app

- The Worker sheet shows the Host name. The Worker State parser, the state dot and the Worker pickers support `host_offline`, with the same colour and label as the web app. Host management stays in the web app.

## Plan

Each step leaves the project working and can be committed on its own. Tests are written in the same step as the behaviour they cover, at the seams in Testing Decisions. Steps apply the decisions above and do not restate their values.

### Backend: Hosts as data

1. **Hosts table and Worker Host.**
   - Add the `hosts` table, `workers.host_id` and `cleanups.hosts_pending` in the schema, and generate a migration that inserts the Local Host and assigns every Worker to it before making the column not null.
   - Add the shared `Host` type, the Host on the Worker payload, `host_offline`, hosts pending on the Cleanup payload, the protocol version and the Host Controller path.
   Verification: the migrations test passes on a database with Workers created before the migration, and every Worker references the Local Host.

2. **`LOCAL_HOST` setting and Local Host state.**
   - Read `LOCAL_HOST` in the configuration. Ping the local daemon at startup and on each scheduler tick, and store the Local Host's connection times and error under the Local Host rules.
   - Serve `GET /hosts` and `GET /hosts/:id` with the Host payload, including the Local Host listing rule.
   Verification: workers tests show the Local Host as connected with the fake runtime; with `LOCAL_HOST=false` it is absent from `GET /hosts` when no Worker uses it, present and disconnected with the error when one does; config test covers the setting.

3. **Runtime registry.**
   - Replace `ctx.runtime` with the registry of runtimes per Host and make every call site (scheduler, Workers routes, shutdown) resolve the runtime through the Worker's Host. Make `DockerRuntime` take its client and network per Host, creating a missing non-default network.
   - Make the fake runtime per Host and extend the test harness to reach each Host's fake runtime.
   Verification: the whole backend suite passes unchanged against the Local Host.

4. **Remote Host management API.**
   - Add create, edit, regenerate token and delete (without the removal on the machine yet) with the field rules, the token rules, the connect commands, the Local Host restrictions, the permissions and the `host.updated` / `host.deleted` events.
   Verification: hosts tests cover each field rule and error, the token being returned only on create and regenerate and stored hashed, the commands (with and without the insecure flag), `409` for deleting a used Host and the Local Host, and `403` for Members on every write.

### Backend: Controller connection and tunnel

5. **Controller WebSocket.**
   - Add the Host Controller endpoint with bearer authentication, replacement, `hello` handling (protocol and insecure checks, stored versions), ping, disconnection and the close codes. Regenerating the token closes the connection.
   - With the fake runtime, `hello` attaches the Host's fake runtime and fake Docker info.
   Verification: hosts tests connect a fake Controller and observe the Host going connected with its versions and info, `401` for an unknown or regenerated token, 4005 and 4006 with their recorded errors, 4001 on a second connection, 4007 on regeneration, and the Host going disconnected after a missed ping round.

6. **Tunnel transport on the backend.**
   - Implement the frame codec, the stream multiplexer over the Controller connection with backpressure, the tunnel HTTP agent and the dockerode client built on it. With the Docker runtime, `hello` creates the Remote Host's `DockerRuntime` on the tunnel and reads Docker info through it.
   Verification: tunnel tests run dockerode through the tunnel against an in-process fake Controller that pipes streams to a fake Docker HTTP server on a Unix socket: a JSON request, a streamed upload with streamed output (build), a hijacked exec with output in both directions, a large response under backpressure, and in-flight requests failing with Host-disconnected when the connection drops.

### Host Controller

7. **Host Controller binary.**
   - Add the Go command and package: environment handling, `hello`, the tunnel serving streams against the Docker socket, reconnection with backoff, and stopping after `401` or 4004.
   Verification: Go black-box tests run the binary against a fake backend WebSocket and a fake Docker HTTP server on a Unix socket, covering `hello` contents, request round-trips, an `exec`-style upgraded stream, `end` and `close` handling, a failed dial reported as `close` with error, reconnection after a drop, no reconnection after `401` or 4004, and refusal to connect over `http` without the insecure flag.

8. **Controller image and deploy script.**
   - Add the `host-controller` stage to the `Dockerfile`, keeping the backend as the default target, and the `host` mode of `scripts/deploy.sh`.
   Verification: `docker build --target host-controller -t claude-task/host-controller .` and `docker build -t claude-task .` both succeed; `scripts/deploy.sh host` run on a test machine leaves the Controller running and the Host connected.

### Backend: Workers on Remote Hosts

9. **Backend URL per Host.**
   - Compute the effective backend URL per Host and use it for the Runner URL, Git Proxy URL, MCP URL, attachment URLs and upload URLs. Add backend URL and network to the desired container specification.
   Verification: workers tests run a Job on a Worker of a Remote Host (fake Controller) and check the Runner token environment URL, the Job start's clone and MCP URLs, an attachment fetch URL and an upload URL use the Host's URL; changing the override, or reconnecting with another reported URL, recreates a free container and waits for a busy one.

10. **Host selection on Workers.**
    - Accept `hostId` on create with the defaulting rule, keep the Host on duplicate, and move Workers on `PATCH` with the move rule, the transaction and the after-commit steps.
    Verification: workers tests cover the default Host in each case, `400` for an unknown or disabled Local Host, duplicate keeping the Host, `409` listing Task Keys for a started open Session (and the wiki hint), `409` for an active Job, and an accepted move that clears image, containers and synchronization records, closes Runner connections, removes the Worker from the old fake runtime, builds on the new Host and dispatches its Queue there.

11. **Disconnected Hosts.**
    - Apply the disconnected-Hosts rules in the reconciler, Builds, synchronizations, Admin actions and Worker State, and republish Workers when their Host's state changes.
    Verification: workers tests with a fake Controller that disconnects show a running container with a connected Runner still taking a Job, no recreation past the Runner reconnect timeout, a configuration change building only after reconnection, a Build interrupted by the disconnection marked failed and rebuilt on reconnection, a synchronization waiting, `409` for Restart, Force recreate, Logs and Rebuild, Recreate when idle applied after reconnection, `host_offline` once no Runner is connected, and the usual state while one is.

12. **Deleting a Remote Host with removal.**
    - Add the background removal through the runtime when the Controller is connected, then the 4004 close.
    Verification: hosts tests delete a connected Host and observe the fake runtime emptied of the Installation's resources and the connection closed with 4004; deleting a disconnected Host succeeds with nothing removed.

13. **Cleanup per Host and shutdown.**
    - Run the Docker part per connected Host with that Host's Workers, record pending Hosts, run their part on reconnection, replace pending requests with newer Cleanups, restrict slot removal to connected Hosts, run the post-Build Base Image step per Host, and stop Remote Host containers on shutdown.
    Verification: cleanup tests show a moved Worker's resources removed from its old Host as leftovers, a disconnected Host counted as pending and its results added on reconnection, a newer Cleanup replacing the pending one; shutdown test shows containers stopped on the Local Host and a connected Remote Host, and a disconnected one skipped.

14. **Opt-in end-to-end tunnel test.**
    - Add an opt-in Docker test that builds the Controller binary, connects it to a test backend over a Unix-socket-backed daemon, and runs the `DockerRuntime` over the tunnel: create a volume and a container from `busybox`, exec a command and read its output, read logs, build a tiny image from a streamed context, stop and remove.
    Verification: the test passes with its opt-in variable set against a real Docker daemon, and is skipped otherwise.

### Web app

15. **Hosts tab.**
    - Add the tabs, the Hosts list, Add host with the connect view, Edit, Regenerate token and Delete with their confirmations and errors, and the real-time updates.
    Verification: a Playwright test (fake runtime) adds a Host, sees the token and commands once, sees the Host disconnected, regenerates the token, edits the network, and deletes it; a Member sees the tab without actions.

16. **Host on Workers.**
    - Add the Host column, the Host select on the create form, the Host select with confirmation on the Configuration tab, the Host in the Worker page header, the banner and the `host_offline` state.
    Verification: the Playwright workers test creates a Worker on a chosen Host, moves it to another Host after the confirmation, and sees the `409` Task list when a Session is open.

### Native app

17. **Host on the Worker sheet.**
    - Show the Host name and support `host_offline` in the model, state dot and pickers.
    Verification: `flutter analyze` and the app's tests pass (formatted with Flutter 3.41.7's `dart format`); the sheet shows the Host on a running app. The current package requires Flutter 3.47.6 for analysis and tests; Flutter 3.41.7 is used for formatting. Five existing layout golden failures are reproduced on the starting commit; the Host parsing and sheet tests pass.

### Wrap-up

18. **Glossary, manual and README.**
    - Check `docs/CONTEXT.md` against the final behaviour, describe Remote Hosts and `scripts/deploy.sh host` in the README's deployment section.
    Verification: `pnpm typecheck`, `pnpm test`, the Go tests and `pnpm test:e2e` pass.

## Testing Decisions

- **Backend public API (main seam)**: HTTP, the Workers and Hosts WebSocket topics, the Runner WebSocket and the new Host Controller WebSocket, against real Postgres with the fake runtime per Host and a fake Controller connected by the test harness. Covers Host management, Controller authentication and `hello` checks, the Local Host rules, Host selection and moves, backend URLs per Host, disconnected Hosts, deletion, Cleanup per Host and shutdown. Prior art: the workers, cleanup and shutdown tests, and the fake Runner harness in the test helpers.
- **Tunnel transport**: the backend's tunnel (codec, multiplexer, HTTP agent, dockerode client) against an in-process fake Controller piping to a fake Docker HTTP server on a Unix socket. This is a new seam, kept at the dockerode client level so that it exercises what the `DockerRuntime` does. Prior art: the git proxy tests' fake upstream.
- **Host Controller as a black box**: the Go binary against a fake backend WebSocket and a fake Docker HTTP server on a Unix socket. Prior art: the Runner's black-box harness.
- **Opt-in real Docker**: the Controller and `DockerRuntime` over the tunnel against a real daemon, skipped unless enabled. Prior art: the opt-in Docker Cleanup and entrypoint tests.
- **Playwright**: the Hosts tab and the Host on Workers, with the fake runtime. Prior art: the workers e2e spec.

Cases each behaviour needs:

- Field rules for Hosts: name length, duplicates (including "Local"), description length, URL shape, `http` without allow insecure, turning allow insecure off with an `http` override, network characters.
- Token: shown only on create and regenerate, hashed at rest, old token refused after regeneration, connected Controller closed with 4007.
- Controller connection: `401`, 4001, 4005, 4006, missed ping, reconnection updating the reported URL.
- Local Host: not editable or deletable, `LOCAL_HOST=false` listing and picker rules, unavailable Local Host for a Worker that still uses it.
- Moves: each refusal, and the accepted move's effects on image, containers, synchronization, Runner connections, old-Host removal (connected and disconnected) and the Queue.
- Disconnected Hosts: dispatch still working, every skipped reconciler action, pending and interrupted Builds, synchronizations, Admin `409`s, Worker State and banner condition.
- Deletion: used Host, connected and disconnected Controller.
- Cleanup: per-Host known Workers, pending Host and late results, replacement, slot removal limited to connected Hosts.
- Shutdown: Local, connected and disconnected Remote Host.
- Tunnel: plain request, streamed upload and output, hijacked exec, backpressure, drop mid-request, failed dial.

## Acceptance Criteria

- [ ] Existing Installations upgrade with every Worker on the Local Host and nothing else changing.
- [ ] An Admin can add a Remote Host and sees its token and connect commands only once; Members see Hosts without changing them.
- [ ] A Host Controller started with the commands connects with no inbound port on its machine, and the Host shows connected with its versions, OS, architecture, CPUs and memory.
- [ ] Unknown and regenerated tokens are refused; regenerating disconnects the current Controller.
- [ ] A Controller with another protocol version is refused with the rebuild message; an `http` Controller is refused unless the Host allows insecure connections.
- [ ] A Worker on a Remote Host builds its image on that Host, scales between its minimum and cap, synchronizes Agent Profiles, runs Jobs, shows logs and is cleaned up as on the Local Host.
- [ ] Worker Containers on a Remote Host use the Host's effective backend URL for the Runner, Git Proxy, MCP, attachments and uploads; changing it or the network recreates containers when free.
- [ ] Workers are created on the chosen Host, with the default rule applied when none is chosen; duplicates keep the Host.
- [ ] Moving a Worker is refused while a Project has a started open Session or the Worker has an active Job, with the Tasks listed; an accepted move starts over on the new Host and the old Host's resources are removed.
- [ ] The web app warns about data loss before moving a Worker.
- [ ] With a disconnected Host, Jobs keep running on connected Runners; Docker work waits and resumes on reconnection; Restart, Force recreate, Logs and Rebuild answer "Host disconnected".
- [ ] Worker State shows `host_offline` when the Host is disconnected and no Runner is connected, and a banner otherwise.
- [ ] A used Host cannot be deleted; deleting a connected Host removes the Installation's resources from the machine and stops its Controller from reconnecting; deleting a disconnected Host warns about leftovers.
- [ ] Each Cleanup covers every Host, reports disconnected Hosts as pending and completes them on reconnection.
- [ ] `WORKER_STOP_ON_SHUTDOWN` stops containers on connected Remote Hosts too.
- [ ] `LOCAL_HOST=false` runs the backend without a Local Host.
- [ ] `scripts/deploy.sh host` sets up a machine as a Remote Host.
- [ ] The native app shows the Worker's Host and the `host_offline` state.
- [ ] `pnpm typecheck`, `pnpm test`, the Go tests and `pnpm test:e2e` pass.

## Out of Scope

- Copying Worker Volumes or Service Volumes between Hosts: a move starts over by decision, with a warning.
- Self-registration of Controllers with an installation-wide join token and approval: an Admin creates each Host, which is enough for team use.
- Running the Local Host through a Host Controller too: the local socket stays as it is, to keep single-container deployments unchanged.
- Restricting which Docker calls the backend may make on a Host: the backend already has full control of every Docker daemon it uses.
- Routing Runner, MCP and Git Proxy traffic through the Controller: the Controller already needs to reach the backend, so it would add a proxy without adding reach.
- Spreading one Worker's slots across several Hosts: a Worker's containers share one Worker Volume, which lives on one machine.
- Publishing the Controller image to a registry: the project builds its images locally from a clone.
- Host management in the native app: it stays in the web app, like Build history and container logs.

## Further Notes

- docker-modem accepts a custom HTTP agent; check during step 6 that hijacked `exec` requests and the build context upload go through `createConnection` of that agent, as they do for docker-modem's SSH agent.
- A Remote Host shared by several Installations works like the Local Host today: each Installation runs its own Controller container (with a distinct container name), and the Installation labels keep their resources apart.
