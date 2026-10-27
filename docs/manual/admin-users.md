[Manual](README.md) › Administration

# Manage users and access

Create team logins, change roles and recover access from **Users** in the web sidebar. These actions require an Admin.

Every active User can see every Project and Wiki in the installation. Use the Member role for team work and Admin for platform administration.

## Add a User

1. Open **Users** and click **New user**.
2. Enter **Name** and **Email**.
3. Select **Member** or **Admin** under **Role**.
4. Click **Create user**. The **Temporary password** dialog appears.
5. Use **Copy password** and share the password with that User through your team's private channel, together with the installation URL and email address.
6. Click **Done**. The password is not shown again.

The User signs in with the temporary password and chooses a new password before opening Projects. The app does not send an invitation email.

![Users list showing the fictional Admin Ada Morgan](images/admin-users/users.png)

| Badge | Meaning |
| --- | --- |
| **Active** | The User can sign in and has chosen a password. |
| **Invited** | The User must replace a temporary password. This also appears after a password reset. |
| **Deactivated** | Access is disabled; existing history remains. |

## Change a role

1. Find the User in **Users**.
2. Change the role selector to **Member** or **Admin**. The change saves immediately and applies on their next request.

Keep at least one active Admin. The app refuses changes that would remove the last active Admin.

## Reset a forgotten password

1. Open the User's actions menu.
2. Choose **Reset password** and confirm.
3. Copy the new temporary password and share it privately with the User.

Resetting immediately ends all that User's Logins. They must choose a new password when they sign in again. A reset does not reactivate a deactivated User.

## Deactivate or reactivate a User

1. Open the User's actions menu.
2. Choose **Deactivate** and confirm. Their Logins end immediately.

Comments, Task assignments and history keep their name. To restore access, choose **Reactivate** in the same menu. Their existing password still applies; reset it separately if needed.

## Related

- [Roles and limits](roles-and-limits.md): compare Member and Admin permissions.
- [Installation and operations](installation-and-operations.md): recover Admin access from the server.
- [Getting started](getting-started.md): first login and password selection.

---

← [Native app and notifications](native-app-and-notifications.md) · [Agents and credentials](admin-agents.md) →
