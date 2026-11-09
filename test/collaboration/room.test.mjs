import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openRoom } from "./room-fixture.mjs";

function roomFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "workbench-room-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "room.json");
  let time = 0;
  const now = () => time;
  return {
    room: openRoom(path, now, "(document \"seed\")"),
    tick: milliseconds => { time += milliseconds; },
    reopen: () => openRoom(path, now),
  };
}

const operation = (id, baseRevision = 0) => ({ id, author: "editor", baseRevision, patch: "native " + id });

test("one lease wins, and an expired host is fenced before and after handoff", t => {
  const { room, tick, reopen } = roomFixture(t);
  const first = room.claim("first", 10);
  assert.ok(first);
  assert.equal(reopen().claim("second", 10), null);
  assert.deepEqual(room.append(first, 0, operation("a"), "a"), { status: "saved", revision: 1 });
  tick(10);
  assert.deepEqual(room.append(first, 1, operation("b", 1), "b"), { status: "stale-host" });

  const restarted = reopen();
  const next = restarted.claim("second", 10);
  assert.equal(next.generation, first.generation + 1);
  assert.deepEqual(room.append(first, 1, operation("b", 1), "b"), { status: "stale-host" });
  assert.deepEqual(restarted.append(next, 1, operation("b", 1), "b"), { status: "saved", revision: 2 });
  assert.deepEqual(restarted.read().log.map(entry => entry.id), ["a", "b"]);
});

test("a retry after a lost acknowledgement uses its original revision and appends once", t => {
  const { room, reopen } = roomFixture(t);
  const lease = room.claim("host", 10);
  const first = operation("a");
  assert.deepEqual(room.append(lease, 0, first, "accepted a"), { status: "saved", revision: 1 });
  assert.deepEqual(reopen().append(lease, 0, first, "accepted a"), { status: "duplicate", revision: 1 });
  assert.deepEqual(room.append(lease, 1, { ...first, patch: "different" }, "bad"), { status: "id-conflict" });
  assert.deepEqual(room.append(lease, 0, operation("b"), "stale"), { status: "stale-revision" });
  assert.equal(room.read().log.length, 1);
});
