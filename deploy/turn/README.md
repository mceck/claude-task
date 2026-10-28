# Optional TURN relay

Use this service when Voice Room participants cannot connect directly. WebRTC keeps direct links when possible and can relay encrypted audio through coturn. The application backend handles signaling and temporary credentials; it does not relay media.

## Configure

Add the entries from [.env.example](.env.example) to the existing root `.env`, preserving the application's existing variables.

- `VOICE_TURN_HOST`: the public DNS hostname, without scheme, port or path. **Required, with no default.** Set its DNS A record to the relay's public IPv4 address. Use DNS-only mode if the DNS provider offers an HTTP proxy.
- `VOICE_TURN_SECRET`: at least 32 base64 or hexadecimal characters, shared by backend and coturn. Generate a new secret with `openssl rand -hex 32`. Keep it in the ignored `.env`, not in source control.
- `VOICE_TURN_EXTERNAL_IP`: the public IPv4 address coturn advertises. Required by the additional service. If the host is behind a router, use its public address and forward the ports below unchanged. A server behind upstream CGNAT needs a public-IP host or suitable port forwarding from its provider.
- `VOICE_TURN_PORT`: public UDP/TCP listener, default `3478`.
- `VOICE_TURN_TLS_PORT`: optional public TCP TLS port. Leave empty to disable TLS; set it to an available port such as `5349` or `443` to enable TLS.
- `VOICE_TURN_CERTS_DIR`: directory containing `fullchain.pem` and `privkey.pem` for the configured hostname. Defaults to `./deploy/turn/certs`; files are mounted read-only. Required and readable by the container user when TLS is enabled. Certificate issuance is managed by the operator.
- `VOICE_TURN_TTL_SECONDS`: lifetime of temporary credentials, default `86400` (24 hours), range `300` through `86400`. Clients refresh halfway through the lifetime and renew their peer connections.

The backend also accepts these `VOICE_TURN_*` settings in its own environment when run outside Compose. `VOICE_TURN_EXTERNAL_IP` and `VOICE_TURN_CERTS_DIR` are used only by the relay deployment. Leaving hostname, secret and TLS port unset keeps TURN disabled in the backend, including in development. Partial backend configuration fails at startup. Starting the optional relay requires the hostname, secret and external IP explicitly; its entrypoint rejects missing values without inventing a hostname.

## Start

```sh
docker compose --profile turn up -d --build
```

For TLS, also include its port-publication overlay after setting `VOICE_TURN_TLS_PORT` and installing the certificate:

```sh
docker compose -f docker-compose.yml -f docker-compose.turn-tls.yml --profile turn up -d --build
```

Normal `docker compose up -d --build` starts only the application and database. The `turn` profile explicitly adds coturn; it publishes no TLS port unless the TLS overlay is also included. The TLS overlay requires an explicit public TLS port. The application has no dependency on coturn, so it can also use an independently deployed compatible relay by configuring its hostname and shared secret without enabling the local profile.

In development, use the normal application commands and leave `VOICE_TURN_HOST`, `VOICE_TURN_SECRET` and `VOICE_TURN_TLS_PORT` unset. Voice then uses direct connections and configured STUN discovery.

The main Compose stack runs pinned `coturn/coturn:4.18.0-r0` on a separate network, with a read-only root filesystem and temporary runtime configuration. The secret is written only to a mode-0600 file in container temporary storage. Anonymous allocations and the administration interface are disabled.

Allow inbound traffic at the host firewall and router:

| Public port | Protocol | Purpose |
| --- | --- | --- |
| `VOICE_TURN_PORT` (default `3478`) | UDP and TCP | STUN/TURN listener |
| `30000-30199` | UDP | Relayed media; preserve the same port numbers through NAT |
| `VOICE_TURN_TLS_PORT`, when enabled | TCP | TURN over TLS; mapped to container `5349` |

TURN over TCP and TLS still uses the UDP relay range for traffic between the relay and the remote peer. All listed relay ports must therefore be reachable even when clients reach coturn using TCP or TLS. The 200-port range bounds the number of simultaneous relay allocations; increase both the configuration range and Compose mappings together if the installation outgrows it.

For networks that block ordinary TURN ports, TLS on public TCP 443 is useful. That port must be available for TURN: an ordinary HTTP reverse proxy does not proxy this protocol. If HTTPS already occupies 443 on the same IP, use another public IP or an explicitly configured TCP/SNI proxy, or choose a different TLS port. A certificate must match `VOICE_TURN_HOST`. After certificate renewal, restart the `turn` service so it loads the updated files.

Production relay destinations exclude loopback, private, link-local and multicast networks. Allocations are limited to 64 per temporary username and 1000 overall, with 64 KiB/s per-allocation and 10 MiB/s overall bandwidth caps. Media remains encrypted by WebRTC through the relay.

## Verify

```sh
docker compose --profile turn logs --tail=50 turn
```

Join the same Task's Voice Room from two different networks. A connected state confirms a working ICE path; it can be direct or relayed. To diagnose TURN specifically, inspect the selected ICE candidate pair in the browser's WebRTC diagnostics (`chrome://webrtc-internals` in Chromium) and check for a `relay` candidate.

The opt-in browser regression starts a real local coturn service and forces relay transport. It verifies received audio and selected relay candidates over UDP and TCP. Its local-address exception is confined to the test configuration. A host IPv4 interface is detected for the fixture, or supplied through the test-only `VOICE_TURN_E2E_HOST`.

```sh
VOICE_TURN_E2E=1 pnpm --filter @claude-task/frontend exec playwright test e2e/voice.spec.ts
```
