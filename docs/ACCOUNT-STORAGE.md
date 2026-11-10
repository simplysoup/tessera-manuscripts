# Account storage and sharing

The Upsilon editor and typesetter run in each user's browser. The Worker serves
the static app and validates requests to the manuscript database; it does not
start a TeXmacs process or compile manuscripts on the server.

## Demo accounts

The Site itself is public so visitors can reach the sign-in screen without a
ChatGPT account. Tessera has its own email-and-password accounts. To keep the
demo small, registration requires the shared `DEMO_INVITE_CODE` runtime secret,
and registration stops after 25 accounts. Set this value in the Site runtime
environment before deployment and share it only with demo participants.

Passwords are stored as PBKDF2-SHA-256 hashes with per-account random salts
using the Workers runtime's 100,000-iteration limit. For this small demo,
registration also requires a 12-character password and login attempts are
rate-limited per source IP and per account name; password recovery attempts use
the same limits. This setup is not a substitute for a production identity service.
Successful sign-in creates a random, HttpOnly session cookie; on HTTPS it uses
Secure and SameSite=None so sign-in also works when the Site is embedded. Only
its SHA-256 hash is stored. Authentication attempts are
limited by source IP and account name. Registration issues ten one-time recovery
codes. Only their hashes are stored. A code can reset the password and revoke
all sessions; signed-in users can rotate the set after confirming their current
password. Email is used as the account name but is not verified, and recovery
does not send email. Remove the invite secret or replace it after the demo to
stop new registrations.

Local `npm start` uses a fixed local-only identity so the account library can be
used without creating a demo account.

Visitors can also choose **Continue locally** without registering or signing
in. Local drafts are stored only in that browser's IndexedDB. Local mode does
not call the account library, create share links, or join collaborative rooms;
users can import and export files, and must export to move or share work. Local
drafts stay on the device if the user later signs in, but are only shown again
when they choose local mode in that browser.

## Data model

- `user_manuscripts` stores private manuscripts with an immutable owner ID.
  Every list, read, update, and delete query includes that owner ID.
- `user_room_access` records shared rooms the signed-in user has opened, so
  those rooms appear in that user's library on their other devices.
- `manuscript_links` stores room or copy snapshots. A link UUID is a bearer
  secret: anyone who has it can read the snapshot or edit the room. Account
  owners can list and revoke their links. Revoking a room deletes its patch
  history and access records; other users' cached room entries are removed on
  their next successful library sync. Revocation cannot recall copies already
  downloaded or imported. Links do not expire automatically.
- Browser IndexedDB holds a local working cache. Existing unowned local drafts
  are claimed by the first account that signs in on that browser and copied to
  its cloud library. Local documents tagged to a different account stay hidden.

Database changes are in `drizzle/0001_account_manuscripts.sql` and
`drizzle/0002_demo_accounts.sql`; the Site deployment applies the migrations
before uploading the Worker.

The initial abuse bounds are 100 private manuscripts and 20 new share links per
account per day, 12 authentication or recovery attempts per IP/account in 15
minutes, 60 accepted room edits per room per minute, a 512 KiB manuscript/patch
size, and 20 MiB of accepted patch history per room. These are guardrails for a
small demo, not production-scale identity or abuse controls.
