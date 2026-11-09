# Browser collaboration contract

The browser workspace has three independent pieces.

| Piece | Owns | Integration surface |
| --- | --- | --- |
| Browser UI | Tabs, document actions, share dialog, save indicator, and recovery panel | Reads a session snapshot and invokes commands. The layout and theme have no dependency on transport or storage. |
| Native editor adapter | TeXmacs input, tree edits, in-place patch application, and user-authored undo | Supplies a manuscript snapshot and native changes. It accepts remote patches and reports incompatibility. |
| Collaboration session | Peer connection, host selection, revision sequencing, retry and recovery | Connects the editor adapter to a transport and durable store. It reports outcomes to the UI without exposing lease or patch internals. |

A minimal UI-facing shape for the first implementation:

```ts
interface SessionView {
  phase: "connecting" | "connected" | "reconnecting";
  revision: number;         // Last revision confirmed by durable storage.
  pendingCount: number;     // Local operations without a durable receipt.
  recoveryCount: number;    // Operations requiring a user decision.
}

interface SessionPort {
  getSnapshot(): SessionView;
  subscribe(listener: () => void): () => void;
  retry(): Promise<void>;
  exportRecovery(): Promise<Blob>;
}
```

The UI can render that contract with a fixture while the collaboration
adapter is being built. The collaboration tests drive the WASM editor
through its Scheme API and can run without the browser workspace UI.
A markup, style, or layout change can ship separately. Changes to the
meaning of Saved, permission to edit, or conflict recovery affect the
contract and require agreement on both sides. Browser chrome can be styled
as HTML and CSS. Changes to canvas-drawn Upsilon widgets belong in its
native UI backend.

## Hosted rooms

Share → Start live editing saves a native checkpoint and opens a room.
Copy the live link to another window with access to the private workspace.
A link also works through Open a link on the homepage. A copy link opens
an independent local draft. The original local draft is still available
from the manuscript library.

The browser observes native body modifications and rebases unconfirmed
edits over intervening native patches. D1 accepts an append only at the
expected revision and recognizes a retry by operation ID. Each browser
polls the journal and applies remote patches in place, with its own
editor author reserved for local undo. Closing the initiating window
does not stop the other window. Overlapping edits that cannot be rebased
pause synchronization and leave the working version available for export.

This first hosted room synchronizes the body tree. The initial checkpoint
includes style and environment, but subsequent changes to those settings
and external project assets are outside the patch stream. Accepted changes
survive closing and reopening the room. Use Export to keep pending changes
if synchronization pauses. Transport uses the site relay, without a
WebRTC connection or a browser elected as the network host.

`npm test` covers copy storage, revision races, idempotent appends,
and bidirectional delivery and replay through the production JavaScript
session port using a substitute editor adapter. The local development
server runs the same HTTP routes against temporary SQLite storage.

## Host lease and durable outbox design

- A lease has one owner, an expiry, and a monotonically increasing
  generation. An append atomically checks the current lease, checks the
  expected journal revision, and records the operation and its receipt.
- The host sequences and rebases native tree patches. Storage records the
  accepted patch, including its operation ID. A retry with the same ID and
  payload returns the prior receipt, even if the head revision advanced.
- Saved means a durable receipt. Local typing stays responsive while a
  patch is pending. Pending operations survive a browser reload and remain
  available for recovery if they cannot be rebased.
- The test snapshot contains the native document body. A production
  manuscript snapshot also needs document style, initial environment,
  and references to separately stored project assets.

## Acceptance test

Run `npm ci`, `npx playwright install chromium`, `npm test`, then
`npm run test:collaboration`. The browser suite launches independent
Chromium processes running the pinned Upsilon WASM distribution. It
authors edits at the same revision in different matrix cells, sequences
and rebases them using native Upsilon patches, closes the host without a
handoff, and reopens the file-backed journal. The surviving browser
reloads, claims the next lease, recovers all saved edits, retries an edit
whose acknowledgement was lost, and commits an edit that had been queued
locally. A fresh browser reconstructs the final tree. The suite also checks that a
competing replacement of the same cell stays in the outbox for recovery.
The first two peers use different native toolbar placements.

The harness uses a deterministic delivery schedule, a controlled lease
clock, browser local storage for its test outbox, and a single-process
file-backed journal fixture. This verifies native patch and recovery
behavior under those conditions. WebRTC signaling, TURN, and host leases are outside the hosted relay. The harness is separate from the HTTP relay tests.
