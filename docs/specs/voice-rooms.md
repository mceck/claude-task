# Voice Rooms

Each Task has a shared Voice Room where up to six Users talk simultaneously. Users join from the web app or native app and keep talking while navigating elsewhere. Audio travels directly between devices; the backend handles membership and connection negotiation.

## Concepts

A Voice Room belongs to one Task. Its participants are Users, each represented by one active connection and a fresh participation identifier. The room is available even when empty. Task Status and Agent assignment are independent of voice participation.

## Behaviour

### Joining and leaving

Every authenticated User can inspect and join a Task's room. Join requests first acquire microphone permission and enable local audio processing. A room accepts six Users, including the joining User. A seventh receives a room-full error. Opening a Task or subscribing to its events only observes the room.

A User participates in one room on one device at a time across the Installation. Joining elsewhere returns the current participation and asks for confirmation before transferring. The confirmed request names the participation being replaced, so a stale confirmation cannot replace a newer participation. Capacity and Task existence are checked before replacing the previous participation.

The room displays participant names, microphone mute state and each local connection's condition. Users can mute their microphone, silence incoming audio, retry failed peer connections and leave. Navigation preserves participation and displays persistent voice controls with a link back to the Task. Closing the client, ending its Login or deleting its Task releases participation. The last departure releases the room's transient state.

### Connection failures

Each participant connects directly to every other participant. With six Users, each device has five peer connections. Successful links remain usable when another link fails. The interface identifies each connecting, connected or unavailable peer and offers retry. A device marks a link unavailable after 20 seconds without a successful connection. It explains that the current network may prevent a direct connection.

Losing the signaling connection stops local audio and clears participation. The client explains the interruption and offers an explicit join after signaling reconnects. This prevents an old device from silently reclaiming participation after a transfer. A backend restart clears the in-memory rooms; clients recover through the same explicit join flow.

### Audio and platforms

Microphones request echo cancellation, noise suppression and automatic gain control through the platform's WebRTC implementation. Processing happens locally before transmission. Platform support and acoustic quality vary; users receive permission and capture failures as actionable errors. Incoming audio playback blocked by a browser requires an explicit resume action.

Web capture requires HTTPS or localhost. The native app uses the same signaling contract and interoperable WebRTC audio. iOS configures communication audio and the audio background mode. Android starts a microphone foreground service, with an ongoing notification, while the app is visible and microphone permission is granted. A User can continue an active room while another app is open or the screen is locked. Leaving, transfer, logout and connection loss stop capture and background resources.

Audio is live communication between Users. The Conversation and Agent Session retain their existing text-based delivery rules.

## Architecture

The authenticated live WebSocket carries join, leave, mute and peer-directed signaling commands. Shared types define the contract. Room snapshots reach participants directly and Task observers through the existing Task topic. An authenticated HTTP endpoint returns a room snapshot for initial loading, and join responses include the Installation's STUN configuration.

The backend keeps membership in memory and indexes it by User and connection. Each room's membership changes are synchronous after asynchronous Task validation. It validates command schemas and applies per-connection rate and message-size limits. Signaling accepts bounded offers, answers and ICE candidates only between current participants of the same room. Sender identity comes from the authenticated socket. Expired participation identifiers are rejected. Each negotiation has a fresh exchange identifier; peers discard candidates from older negotiations and buffer at most 64 candidates while awaiting a description. The participant whose identifier sorts first creates offers, including when its peer requests a retry.

```mermaid
flowchart LR
  A[Web User] <-->|Presence and signaling| B[Backend]
  C[Native User] <-->|Presence and signaling| B
  A <-->|Direct encrypted audio| C
  A -->|Address discovery| S[Configured STUN]
  C -->|Address discovery| S
```

STUN URLs are configured through `VOICE_STUN_URLS`, a comma-separated list of `stun:` or `stuns:` URLs; an empty value selects host candidates only. The default is `stun:stun.l.google.com:19302`. Configuration rejects relay URLs. Peers use the supplied STUN servers for address discovery and direct ICE candidates for audio transport.

## Data model

Room snapshots contain Task identity and participants. Each participant contains a fresh identifier, User identity and microphone mute state. Participation identifiers also scope signaling messages so delayed messages from a previous room cannot reach a new one. Room state, SDP and ICE data are transient. Persistent storage continues to hold Tasks, Users and Logins.

## Non-functional requirements

Each room accepts at most six Users. Client control messages accept up to 64 KiB; individual descriptions accept up to 16 KiB and candidate strings up to 2 KiB. Voice commands accept 120 messages per ten seconds per live connection, with at most 128 queued commands. Overloaded leave requests close the live connection and release membership. Media packets and audio processing remain on the participating devices. The existing live connection heartbeat removes dead clients. Server logs omit SDP, candidate payloads and microphone content.

## Decisions

- **A direct WebRTC mesh serves small rooms.** The six-person limit bounds device fan-out and keeps media off the backend.
- **STUN supports direct discovery.** The chosen P2P-only deployment accepts failed links on restrictive networks; the UI preserves working links and makes failures visible.
- **Existing live connections carry signaling.** Authentication, Login revocation and reconnect behavior stay consistent with the rest of the app.
- **Membership is transient.** Voice has no durable content; storing membership would retain stale participants after restarts.
- **Transfers require a current participation identifier.** Confirmation is deliberate and a delayed confirmation cannot evict a newer device.
- **Built-in local processing comes first.** Real-device audio checks determine whether later local filters are useful.

## Related specs

- [Clients](clients.md): navigation, live connections and persistent voice controls.
- [Users and authentication](users-and-auth.md): User identity and Login revocation.
- [Board](board.md): Task lifecycle.
- [Conversation](conversation.md): text communication and Agent delivery.
