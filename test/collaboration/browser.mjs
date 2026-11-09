import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startServer } from "../server.test.mjs";
import { openEditor } from "./native-editor.mjs";
import { openRoom } from "./room-fixture.mjs";

// The runner controls delivery and lease time. The two independent Chromium
// processes run the real editor and act as the peers. A production signaling,
// WebRTC, and persistence adapter can be tested against the same outcomes.
const outboxKey = "test:collaboration-outbox";
const directory = await mkdtemp(join(tmpdir(), "workbench-collaboration-"));
const server = await startServer();
const browsers = [];
try {
  async function launchPeer(bars) {
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH,
      args: JSON.parse(process.env.CHROMIUM_ARGS ?? "[]"),
    });
    browsers.push(browser);
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    return { browser, page, editor: await openEditor(page, server.url, bars) };
  }

  async function getOutbox(page) {
    return page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "[]"), outboxKey);
  }

  async function enqueue(page, operation) {
    await page.evaluate(({ key, operation }) => {
      const pending = JSON.parse(localStorage.getItem(key) ?? "[]");
      pending.push(operation);
      localStorage.setItem(key, JSON.stringify(pending));
    }, { key: outboxKey, operation });
  }

  async function acknowledge(page, id) {
    await page.evaluate(({ key, id }) => {
      const pending = JSON.parse(localStorage.getItem(key) ?? "[]");
      localStorage.setItem(key, JSON.stringify(pending.filter(entry => entry.id !== id)));
    }, { key: outboxKey, id });
  }

  const host = await launchPeer();
  const guest = await launchPeer("top");
  const initial = await host.editor.snapshot();
  assert.equal(await guest.editor.snapshot(), initial);
  assert.match(initial, /\(matrix \(tformat \(table /u);

  const file = join(directory, "manuscript.json");
  let time = 100;
  let room = openRoom(file, () => time, initial);
  const hostLease = room.claim("host", 20);
  assert.ok(hostLease);
  assert.equal(room.claim("guest", 20), null);

  async function commit(editor, lease, operation) {
    const state = room.read();
    const committed = state.log.find(entry => entry.id === operation.id);
    if (committed) return room.append(lease, state.revision, operation, committed.patch);
    const patch = await editor.rebase(state, operation);
    if (patch === null) return { status: "conflict" };
    return room.append(lease, state.revision, operation, patch);
  }

  // Both patches are authored at revision zero, in independent editor trees.
  const [hostPatch, guestPatch] = await Promise.all([
    host.editor.editCell(1, 0, "21"),
    guest.editor.editCell(1, 1, "34"),
  ]);
  assert.match(await host.editor.snapshot(), /\(row \(cell "21"\) \(cell "1"\)\)/u);
  assert.match(await guest.editor.snapshot(), /\(row \(cell "0"\) \(cell "34"\)\)/u);
  const first = { id: "host/1", author: "host", baseRevision: 0, patch: hostPatch };
  const second = { id: "guest/1", author: "guest", baseRevision: 0, patch: guestPatch };
  assert.deepEqual(await commit(host.editor, hostLease, first), { status: "saved", revision: 1 });
  assert.deepEqual(await commit(host.editor, hostLease, second), { status: "saved", revision: 2 });
  const common = await host.editor.restore(room.read());
  assert.equal(await guest.editor.restore(room.read()), common);
  assert.match(common, /\(row \(cell "21"\) \(cell "34"\)\)/u);
  console.log("Two WASM editors converged after simultaneous edits to independent matrix cells.");

  // An edit reaches durable storage, but the confirmation is never delivered.
  // Another edit remains only in the guest outbox.
  const committed = { id: "guest/2", author: "guest", baseRevision: 2,
    patch: await guest.editor.editCell(0, 0, "55") };
  await enqueue(guest.page, committed);
  assert.deepEqual(await commit(host.editor, hostLease, committed), { status: "saved", revision: 3 });
  const pending = { id: "guest/3", author: "guest", baseRevision: 2,
    patch: await guest.editor.editCell(1, 1, "89") };
  await enqueue(guest.page, pending);

  // The host disappears without handing off. Reopen the journal from disk
  // and reload the guest so in-memory editor state cannot make the test pass.
  await host.browser.close();
  room = openRoom(file, () => time);
  assert.equal(room.claim("guest", 20), null);
  time += 20;
  const guestLease = room.claim("guest", 20);
  assert.equal(guestLease.generation, hostLease.generation + 1);
  assert.deepEqual(room.append(hostLease, 3, pending, pending.patch), { status: "stale-host" });
  guest.editor = await openEditor(guest.page, server.url, "top");
  assert.equal(await guest.editor.snapshot(), initial);
  assert.deepEqual(await getOutbox(guest.page), [committed, pending]);
  const restored = await guest.editor.restore(room.read());
  assert.match(restored, /\(cell "55"\)/u);
  assert.match(restored, /\(row \(cell "21"\) \(cell "34"\)\)/u);

  const receipts = [];
  for (const operation of await getOutbox(guest.page)) {
    const receipt = await commit(guest.editor, guestLease, operation);
    receipts.push(receipt);
    if (receipt.status === "saved" || receipt.status === "duplicate") await acknowledge(guest.page, operation.id);
  }
  assert.deepEqual(receipts, [{ status: "duplicate", revision: 3 }, { status: "saved", revision: 4 }]);
  assert.deepEqual(await getOutbox(guest.page), []);
  const durable = room.read();
  assert.deepEqual(durable.log.map(entry => entry.id), ["host/1", "guest/1", "guest/2", "guest/3"]);
  const final = await guest.editor.restore(durable);
  assert.match(final, /\(cell "55"\)/u);
  assert.match(final, /\(row \(cell "21"\) \(cell "89"\)\)/u);
  assert.match(final, /\(frac \(concat "x" \(rsup "2"\)\) "2"\)/u);

  const rejoined = await launchPeer();
  assert.equal(await rejoined.editor.restore(durable), final);
  console.log("Host exit, lease expiry, stale-host fencing, disk recovery, outbox retry, and fresh peer replay passed.");

  // Same-cell replacements cannot be silently discarded when they conflict.
  const chosen = { id: "guest/4", author: "guest", baseRevision: 4,
    patch: await guest.editor.editCell(1, 0, "99") };
  const conflicting = { id: "rejoined/1", author: "rejoined", baseRevision: 4,
    patch: await rejoined.editor.editCell(1, 0, "101") };
  await enqueue(rejoined.page, conflicting);
  assert.deepEqual(await commit(guest.editor, guestLease, chosen), { status: "saved", revision: 5 });
  assert.deepEqual(await commit(guest.editor, guestLease, conflicting), { status: "conflict" });
  assert.deepEqual(await getOutbox(rejoined.page), [conflicting]);
  assert.equal(room.read().revision, 5);
  assert.match(await guest.editor.restore(room.read()), /\(row \(cell "99"\) \(cell "89"\)\)/u);
  console.log("A conflicting same-cell edit stays in the outbox for recovery.");
} finally {
  await Promise.allSettled(browsers.map(browser => browser.close()));
  server.close();
  await rm(directory, { recursive: true, force: true });
}
