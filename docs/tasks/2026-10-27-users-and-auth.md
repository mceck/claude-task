---
status: done
---

# Users and authentication

## Specs

- [Users and authentication](../specs/users-and-auth.md)

## Problem Statement

The team wants a self-hosted board whose Tasks are worked by Claude Code Agents. Before anyone can use it, the installation needs to know who is using it and keep everyone else out. Some actions (managing Users, Agents, Credentials, Extensions, Git Connections, project secrets, permanently deleting Projects) can leak secrets, cost money or destroy data, so only trusted people should reach them. A new installation must be usable right away without a setup wizard, an installation whose Admins are all locked out must be recoverable, and both the web app and the native Flutter app must authenticate against the same backend.

## Solution

Users log in with email and password. Each User is an Admin or a Member; every active User sees every Project, and Admins also administer the platform. A Login is a server-side session identified by an opaque `HttpOnly` cookie that expires after 30 days without activity and ends immediately on logout, password change (other Logins), password reset and deactivation, closing live connections with it. Admins create Users with temporary passwords that must be replaced at first login, reset passwords, change roles and deactivate Users, while the platform always keeps one active Admin. The first Admin comes from `ADMIN_EMAIL` and `ADMIN_PASSWORD` on first boot, and a `create-admin` command creates or promotes an Admin from the command line. Mutating requests carry a custom header against cross-site request forgery, and failed logins are rate limited. The Flutter app reuses the same Login cookie, kept in the platform's secure storage.

## User Stories

1. As the person deploying the app, I want the first Admin to be created from environment variables on first boot, so that I can log in immediately without a setup wizard.
2. As the person deploying the app, I want those variables to be ignored once any User exists, so that changing them later can't create surprise accounts.
3. As the person deploying the app, I want a command-line command that creates an Admin, so that I can set up an installation without the environment variables.
4. As the person deploying the app, I want the same command to promote and reactivate an existing User, so that I can recover access when every Admin is locked out or deactivated.
5. As the person deploying the app, I want the command to generate and print a temporary password when I give none, so that I never have to put a password on the command line.
6. As a User, I want to log in with my email and password, so that only team members can access the app.
7. As a User, I want my email matched regardless of letter case, so that typing it differently doesn't lock me out.
8. As a User, I want my Login to persist across browser restarts and stay alive while I use the app, so that I don't have to log in constantly.
9. As a User, I want an unused Login to expire after 30 days, so that a forgotten browser doesn't stay signed in forever.
10. As a User, I want to log out, so that I can end my Login on a shared machine.
11. As a User, I want logging out on one device to leave my other devices signed in, so that I only end the Login I meant to.
12. As a User, I want to be sent back to the page I wanted after logging in, so that shared links work even when my Login expired.
13. As a User, I want to change my own password by confirming my current one, so that I can keep my account secure.
14. As a User, I want changing my password to log out my other devices, so that anyone using my old password loses access.
15. As an Admin, I want to create a User with a generated or chosen temporary password, so that I can onboard teammates.
16. As an Admin, I want the temporary password shown once with a copy button, so that I can hand it over and it doesn't linger in the app.
17. As a new User, I want to be forced to change my temporary password at first login, so that the Admin doesn't know my real password.
18. As a new User with a temporary password, I want every other part of the app to wait until I've chosen my password, so that the temporary one is never used for real work.
19. As an Admin, I want to assign the Admin or Member role, so that only trusted people manage Agents, Credentials, Extensions, Git Connections and secrets.
20. As an Admin, I want role changes to take effect on the User's next request, so that I don't have to wait for them to log out.
21. As an Admin, I want to deactivate a User, so that a departing teammate loses access immediately, open connections included.
22. As an Admin, I want a deactivated User's Comments, Revisions and Tasks to keep their name, so that history stays readable.
23. As an Admin, I want to reactivate a User with their existing password, so that a returning teammate can log in again.
24. As an Admin, I want to reset another User's password to a new temporary one, so that I can help someone who forgot theirs, logging them out everywhere.
25. As an Admin, I want the platform to refuse demoting or deactivating the last active Admin, so that the team never loses administration of the app.
26. As an Admin, I want concurrent demotions to leave at least one Admin and give every request a clean answer, so that two Admins acting at once can't lock everyone out.
27. As an Admin, I want duplicate emails refused regardless of letter case, so that one person never ends up with two accounts.
28. As a User, I want to see the list of team members, so that I can assign Tasks to people and recognise authors.
29. As a Member, I want admin-only pages and actions hidden from my navigation, so that the app shows me what I can actually do.
30. As an Admin, I want Members' attempts at admin-only actions refused with `403`, so that hiding a button is never the only protection.
31. As an operator, I want failed logins limited per email and per IP, so that passwords can't be guessed at speed.
32. As an operator, I want wrong passwords, unknown emails and deactivated accounts to get the same answer in the same time, so that the login form reveals nothing about who has an account.
33. As an operator, I want every state-changing request to require a custom header, and WebSocket handshakes from other origins refused, so that other sites can't act on a User's behalf.
34. As an operator, I want Login tokens stored only as hashes, so that a database leak doesn't hand out live Logins.
35. As a mobile User, I want to enter my installation's URL at login, so that the app works with our self-hosted backend.
36. As a mobile User, I want my Login kept in the device's secure storage and my password never stored, so that a lost phone exposes as little as possible.
37. As a mobile User, I want an expired Login to send me back to the login screen with an explanation, so that I know why I was signed out.
38. As a mobile User, I want logging out while offline to revoke the Login as soon as the backend is reachable again, so that it doesn't stay valid on the server.
39. As a User, I want my phone to stop receiving push notifications for me once I log out there, so that the next person using it doesn't see my Tasks.

