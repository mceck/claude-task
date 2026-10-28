---
status: done
---

# Task Voice Rooms on web and native clients

## Specs

- [Voice Rooms](../specs/voice-rooms.md)
- [Clients](../specs/clients.md)
- [Users and authentication](../specs/users-and-auth.md)
- [Board](../specs/board.md)
- [Conversation](../specs/conversation.md)

## Problem Statement

Users discussing a Task need to talk together without leaving the application or routing audio through its server. Both web and native Users need access, including continued mobile audio when navigating, switching apps or locking the screen.

## Solution

Provide an always-available Voice Room on each Task for six Users, with simultaneous speech, local audio processing and persistent controls. Use direct WebRTC links with configurable STUN discovery. Show individual connection failures clearly and preserve working links. A User joins one room from one device at a time and confirms transfers.

## User Stories

1. As a User, I want to enter a Task's Voice Room so that I can discuss its work immediately.
2. As a User, I want to see who is present before joining so that I can decide to participate.
3. As a User, I want everyone to speak simultaneously so that discussion feels natural.
4. As a User, I want browser and native participants to hear each other so that device choice is independent.
5. As a User, I want local noise suppression and echo cancellation so that others hear my voice clearly.
6. As a User, I want to mute my microphone so that I can temporarily stop transmitting.
7. As a User, I want to silence incoming audio so that I can pause listening.
8. As a User, I want voice controls while viewing other Tasks so that I can keep talking.
9. As a mobile User, I want active voice in the background and with the screen locked so that I can use my phone normally.
10. As a User, I want to confirm moving my participation to another device or Task so that I avoid accidental disconnections.
11. As a User, I want a full-room explanation so that I understand why I cannot enter.
12. As a User, I want to see which peers are unavailable so that I know who cannot hear me.
13. As a User, I want to retry a failed link while working links continue so that a network problem has limited impact.
14. As a User, I want clear microphone permission and playback errors so that I know how to recover.
15. As a User, I want logout and transfer to release my microphone so that an old client stops transmitting.
16. As an Admin, I want configurable STUN discovery and direct media so that the backend stays light.
17. As a User, I want voice to involve only Users so that Agent delivery remains intentional through Comments.

## Implementation Decisions

- Extend the shared real-time contract with validated membership commands, bounded peer signals, room projections, join acknowledgements and typed errors.
- Reuse the authenticated live WebSocket, including Origin validation and Login revocation; associate every command with its authenticated connection.
- Keep membership in memory, indexed by User and connection. Validate Task existence before admitting a participant and check capacity before transferring.
- Require the exact current participation identifier to confirm transfers. Use fresh identifiers for each participation and reject stale signaling.
- Return initial room snapshots through HTTP; publish presence to Task observers and directly to active participants so navigation does not stop voice.
- Configure STUN through the backend environment and reject TURN URLs. Keep all audio processing and transport on clients.
- Use deterministic offer ownership and ordered asynchronous processing per peer, including buffered ICE candidates and explicit retries.
- Keep voice controllers above Task navigation in both clients. Dispose media on leave, logout, transfer, signaling loss and Task deletion.
- Use browser WebRTC APIs and the Flutter WebRTC plugin. Configure native microphone permissions, iOS communication audio/background mode, Android microphone foreground service and desktop microphone entitlements.
- Use existing UI conventions for participant names, mute/deafen, connection status, retry, transfer confirmation and persistent controls.
- Task Status is independent of voice. No database migration is needed.

## Testing Decisions

- The primary seam is authenticated HTTP plus real WebSocket clients against the existing real-Postgres backend harness. Verify presence, signaling isolation, membership, transfer races, capacity, cleanup, invalid payloads and Login revocation through public APIs.
- Browser Playwright tests use synthetic microphones in independent authenticated contexts. Verify real peer connection and received audio, mute, navigation, transfers and cleanup, plus a deliberately failed link.
- Flutter controller/widget tests use a replaceable media boundary and fake live connection to verify visible actions, protocol compatibility and resource cleanup without native hardware.
- Run TypeScript typechecks, focused tests during implementation, Flutter analysis and relevant native builds, then full suites after review.
- Physical iOS/Android checks cover screen lock, background audio, Bluetooth routing and actual acoustic quality. Automated tests and builds cannot certify those hardware behaviors; report available and unavailable verification explicitly.

## Acceptance Criteria

- [x] Task and living specs describe the agreed behavior and architecture.
- [x] Authenticated web and Flutter Users can observe and join the same Task Voice Room.
- [x] Six Users can participate; a seventh is rejected without disrupting existing membership.
- [x] Each User has one active participation; transfer requires confirmation and safely replaces the expected participation.
- [x] Signaling reaches only current peers in the same room and rejects malformed, oversized, stale and excessive messages.
- [x] Audio uses direct WebRTC with configurable STUN and local built-in processing.
- [x] Both clients expose mute, incoming-audio silence, individual connection status, retry and leave.
- [x] Voice survives Task navigation and provides persistent controls and a route back to its Task.
- [x] Native microphone permissions, iOS audio configuration/background mode and Android foreground service support ongoing background voice.
- [x] Leave, transfer, disconnect, logout and Task deletion release membership and local media.
- [x] Failed peer links are visible while successful links remain usable.
- [x] Public-API tests, browser media checks and Flutter tests cover the implemented behavior; verification limitations are reported.
- [x] Changes are reviewed, required automated checks pass and the work is committed.

## Out of Scope

TURN, SFUs, audio relaying, video, screen sharing, ringing, recordings, transcription, Agent audio, advanced custom denoising and automatic rejoining after signaling loss.

## Further Notes

The user explicitly accepts direct connection failures on restrictive networks to keep server media load at zero. This task follows the design interview in this conversation and authorizes implementation immediately after documentation.

## Verification

- Backend: 412 tests passed; 3 opt-in external/Docker checks skipped.
- Browser: all 56 Playwright tests passed, including five voice checks. The six-User check verifies five inbound audio streams on every client, covering all fifteen direct peer links.
- Native: all 181 Flutter tests passed, including six Voice Room tests. The two affected desktop golden images were inspected and updated for the room strip.
- TypeScript typechecks, Flutter analysis and whitespace checks pass. Production web/backend builds and the Android debug APK build pass.
- Standards and Task reviews found four distinct issues: stale HTTP presence, an unbounded leave queue, late native admission after timeout, and obsolete native background teardown. All were corrected and regression-tested; follow-up reviews report no unresolved findings.
- The iOS simulator build was attempted but dependency resolution was interrupted: the 686 MB upstream WebRTC framework downloaded at about 20 KB/s. iOS compilation remains unverified. Physical checks of screen lock, background audio, Bluetooth routing and actual microphone/noise quality were not performed. Those checks remain a release verification requirement.
