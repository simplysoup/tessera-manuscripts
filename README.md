# Tessera

Tessera is a web-native scientific writing workspace built around the pinned
TeXmacs Upsilon 2.1.5 WebAssembly editor. The editor and typesetter run in the
browser. The Worker serves the app and stores account manuscripts; it does not
run TeXmacs or compile documents on the server.

## Start locally

Requirements: Node.js 22 or newer and npm.

```sh
npm ci
npm start
```

Open <http://127.0.0.1:4173/>. Choose **Continue locally** for browser-only
drafts, or use **New manuscript** or a sample to explore. The local server uses
an in-memory database and a development identity; it needs no account or
secrets. Stop it with `Ctrl+C`.

## Run a persistent demo server

To run the demo accounts from [Account storage](docs/ACCOUNT-STORAGE.md)
instead of the fixed development identity, set a database file and the shared
invite code before starting:

```sh
TESSERA_DB_PATH=/path/to/tessera.db DEMO_INVITE_CODE=<shared secret> npm start
```

Registration then requires the invite code, and accounts and manuscripts persist
in the SQLite file across restarts. Keep the invite code out of the repository.

## Verify and build

```sh
npm test
npm run build
```

`npm test` runs the server, editor-contract, sharing, collaboration-journal,
shortcut, and account-security checks. Browser checks use Playwright and a
local Chromium installation:

```sh
npx playwright install chromium
npm run test:browser
npm run test:collaboration
```

Set `CHROMIUM_PATH` to use an existing Chromium executable. `CHROMIUM_ARGS` may
contain a JSON array of extra launch flags. `npm run build` writes the deployable
Worker and static app to `dist/`.

## Working in the editor

- Click the page to edit at the native caret. **Insert** adds structure, **Tools**
  opens the native toolbars, and **Source** edits the document markup.
- Drafts in **Continue locally** remain in that browser's IndexedDB. Export a
  file to move or share them. Sign in to sync private manuscripts across devices
  and create share links.
- Shared links are bearer links: anyone holding one can open it. Owners can
  revoke links; downloaded copies cannot be recalled.
- Append `?gpu=0` to use the upstream MuPDF rendering path.

## Project map

| Path | Purpose |
| --- | --- |
| `web/app/` | Tessera interface, account flows, local storage, editor integration |
| `worker/index.js` | API routes, authentication, account storage, share rooms |
| `drizzle/` | Ordered database migrations |
| `engine/` | Pinned Upsilon WASM build, fonts, and asset manifest |
| `web/examples/`, `web/tutorials/` | Editable sample manuscripts and lessons |
| `test/` | Worker, editor, room, browser, and collaboration checks |
| `docs/` | Architecture, data handling, and collaboration notes |

See [Account storage](docs/ACCOUNT-STORAGE.md) for demo account setup and data
behavior, [Port notes](docs/PORT.md) for the native engine integration, and the
[collaboration contract](docs/COLLABORATION.md) for the room model and its test
scope. The build uses the included Upsilon engine; compiling the upstream C++
engine is not part of the local start path.