## Implementation Decisions

- **Auth module**: argon2id password hashing, server-side Logins, login and logout, password change, the request guard and an in-memory login rate limiter. Interface for other modules: the authenticated User on the request, or `401`; routes declare their access level (public, any User, Admin), whether they stay reachable during a forced password change, and whether they skip the CSRF check (machine endpoints authenticated by tokens).
- **Logins**: 256-bit random token in the `ct_login` cookie (`HttpOnly`, `SameSite=Lax`, path `/`, `Secure` unless `COOKIE_SECURE=false`, 30-day lifetime); only its SHA-256 hash is stored, with created, last seen and expiry times. Sliding 30-day expiry written at most once a minute, re-sending the cookie when written. Expired Logins purged hourly. A Login of a deactivated User resolves to nothing.
- **Ending Logins**: logout ends the current one; password change ends all others; reset and deactivation end all of the User's. After commit, the realtime hub closes the matching WebSocket connections with code `4001`. Push device registrations are tied to the Login they were made with and are removed with it.
- **Forced password change**: a "must change password" flag on the User. While set, only reading the current User, changing the password and logging out are reachable; everything else gets `403` `password_change_required`, including the WebSocket handshake.
- **Password rules**: 8 to 200 characters, and different from the current one on change. Generated temporary passwords are 16 URL-safe random characters.
- **Users module**: team list for every User; create, update (display name, role, active) and reset password for Admins. The "at least one active Admin" rule locks all active Admin rows in id order before the target row, so concurrent changes serialize instead of deadlocking.
- **Bootstrap and CLI**: on startup, with zero Users and both `ADMIN_EMAIL` and `ADMIN_PASSWORD` set, an active Admin is created (display name `ADMIN_NAME`, default "Admin"). The `create-admin` command (email required, optional password or `ADMIN_PASSWORD`, optional name) runs migrations and creates or promotes-and-reactivates by case-insensitive email.
- **CSRF**: the `x-claude-task` header on every request with a method other than GET, HEAD or OPTIONS, checked before authentication (`403` `csrf`); the WebSocket handshake checks that a present `Origin` matches the backend host.
- **Rate limiting**: fixed 15-minute windows of failed attempts per IP and per email, 10 allowed; then `429` `rate_limited` with `Retry-After`. A success clears the email counter. Client IP from `X-Forwarded-For` only with `TRUST_PROXY=true`.
- **API contract**: login, logout (always `204`), current User, change password; Users list, create (`201` with the temporary password), update, reset password (with the temporary password). Errors share the `error` object with `code`, `message` and optional `details`. Emails unique case-insensitively at the database level.
- **Web app**: login page with `next` redirect; a layout that checks the current User, redirects to login on `401` and to the change-password screen while the flag is set; change-password screen (forced and voluntary, new password typed twice); Users admin page with role select, status badges (Active, Invited, Deactivated), reset and deactivate actions with confirmations, and a one-time temporary password dialog. Admin entries of the sidebar shown to Admins only.
- **Flutter app**: validated installation URL, login reading the `ct_login` value from the response, Login (cookie, URL, User, device id) in secure storage, cookie and CSRF header sent explicitly on HTTP and WebSocket, refreshed cookie stored, `401` ends the local Login, pending logout kept for retry when the backend is unreachable, profile data cleared on logout.

