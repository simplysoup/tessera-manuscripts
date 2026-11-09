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

Passwords are stored as PBKDF2-SHA-256 hashes with per-account random salts.
Successful sign-in creates a random, HttpOnly, Secure (on HTTPS), SameSite=Lax
session cookie; only its SHA-256 hash is stored. Authentication attempts are
limited by source IP. Email is used as the account name but is not verified, and
the demo does not include password recovery or account administration. Remove
the invite secret or replace it after the demo to stop new registrations.

Local `npm start` uses a fixed local-only identity so the account library can be
used without creating a demo account.

## Data model

- `user_manuscripts` stores private manuscripts with an immutable owner ID.
  Every list, read, update, and delete query includes that owner ID.
- `user_room_access` records shared rooms the signed-in user has opened, so
  those rooms appear in that user's library on their other devices.
- `manuscript_links` stores room or copy snapshots. The invitation UUID is a
  bearer link: a person who has it can read and edit that room. Links do not
  expire; users can remove a room from their own library without affecting
  other users.
- Browser IndexedDB holds a local working cache. Existing unowned local drafts
  are claimed by the first account that signs in on that browser and copied to
  its cloud library. Local documents tagged to a different account stay hidden.

Database changes are in `drizzle/0001_account_manuscripts.sql` and
`drizzle/0002_demo_accounts.sql`; the Site deployment applies the migrations
before uploading the Worker.

The initial abuse bounds are 100 private manuscripts and 20 new share links per
account per day, a 512 KiB manuscript/patch size, and 20 MiB of accepted patch
history per room. These are guardrails for a small demo, not production-scale
identity or abuse controls.
