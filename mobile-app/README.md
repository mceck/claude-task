# Claude Task native app

Flutter conversation frontend for the existing Claude Task installation. Projects appear in a rail, Tasks are grouped by their real Status, and a Task opens its Timeline. Wide windows show all three panes (and details from 1500 px); phones use successive screens. The React administration interface remains available.

## Develop and verify

Use Flutter 3.47.6 / Dart 3.13.5 or newer; `.tool-versions` pins the verified Flutter SDK. Dart dependencies are locked in `pubspec.lock`; iOS and macOS use Swift Package Manager with checked-in `Package.resolved` files. CocoaPods is no longer required. From the repository root:

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
flutter test integration_test/task_description_test.dart -d macos
flutter build macos --debug
flutter build apk --debug
flutter build ios --simulator --debug
```

From the repository root, backend verification uses real PostgreSQL:

```sh
pnpm typecheck
pnpm --filter @claude-task/backend exec vitest run test/mobile.test.ts
pnpm test
```

The integration smoke has a separate Keychain service and temporary cache, so it does not use the normal app profile.

## Task description editor

Create Task and Edit Task use a native Fleather editor with the app's graphite theme, terracotta selection and Geist typography. The formatting toolbar scrolls horizontally on phones; Write, Markdown and Preview share the same description. The backend continues to receive a Markdown string.

The visual editor supports headings 1–6, bold, italic, strikethrough, inline code, links, bullet/numbered lists, nested lists, checklists, simple quotes and dividers. Code blocks have a language field and a dedicated editor; tables have an editable Markdown block. Image URLs are retained, including existing alt text and titles, and displayed as linked cards without automatically fetching remote images. Uploading new attachments is outside this field.

Opening a description, changing the selection or switching modes does not rewrite its source. After a visual edit, Markdown spacing and delimiters may be normalized. Structures the visual document cannot represent (for example nested blockquotes, hard line breaks, titled links, inline images and multi-paragraph list items) open in Markdown mode with Preview available, preserving the original content. `markdown_document_test.dart` checks parsing and serialization against rendered Markdown; editor tests cover formatting, undo/redo, dialogs and real task form submissions. Layout goldens cover phone and desktop forms, with additional keyboard-inset checks.

Fleather uses `^1.28.0`, locked to 1.28.0, with the standalone `material_ui` and `cupertino_ui` packages. The app and editor share these components; `Md` wraps `flutter_markdown_plus` in a scoped compatibility bridge while that package still uses the SDK's Material widgets. AppFlowy Editor 6.2 was evaluated but requires `file_picker ^10.2.0`, conflicting with the app's existing `^13.2.0`; no dependency override or downgrade was introduced.

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

All five native projects are present. A web scaffold is also included, but browser support is outside the native app verification below.

| Target | Requirements and verification |
| --- | --- |
| macOS | macOS 12+, Xcode and Swift Package Manager. Network-client and selected-file entitlements are included. Debug build verified locally; native smoke verified (see Verification record). Distribution requires appropriate signing/notarization. |
| iOS | iOS 15+, Xcode and Swift Package Manager. Uses the UIScene lifecycle. Simulator debug build verified; distribution requires an Apple team, bundle ID, signing profiles and APNs capability for push. No phone delivery/signing validation on this host. |
| Android | Android SDK/Java and accepted SDK licenses. Uses Gradle 9.3.1, AGP 9.1.1 and built-in Kotlin with compiler 2.4.0. Debug APK build verified; no physical-device verification. Google Play services are needed for FCM. Distribution requires signing configuration; the generated release setup still uses the development signing key until replaced. |
| Windows | Flutter Windows toolchain and Visual Studio C++ desktop workload on Windows. Scaffolded; not built on macOS. |
| Linux | Flutter Linux toolchain, GTK development libraries and libsecret/keyring. Scaffolded; not built on macOS. |

## Verification record

Real phone delivery remains an external verification step until deployment-specific Firebase/APNs credentials, application IDs, signing and a phone are supplied. Passing a fake-transport test does not constitute real phone push verification.

Flutter 3.47.6 / Dart 3.13.5 verification on the macOS development host (2026-10-26):

- `flutter analyze`: no issues. `flutter test`: 68 tests passed, including phone/desktop layout goldens and Markdown theme compatibility.
- `flutter test integration_test/native_smoke_test.dart -d macos` passed after the Swift Package Manager migration (real Keychain and file-storage plugins, fake API), including a successful macOS debug build.
- `flutter build apk --debug` and `flutter build ios --simulator --debug` succeeded. Android reports an upstream `firebase_core` Kotlin Gradle Plugin migration warning; the build passes.
- `pnpm --filter @claude-task/frontend build` succeeded.
- Windows and Linux remain scaffolded only. Physical phone execution, distribution signing and real phone push have not been verified.

Earlier backend verification, before the Flutter SDK migration: `pnpm typecheck` passed for all packages. `backend/test/mobile.test.ts` and the rest of the backend suite passed, except one test belonging to the separate, in-progress Task attachments work (`sessions.test.ts`, "stores uploads on the task…"). These backend checks were not rerun for the SDK migration.
