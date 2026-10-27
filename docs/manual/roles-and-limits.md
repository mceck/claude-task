[Manual](README.md) › Reference

# Check permissions and limits

Use this reference when an action is unavailable or an input is rejected. All active Users share access to the installation's Projects and Wikis.

## Roles

| Action | Member | Admin |
| --- | --- | --- |
| Create, edit, archive and restore Projects | Yes | Yes |
| Manage Statuses, Tags, Tasks and assignments | Yes | Yes |
| Link a Repository; edit Setup Script and Agent Instructions | Yes | Yes |
| Permanently delete an archived Project | No | Yes |
| Post Comments and Internal Notes; edit own Comments | Yes | Yes |
| Delete own Comments | Yes | Yes |
| Delete other Users', Agent and System Comments | No | Yes |
| Create, edit, reset and delete Wikis | Yes | Yes |
| Inspect Agent Queue, Jobs, Builds and usage | Yes | Yes |
| Reorder or remove eligible Queue entries; Stop and Retry | Yes | Yes |
| Configure Agents, containers and Credentials | No | Yes |
| Manage Users, Git Connections and Extensions | No | Yes |
| Create, import or delete Project environment variables | No | Yes |
| Manage own notification preferences | Yes | Yes |

The same role permissions apply in the web and native apps. Native Settings include Project Repositories and Base Branches for every User, and Extensions, Git Connections and Agent configuration for Admins. Use the web app for Docker configuration, Builds, Development Services, resource limits and Project environment variables.

Members can read Project environment variable names and plain values, but secret values are redacted. Internal Notes are visible to every User, including Members. Admins cannot edit someone else's Comment.

## Input and file limits

| Item | Limit |
| --- | --- |
| Password | 8–200 characters |
| Project Key | 2–6 uppercase letters; unique and fixed at creation |
| Project, Status or Tag name | 100 characters |
| Project description | 10,000 characters |
| Task title | 500 characters |
| Task description or Comment | 100,000 characters |
| Tags per Task | 50 |
| User assignees per Task | 50 |
| Assigned Agents per Task | 1 |
| Attachment | 25 MB per file |
| Attachments per Comment | 10 |
| Description files per Task | 100 |
| Wiki name | 200 characters |
| Wiki description | 100,000 characters |
| Agent avatar upload | 2 MB; PNG, JPEG, GIF or WebP |
| Project logo or User profile image | 2 MB; PNG, JPEG, GIF or WebP |
| Setup Script or Agent Instructions | 100,000 characters each |

## Work and access limits

An Agent runs one Job at a time. Add Agents to work on several Tasks at once. Agents using the same Credential share its provider rate limits.

A Project must keep at least one Status in the `open` Category and one in `closed`. Only `closed` ends an Agent Session; `done` does not.

Logins expire after 30 days without activity. Password resets and deactivation end the User's Logins. Repeated failed login attempts can temporarily block further attempts.

## Related

- [Users and access](admin-users.md): change roles and restore access.
- [Troubleshooting](troubleshooting.md): understand rejected actions.

---

← [Installation and operations](installation-and-operations.md) · [Glossary](glossary.md) →
