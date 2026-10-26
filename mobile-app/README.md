# Claude Task native app

Flutter conversation frontend for the existing Claude Task installation. Projects appear in a rail, Tasks are grouped by their real Status, and a Task opens its Timeline. Wide windows show all three panes (and details from 1500 px); phones use successive screens. The React administration interface remains available.

## Develop and verify

Use Flutter 3.38.3 / Dart 3.10.1 or newer. Dependencies and platform pod versions are locked. From the repository root:

```sh
pnpm install
pnpm dev:backend
```

In a second terminal:

```sh
cd mobile-app
flutter pub get
flutter run -d macos --dart-define=BACKEND_URL=http://localhost:3000
```

`BACKEND_URL` prefills the login field; the User can enter the installation URL. Enter the origin only (`https://tasks.example.com`), with no `/api`, credentials or query string. One installation and User are active at a time; log out to switch. The backend uses the same HttpOnly `ct_login` Login and `x-claude-task` mutation header as the web frontend. Native HTTP and WebSocket requests explicitly carry the cookie. Passwords are not saved. Forced password changes and expired Logins use the existing API rules.

Use HTTPS for deployed installations. Android emulator localhost is `10.0.2.2`; a physical phone needs a reachable installation URL. Development HTTP may require a debug-only Android network security exception or an iOS ATS exception for your local host. The release manifests do not enable unrestricted cleartext traffic. Reverse proxies must forward `/api/v1/ws` upgrades.

```sh
flutter analyze
flutter test
# Builds and launches the native application; uses fake API data with real native storage plugins.
flutter test integration_test/native_smoke_test.dart -d macos
flutter build macos --debug
```

From the repository root, backend verification uses real PostgreSQL:

```sh
pnpm typecheck
pnpm --filter @claude-task/backend exec vitest run test/mobile.test.ts
pnpm test
```

The integration smoke has a separate Keychain service and temporary cache, so it does not use the normal app profile.

## Local conversations and drafts

Fetched Projects, Task lists, Task details and persisted Timeline pages are saved under application support, isolated by a hash of installation origin and User ID. Transient streaming text and Thinking stay in memory. The native Keychain / platform secure store holds the Login material. macOS uses the legacy Keychain without Keychain Sharing, allowing local development without a provisioning profile. Linux needs a working Secret Service / keyring (`libsecret`) in addition to the normal Flutter GTK toolchain.

A draft is saved per Task, including its Internal Note flag and attachment metadata. Selected files are copied into the active profile so they remain available after restarting. They remain local until a manual Send. Offline conversations remain readable; attachments are available only after downloading. Logout removes the active profile's cache, draft files, downloaded attachments and Login.

Failed sends preserve drafts. A timeout, interrupted connection or server error is treated as an unknown submission outcome. **Refresh and review** refetches the conversation, after which the User may remove the saved draft if the Comment exists or explicitly send again. Reconnect never submits Comments or Task mutations automatically. Read positions advance only when the active, visible conversation reaches its latest persisted entry; receiving data alone does not mark it read.

If logout happens offline, local data is cleared immediately and the old Login is held only in secure storage for revocation on the next connection. Provider token deletion is attempted as well. Remote revocation cannot happen without connectivity; pending revocations are never treated as active Logins.

## Phone push configuration

Phone push uses real **Firebase Cloud Messaging HTTP v1**, including APNs alert payloads for iOS. It requires deployment credentials and native identifiers. Without backend credentials or mobile Firebase options, the app reports an unconfigured state and continues providing conversations and unread indicators. A fake sender is used only by backend tests.

1. Create a Firebase project and enable the Cloud Messaging API. Register Android and iOS applications with the identifiers you will actually sign and distribute. Current scaffold identifiers are `com.claudetask.claude_task_mobile` (Android) and `com.claudetask.claudeTaskMobile` (iOS). Update the Android namespace/applicationId and iOS bundle ID before distributing under your organization.
2. Create a service account authorized to send FCM messages. Mount its JSON **outside the repository and app bundle**, read-only on the backend, and set `FCM_SERVICE_ACCOUNT_FILE=/run/secrets/firebase-service-account.json`. Restart the backend. `GET /api/v1/notifications/status` reports `configured: true` when a transport is initialized; this is configuration status, not proof of successful provider authentication or delivery.
3. For iOS, upload an APNs authentication key/certificate to the Firebase project's Cloud Messaging settings. Select your Apple Developer team in `ios/Runner.xcworkspace`, enable Push Notifications and Background Modes → Remote notifications, and obtain a provisioning profile for the exact bundle identifier. The scaffold includes development `aps-environment` and remote-notification background mode; production signing must select the production APNs environment.
4. Supply the public client Firebase options for **each platform** using a local JSON file (ignored by Git):

```json
{
  "BACKEND_URL": "https://tasks.example.com",
  "FIREBASE_PROJECT_ID": "your-project",
  "FIREBASE_API_KEY": "public-client-api-key",
  "FIREBASE_APP_ID": "1:123456789:ios:your-app-id",
  "FIREBASE_SENDER_ID": "123456789",
  "FIREBASE_IOS_BUNDLE_ID": "com.yourcompany.claudeTask"
}
```

```sh
flutter run -d <phone-id> --dart-define-from-file=firebase-options.json
flutter build apk --dart-define-from-file=firebase-options.json
flutter build ipa --dart-define-from-file=firebase-options.json
```