## Testing Decisions

- Seam 1, the backend public API against real Postgres: login and the cookie attributes, sliding expiry and cookie re-send, case-insensitive email, uniform `401`, `401` without a Login, CSRF refusal, logout ending the Login and its WebSocket, password change rules and ending other Logins, forced password change gating HTTP and WebSocket, per-email and per-IP rate limits (each with its own app because the limiter lives in memory), User creation with generated and chosen temporary passwords, duplicate emails, team list for Members, `403` for Members on admin routes, promotion, deactivation (Logins and WebSocket closed, login refused, history kept), reactivation, reset, the last-Admin rule including concurrent demotions, unknown User `404`, and first boot without `ADMIN_EMAIL` with the `create-admin` command run as a real process. Prior art: the auth and users test files with the shared API client and WebSocket test client.
- Push registration lifecycle tied to Logins is covered by the mobile notification tests at the same seam.
- Seam 3, Playwright against the real backend: logging in to the Projects list, the forced change of a temporary password, and being sent to login when the Login expired while the live connection was down.
- Flutter tests with fake API and storage: login storing only cookie, installation and User and requiring authentication on expiry; the temporary password gating access; native HTTP keeping the `HttpOnly` cookie and sending authentication and CSRF headers; installation URL validation; cache isolation per installation and User and deletion on logout.

## Acceptance Criteria

- [x] On a fresh database with `ADMIN_EMAIL` and `ADMIN_PASSWORD` set, that Admin can log in; without them nobody can, and the `create-admin` command creates an Admin who can.
- [x] `create-admin` prints a temporary password when none is given, and promotes and reactivates an existing User by case-insensitive email.
- [x] Login sets an `HttpOnly`, `SameSite=Lax` cookie with a 30-day lifetime, re-sent when activity extends the Login.
- [x] Wrong passwords, unknown emails and deactivated accounts get the same `401`.
- [x] After 10 failed attempts in 15 minutes for an email or an IP, further attempts get `429` with `Retry-After`, even with the right password.
- [x] Every API route except login, logout and token-authenticated machine endpoints answers `401` without a Login.
- [x] Mutating requests without the `x-claude-task` header get `403` `csrf`; cross-origin WebSocket handshakes are refused.
- [x] Logout ends only the current Login and closes its WebSocket with code `4001`.
- [x] Changing a password needs the current one and a different new one of at least 8 characters, and ends every other Login.
- [x] Users created by an Admin must change their password before anything else; until then other requests and the WebSocket get `403` `password_change_required`.
- [x] Admins create Users with a generated or chosen temporary password returned once; duplicate emails in any letter case get `409`.
- [x] Deactivated Users are logged out everywhere at once, can't log in, keep their history, and can be reactivated.
- [x] A password reset issues a new temporary password and ends every Login of the User.
- [x] Demoting or deactivating the last active Admin gets `400`, also under concurrent requests.
- [x] Members get `403` on User management, permanent Project deletion, Agent management, Credentials, Extensions catalog changes, Git Connections and project secrets.
- [x] Every User can list all Users.
- [x] The web app redirects to login on an expired Login, to the change-password screen while a temporary password is held, and hides admin navigation from Members.
- [x] The Flutter app logs in against an entered installation URL, keeps only the Login cookie, URL and User in secure storage, and handles expiry and logout.

## Out of Scope

- Single sign-on, OAuth providers, multi-factor authentication.
- Self-service sign-up and password recovery by email.
- Per-Project permissions, multiple workspaces or tenants.
- Deleting Users; editing one's own display name.

## Further Notes

- The Admin role later grew to cover Extensions and Git Connections, introduced by the agent runtime and Git integration work.
- Device registrations and push delivery belong to the Flutter app work; they rely on Logins as described here.
