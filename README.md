# Tessera manuscript studio

Tessera adds a browser library and a focused manuscript workspace around the
pinned **TeXmacs Upsilon 2.1.5** WebAssembly editor. Upsilon owns text and
equation editing, the caret, structured markup, rendering and export.

## Run

Run `npm start` with Node.js 22 or later, then open
[the workspace](http://127.0.0.1:4173/). Use **New manuscript**,
**Math playground**, or import a single `.tm` or `.tex` file.

- Click directly on the page to edit. **Insert** adds a section, theorem, or
  equation at the native caret. **Tools** reveals the full native icon
  bars and tabs. **Source** switches the same document into editable markup.
- Click the title to rename a draft. The studio saves locally after edits,
  and **Save** commits on demand. The library lists and searches saved drafts.
  Each draft can be open for editing in one tab on the same browser origin.
- **Export** downloads a PDF, LaTeX, or native TeXmacs copy. Signed-in private
  manuscripts sync to your account; IndexedDB keeps a local working copy.
  Shared rooms appear in your account after you open their invitation link.
- Append `?gpu=0` to use the upstream MuPDF rendering path. Otherwise the
  browser build selects its renderer.

`npm run build` builds the static site in `dist/`. The local server can fetch
additional manifest-listed fonts on demand. The static build includes the
fonts bundled in `engine/fonts/`.

For a draft created with the first Workbench prototype, export the draft as
`.tex` from that version, then import the file in this edition. The first
account sign-in moves existing local TeXmacs drafts into that account.

## Scope

This package focuses on the native scientific editing workflow. Collaboration
uses account-owned storage plus bearer invitation links and a durable room journal.
The acceptance suite uses native patches,
a file-backed journal fixture, and controlled delivery. The old slot model and its
two-tab CRDT are no longer part of the editor. The port's optional
computational plug-in bundles and desktop external programs are outside this
local package. LaTeX compatibility follows the pinned native converter and
depends on the commands and packages used by a document.

[Port notes](docs/PORT.md) trace input, trees, typesetting, export, and the
native modification hook for collaboration. They also identify the exact
upstream sources and build recipe.

The public demo uses Tessera email/password accounts gated by a shared invite
code. Account storage, demo limits, and setup are described in
[Account storage](docs/ACCOUNT-STORAGE.md).

## Verify

Run `npm ci`, `npx playwright install chromium`, `npm test`, then
`npm run test:collaboration`. The first suite checks asset serving and
the journal contract. The collaboration suite runs two independent
Upsilon WASM browsers through concurrent matrix edits and host handoff.
See [the collaboration contract and test scope](docs/COLLABORATION.md).
Set `CHROMIUM_PATH` to an existing Chromium executable and
`CHROMIUM_ARGS` to a JSON array of launch flags if needed.