Use the Android Firebase App ID in the Android options file; leave `FIREBASE_IOS_BUNDLE_ID` out there. Flutter initializes Firebase explicitly from these options, so no generated `firebase_options.dart` is needed. If your deployment uses native `google-services.json` / `GoogleService-Info.plist`, keep them ignored and align them with the same Firebase project and app IDs. Never place the service-account JSON in the Flutter application.

5. Sign in on a real phone, open Profile → **Enable notifications**, and grant permission. Android includes `POST_NOTIFICATIONS`; iOS must successfully register with APNs before obtaining an FCM token. A declined permission leaves unread indicators working. Token rotations are sent to the authenticated device registration; already-authorized phones re-register on login/app restore.
6. Follow a Task, assign an Agent and complete a Turn. Verify the generic alert while the app is backgrounded and fully exited, tap it, and check that the right Project/Task opens after authentication. Repeat for a failed Turn and a failed Job requiring intervention; test mute, unfollow and logout. OS force-stop restrictions still apply.

Lock-screen text is generic and contains no Project names, Task titles, Comment text, prompts or secrets. Data carries the Task identifier for authenticated navigation. Preferences/read changes are sent on the User's private WebSocket topic, not to other Users. Registration tokens are encrypted at rest using `SECRETS_MASTER_KEY` and are never returned by the API. Deleting a Login cascades to its devices, including password reset, deactivation and logout.

Notification events and per-User/device work are inserted in the same database transaction as persisted Turn completion/failure or failed Job lifecycle transitions. Notifications are not generated from stream fragments or by inspecting prose. Dispatch rechecks following, mute, active User, current token and Login expiry. Stable event identifiers and provider collapse IDs deduplicate alerts. A committed claim is reserved before contacting FCM: only definite retryable rejections reopen it (exponential backoff, at most six attempts, within 24 hours). Unknown transport outcomes and crash-interrupted claims are not replayed, preventing repeated alerts for an already accepted Turn; a rare lost alert remains visible as unread in the app. Invalid registrations are deleted. Desktop push while fully exited is outside this version.

See the official [Flutter FCM setup](https://firebase.google.com/docs/cloud-messaging/flutter/client) and [FCM HTTP v1 delivery](https://firebase.google.com/docs/cloud-messaging/send/v1-api).

## New authenticated API contracts

The existing backend endpoints are reused for login, Tasks, Comments/attachments, Timeline and Session controls. `shared/src/mobile.ts` defines the new TypeScript contract; matching Dart models live in `lib/src/models.dart`.

| Endpoint | Behavior |
| --- | --- |
| `GET /projects/:id/task-preferences` | This User's following/mute/read/unread state for every Task, including archived Tasks. |
| `GET /tasks/:id/preferences` | This User's Task preference. |
| `PATCH /tasks/:id/preferences` | Set `following` and/or `muted`. Explicit unfollow and mute survive later automatic-follow triggers. |
| `PUT /tasks/:id/read-position` | Advance monotonically to a persisted `itemId` in this Task. Does not follow the Task. |
| `GET /notifications/status` | Honest provider configuration state. |
| `PUT /notifications/devices` | Register or rotate `{deviceId, platform: ios\|android, token}` for this Login. |
| `DELETE /notifications/devices/:id` | Remove only this User's registration. |

Paths are relative to `/api/v1`. Subscribe to `user:<authenticated-user-id>` for `task.preference` events; other User topics are refused. Positions are decimal bigint strings, avoiding timestamp/device-clock and numeric precision problems. Timeline HTTP responses include each entry's `readPosition`. Creating a Task with an Agent makes two requests: POST Task, then PATCH `{version, agentId}`. A failed assignment retains and opens the created Task; Retry assignment never repeats POST.

## Platforms and signing

All five native projects are present; no Flutter browser project is generated.

| Target | Requirements and verification |
| --- | --- |
| macOS | macOS 12+, Xcode and CocoaPods. Network-client and selected-file entitlements are included. Debug build verified locally; native smoke verified (see Verification record). Distribution requires appropriate signing/notarization. |
| iOS | iOS 15+, Xcode/CocoaPods, Apple team, bundle ID and signing profiles; APNs capability for push. Scaffolded; no phone delivery/signing validation on this host. |
| Android | Android SDK/Java, accepted SDK licenses, Google Play services for FCM, signing configuration for distribution. Scaffolded; no physical-device/build verification claimed. The generated release setup still uses the development signing key until replaced. |
| Windows | Flutter Windows toolchain and Visual Studio C++ desktop workload on Windows. Scaffolded; not built on macOS. |
| Linux | Flutter Linux toolchain, GTK development libraries and libsecret/keyring. Scaffolded; not built on macOS. |

## Verification record

Real phone delivery remains an external verification step until deployment-specific Firebase/APNs credentials, application IDs, signing and a phone are supplied. Passing a fake-transport test does not constitute real phone push verification.

Results on the macOS development host (2026-10-26):

- `flutter analyze`: no issues. `flutter test`: 19 tests passed.
- `flutter test integration_test/native_smoke_test.dart -d macos` passed (real Keychain and file-storage plugins, fake API) and `flutter build macos --debug` succeeded.
- `pnpm typecheck` passes for all packages. `backend/test/mobile.test.ts` and the rest of the backend suite pass, except one test belonging to the separate, in-progress Task attachments work (`sessions.test.ts`, "stores uploads on the task…").
- iOS, Android, Windows and Linux are scaffolded only; they were not built here. Real phone push has not been verified.
