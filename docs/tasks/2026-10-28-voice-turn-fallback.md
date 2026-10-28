---
status: done
---

# TURN fallback for Task Voice Rooms

## Specs

- [Voice Rooms](../specs/voice-rooms.md)
- [Clients](../specs/clients.md)

## Problem Statement

Some Users cannot connect to other participants from their networks because direct WebRTC connections fail behind restrictive NATs or firewalls. They need a relay while preserving direct media where it works and keeping media off the application backend.

## Solution

Offer coturn as an optional service in the main Docker Compose stack, enabled through an explicit `turn` profile. Normal deployment and development start without coturn or mandatory relay configuration. Configure its public hostname through a required environment variable with no default. Clients receive temporary credentials and let WebRTC choose a working direct or relayed path. Administrators can enable TLS transport when they provide a certificate and an available public TLS port.

## User Stories

1. As a User, I want voice to work when direct connections fail so that I can join from my network.
2. As a User, I want working direct connections to continue so that the relay is used when needed.
3. As a web or native User, I want the same TURN configuration so that both clients interoperate.
4. As a User, I want temporary relay credentials to renew during a long discussion so that expiry does not end my room.
5. As an Admin, I want a separate relay service so that audio avoids the application backend.
6. As an Admin, I want to supply the public hostname explicitly so that deployment assumes no domain.
7. As an Admin, I want authenticated allocations and bounded resources so that the relay is not open to anonymous use.
8. As an Admin, I want documented DNS, NAT, ports and TLS setup so that the public deployment is usable.

## Implementation Decisions

- Extend the shared ICE contract with optional username/password credentials and an expiry timestamp; accept relay candidates through existing bounded signaling.
- Mint coturn REST credentials using timestamped, User-specific random usernames and HMAC-SHA1. The shared secret stays on the backend and relay. Credentials last 24 hours by default, configurable from 5 minutes to 24 hours.
- Add an authenticated participation-scoped ICE refresh command. Both clients refresh before expiry and recreate peer connections with the new configuration. Stale participation requests return the existing stale error.
- Keep the current room membership, transfer, six-User limit and local noise processing.
- Configure TURN through environment variables. Leaving hostname, secret and TLS port unset keeps TURN disabled in the backend, including in development and normal Compose deployment; partial or invalid settings fail at startup. The optional relay entrypoint requires the hostname, secret and public IPv4 address explicitly when started. The hostname has no default in backend, Compose, scripts or example configuration.
- Add a service behind the explicit `turn` profile in the main Compose file with a pinned official coturn image, separate network, bounded UDP relay range, authenticated allocations and optional mounted TLS certificate. Generate its secret-bearing runtime configuration in temporary storage with restrictive permissions.
- Keep the application independent of the local relay service so a normal Compose launch needs no TURN settings and explicit backend settings may instead identify an independently deployed compatible relay.
- Protect loopback, link-local, private and multicast peer destinations in production and bound allocation count and bandwidth. Keep test-only local-address permissions outside production configuration.
- Document operator setup alongside the service, including external-IP forwarding, TLS on an explicitly configured public port, and direct-only deployment compatibility.

## Testing Decisions

- Public HTTP/WebSocket integration tests verify issued credentials, expiry, refresh, User separation, secret omission and relay candidate forwarding while existing isolation and payload limits hold.
- Environment configuration is tested at the public configuration loader for disabled, complete and invalid TURN settings.
- Browser tests use the real application, real coturn and synthetic microphones; force relay transport in the browser to prove received audio and selected relay candidates over both UDP and TCP. Ordinary voice tests continue to verify direct media.
- Flutter tests exercise the existing public controller/media boundary and verify that authenticated ICE configuration and renewal reach the media implementation. Flutter analysis and relevant builds check native compatibility.
- Validate Compose and exercise the production startup script, including missing required settings and authentication, without publishing or modifying a remote deployment.

## Acceptance Criteria

- [x] Living specs describe optional TURN fallback and its credential lifecycle.
- [x] TURN hostname is an explicit variable with no default; enabling the service without it fails clearly.
- [x] Normal Compose deployment and development work without TURN settings or relay startup; the explicit `turn` profile enables the separate service with authenticated allocations and documented ports, external IP and optional TLS.
- [x] Backend issues expiring User-specific credentials and omits the shared secret from all client messages.
- [x] ICE refresh is scoped to the current authenticated participation.
- [x] Web and Flutter retain TURN credentials, forward relay candidates and renew configuration before expiry.
- [x] Direct connections remain available with or without TURN configured.
- [x] Real browser audio succeeds through coturn using forced relay over UDP and TCP.
- [x] Relevant tests, typechecks, analysis, builds and review pass; external deployment limitations are reported.

## Out of Scope

Managed Cloudflare TURN, Lambda/Workers hosting, external DNS or firewall changes, certificate issuance, remote deployment, video, SFUs and recording.

## Further Notes

The User explicitly replaces the initial P2P-only decision with a separate self-hosted TURN service and will supply the hostname. The User keeps coturn optional, including in development: normal `docker compose up -d` omits it, and `--profile turn` explicitly enables it. TLS retains a separate optional overlay. The original voice-room task remains a record of that earlier delivery; the current living spec describes the resulting behavior.

## Verification

- Optional Compose profile: 429 backend tests passed, including six real Docker/Compose service checks; 3 existing opt-in external checks skipped. TypeScript typechecks pass. Default Compose includes only app and database with TURN settings absent or supplied. The explicit relay profile passes matching shell and dotenv settings to app and coturn; TLS publication is added only by its optional overlay. Required hostname validation is enforced by the relay entrypoint at startup. No client or media code changed in this follow-up. Standards and Task reviews report no findings.
- All 59 browser tests passed with real coturn enabled. Relay-only UDP and TCP tests verify received audio and selected relay candidates. The UDP test advances the browser clock and confirms credential renewal and continued audio. The six-User relay test verifies all fifteen links and five inbound audio streams per client with both TURN transports configured.
- All 183 Flutter tests passed, including authenticated ICE configuration and renewal through the existing media boundary. Flutter analysis and TypeScript typechecks pass. Production web/backend builds and the Android debug APK build pass.
- Actual Docker checks verify mandatory hostname configuration, missing TLS certificate errors and a TLS handshake using the production startup script and a temporary test certificate. Compose configuration and shell syntax are validated.
- Standards review has no unresolved findings. Task review findings on optional TLS publication and relay capacity were corrected; the final review reports no remaining substantive issues. Runtime tests also exposed the need for a concrete container/public IPv4 mapping and appropriate per-allocation bandwidth reservations; both are reflected in service configuration and living specs.
- No DNS, router/firewall, certificate issuance or remote deployment changes were made. The operator supplies the hostname without any default, the public IPv4 address and the shared secret. Real mobile background/voice quality and iOS compilation were not revalidated for this change.
