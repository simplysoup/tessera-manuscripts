import assert from "node:assert/strict";
import test from "node:test";
import { connectRoom, createLink, readLink } from "../web/app/live.js";
import { startServer } from "./server.test.mjs";

const manuscript = "<TeXmacs|2.1.5>\n";
const encoded = new TextEncoder().encode(manuscript);

test("copy links retrieve their own immutable native snapshot and room appends are atomic", async t => {
  const server = await startServer();
  t.after(server.close);
  const send = (path, body, origin = server.url) => fetch(server.url + "/api/manuscripts/" + path, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const read = path => fetch(server.url + "/api/manuscripts/" + path);
  const document = { title: "A manuscript", manuscript };
  assert.equal((await send("copy", document, "https://elsewhere.example")).status, 403);
  const created = await send("copy", document);
  assert.equal(created.status, 201);
  const copy = (await created.json()).id;
  const copyResponse = await read("copy/" + copy);
  assert.equal(copyResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await copyResponse.json(), document);
  assert.equal((await read("room/" + copy)).status, 404);

  const room = (await (await send("room", document)).json()).id;
  const changes = "room/" + room + "/changes";
  const left = { id: crypto.randomUUID(), revision: 0, patch: "(compound left)" };
  const right = { id: crypto.randomUUID(), revision: 0, patch: "(compound right)" };
  const submissions = await Promise.all([send(changes, left), send(changes, right)]);
  assert.deepEqual(submissions.map(r => r.status).sort(), [201, 409]);
  const accepted = submissions[0].status === 201 ? left : right;
  const rejected = accepted === left ? right : left;
  assert.deepEqual(await (await send(changes, accepted)).json(), { revision: 1 });
  assert.equal((await send(changes, { ...rejected, revision: 1 })).status, 201);
  assert.deepEqual(await (await read(changes + "?after=1")).json(), [{ revision: 2, patch: rejected.patch }]);
});

test("the live session transports local edits in both directions and replays for a new session", async t => {
  const server = await startServer();
  t.after(server.close);
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (path, options) => realFetch(new URL(path, server.url), {
    ...options, headers: { Origin: server.url, ...options?.headers },
  }));
  const id = await createLink("room", "Two editors", encoded);
  assert.deepEqual(await readLink("room", id), { title: "Two editors", format: "tm", bytes: encoded, snapshotRevision: 0 });

  async function peer() {
    let local;
    const received = [];
    const editor = { room: () => ({
      take() { const patch = local; local = null; return patch; },
      pending: () => !!local,
      accept: () => {},
      restore: patch => { local = patch; },
      receive: patch => { received.push(patch); return true; },
      stop: () => {},
    }) };
    const controller = new AbortController();
    const session = connectRoom(id, editor, () => {}, controller.signal);
    t.after(() => { controller.abort(); session.stop(); });
    await session.start();
    return { session, received, edit: patch => { local = patch; } };
  }

  const left = await peer();
  const right = await peer();
  left.edit("(compound left)");
  right.edit("(compound right)");
  await Promise.all([left.session.flush(), right.session.flush()]);
  await Promise.all([left.session.flush(), right.session.flush()]);
  assert.deepEqual(left.received, ["(compound right)"]);
  assert.deepEqual(right.received, ["(compound left)"]);
  const rejoined = await peer();
  assert.deepEqual(rejoined.received.sort(), ["(compound left)", "(compound right)"]);
});

test("room snapshots are validated and only move the checkpoint forward", async t => {
  const server = await startServer();
  t.after(server.close);
  const send = (path, body, origin = server.url) => fetch(server.url + "/api/manuscripts/" + path, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const read = path => fetch(server.url + "/api/manuscripts/" + path);
  const document = { title: "Snapshot rules", manuscript };
  const room = (await (await send("room", document)).json()).id;
  const snapshot = "room/" + room + "/snapshot";
  assert.equal((await send("room/" + crypto.randomUUID() + "/snapshot", { revision: 0, manuscript })).status, 404);
  assert.equal((await send(snapshot, { revision: 0, manuscript: "not texmacs" })).status, 400);
  assert.equal((await send(snapshot, { revision: -1, manuscript })).status, 400);
  // A snapshot cannot cover a revision the room does not hold yet.
  assert.equal((await send(snapshot, { revision: 1, manuscript })).status, 409);
  const changes = "room/" + room + "/changes";
  assert.equal((await send(changes, { id: crypto.randomUUID(), revision: 0, patch: "(compound one)" })).status, 201);
  assert.deepEqual(await (await send(snapshot, { revision: 1, manuscript })).json(), { snapshot_revision: 1 });
  assert.equal((await (await read("room/" + room)).json()).snapshot_revision, 1);
  // The checkpoint cannot move backwards or stay put.
  assert.equal((await send(snapshot, { revision: 1, manuscript })).status, 409);
  assert.equal((await send(snapshot, { revision: 0, manuscript })).status, 409);
  // A snapshot from another origin is refused, like other room writes.
  assert.equal((await send(snapshot, { revision: 1, manuscript }, "https://elsewhere.example")).status, 403);
  // A copy link has no snapshot endpoint.
  const copy = (await (await send("copy", document)).json()).id;
  assert.equal((await send("copy/" + copy + "/snapshot", { revision: 0, manuscript })).status, 404);
});

test("a snapshot checkpoints the room so a new session replays only the tail", async t => {
  const server = await startServer();
  t.after(server.close);
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (path, options) => realFetch(new URL(path, server.url), {
    ...options, headers: { Origin: server.url, ...options?.headers },
  }));
  const id = await createLink("room", "Checkpointed", encoded);
  assert.deepEqual(await readLink("room", id), { title: "Checkpointed", format: "tm", bytes: encoded, snapshotRevision: 0 });

  async function peer() {
    // The app reads the link first and joins from its checkpoint.
    const { snapshotRevision } = await readLink("room", id);
    let local;
    const received = [];
    const editor = {
      exportFile: () => encoded,
      room: () => ({
        take() { const patch = local; local = null; return patch; },
        pending: () => !!local,
        accept: () => {},
        restore: patch => { local = patch; },
        receive: patch => { received.push(patch); return true; },
        stop: () => {},
      }),
    };
    const controller = new AbortController();
    const session = connectRoom(id, editor, () => {}, controller.signal, snapshotRevision);
    t.after(() => { controller.abort(); session.stop(); });
    await session.start();
    return { session, received, edit: patch => { local = patch; } };
  }

  const writer = await peer();
  writer.edit("(compound one)");
  await writer.session.flush();
  writer.edit("(compound two)");
  await writer.session.flush();
  assert.equal(await writer.session.snapshot(), true);
  assert.equal((await readLink("room", id)).snapshotRevision, 2);
  // A client joining now starts from the checkpoint and replays nothing.
  const joined = await peer();
  assert.deepEqual(joined.received, []);
  // A change after the checkpoint is still delivered, and only the tail.
  writer.edit("(compound three)");
  await writer.session.flush();
  const late = await peer();
  assert.deepEqual(late.received, ["(compound three)"]);
});

test("a snapshot past an unappliable patch lets a new session open cleanly", async t => {
  const server = await startServer();
  t.after(server.close);
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (path, options) => realFetch(new URL(path, server.url), {
    ...options, headers: { Origin: server.url, ...options?.headers },
  }));
  const id = await createLink("room", "Healed by checkpoint", encoded);
  async function peer(receive) {
    const { snapshotRevision } = await readLink("room", id);
    let local;
    const received = [];
    const editor = {
      exportFile: () => encoded,
      room: () => ({
        take() { const patch = local; local = null; return patch; },
        pending: () => !!local,
        accept: () => {},
        restore: patch => { local = patch; },
        receive: patch => { received.push(patch); return receive(patch); },
        stop: () => {},
      }),
    };
    const controller = new AbortController();
    const statuses = [];
    const session = connectRoom(id, editor, message => statuses.push(message), controller.signal, snapshotRevision);
    t.after(() => { controller.abort(); session.stop(); });
    return { session, statuses, received, edit: patch => { local = patch; } };
  }
  const writer = await peer(() => true);
  await writer.session.start();
  writer.edit("(compound structural)");
  await writer.session.flush();
  // The writer checkpoints past its own patch, absorbing it into the
  // stored manuscript, so a client that cannot apply the patch never
  // has to replay it.
  assert.equal(await writer.session.snapshot(), true);
  const reader = await peer(() => { throw new Error("cannot apply remote"); });
  await reader.session.start();
  assert.ok(reader.statuses.includes("Synced"), "expected Synced, got " + JSON.stringify(reader.statuses));
  assert.ok(!reader.statuses.includes("Sync paused"), "must not pause, got " + JSON.stringify(reader.statuses));
  assert.deepEqual(reader.received, []);
});

test("manuscripts larger than the patch limit can be shared and snapshotted, up to 10 MB", async t => {
  const server = await startServer();
  t.after(server.close);
  const send = (path, body, origin = server.url) => fetch(server.url + "/api/manuscripts/" + path, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  // A single embedded image already exceeds the 512 KB patch limit, so a
  // manuscript that size must still share and snapshot.
  const large = "<TeXmacs|2.1.5>\n" + "x".repeat(600 * 1024);
  const created = await send("room", { title: "Large manuscript", manuscript: large });
  assert.equal(created.status, 201);
  const room = (await created.json()).id;
  assert.equal((await send("room/" + room + "/changes", { id: crypto.randomUUID(), revision: 0, patch: "(compound one)" })).status, 201);
  const snapshot = await send("room/" + room + "/snapshot", { revision: 1, manuscript: large });
  assert.equal(snapshot.status, 200);
  assert.deepEqual(await snapshot.json(), { snapshot_revision: 1 });
  // Over 10 MB is still refused.
  const tooLarge = "<TeXmacs|2.1.5>\n" + "x".repeat(10 * 1024 * 1024 + 1);
  assert.equal((await send("room", { title: "Too large", manuscript: tooLarge })).status, 400);
  assert.equal((await send("room/" + room + "/snapshot", { revision: 1, manuscript: tooLarge })).status, 400);
  // A patch over 512 KB is still refused, even though manuscripts are larger.
  assert.equal((await send("room/" + room + "/changes", { id: crypto.randomUUID(), revision: 1, patch: "(" + "x".repeat(600 * 1024) })).status, 400);
});

test("a local patch failure pauses sync instead of reconnecting forever", async t => {
  const server = await startServer();
  t.after(server.close);
  const realFetch = globalThis.fetch;
  let changesCalls = 0;
  t.mock.method(globalThis, "fetch", (path, options) => {
    if (String(path).includes("/changes")) changesCalls += 1;
    return realFetch(new URL(path, server.url), {
      ...options, headers: { Origin: server.url, ...options?.headers },
    });
  });
  const id = await createLink("room", "Wedges", encoded);
  const statuses = [];
  let local = null;
  let takeThrows = false;
  const editor = { room: () => ({
    take() {
      if (takeThrows) throw new Error("cannot compound undo");
      const patch = local; local = null; return patch;
    },
    pending: () => !!local,
    accept: () => {},
    restore: patch => { local = patch; },
    receive: () => true,
    stop: () => {},
  }) };
  const controller = new AbortController();
  const session = connectRoom(id, editor, message => statuses.push(message), controller.signal);
  t.after(() => { controller.abort(); session.stop(); });
  await session.start();
  assert.deepEqual(statuses, ["Synced"]);
  // A local edit the editor cannot turn into a patch (like a wedged undo)
  // must pause sync once, not loop on Reconnecting every poll.
  local = "(compound wedged)";
  takeThrows = true;
  await assert.rejects(session.flush(), /could not process a change: cannot compound undo/);
  assert.ok(statuses.includes("Sync paused"), "expected Sync paused, got " + JSON.stringify(statuses));
  assert.ok(!statuses.includes("Reconnecting"), "must not reconnect, got " + JSON.stringify(statuses));
  const callsAtPause = changesCalls;
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(changesCalls, callsAtPause, "polling must stop after the pause");
});

test("a remote patch the editor cannot apply pauses sync", async t => {
  const server = await startServer();
  t.after(server.close);
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (path, options) => realFetch(new URL(path, server.url), {
    ...options, headers: { Origin: server.url, ...options?.headers },
  }));
  const id = await createLink("room", "Remote wedge", encoded);
  async function peer(receive) {
    let local;
    const editor = { room: () => ({
      take() { const patch = local; local = null; return patch; },
      pending: () => !!local,
      accept: () => {},
      restore: patch => { local = patch; },
      receive,
      stop: () => {},
    }) };
    const controller = new AbortController();
    const statuses = [];
    const session = connectRoom(id, editor, message => statuses.push(message), controller.signal);
    t.after(() => { controller.abort(); session.stop(); });
    await session.start();
    return { session, statuses, edit: patch => { local = patch; } };
  }
  const left = await peer(() => { throw new Error("cannot apply remote"); });
  const right = await peer(() => true);
  right.edit("(compound remote)");
  await right.session.flush();
  await assert.rejects(left.session.flush(), /could not process a change: cannot apply remote/);
  assert.ok(left.statuses.includes("Sync paused"), "expected Sync paused, got " + JSON.stringify(left.statuses));
});

test("a room whose opening replay hits an unappliable patch still opens, paused", async t => {
  const server = await startServer();
  t.after(server.close);
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (path, options) => realFetch(new URL(path, server.url), {
    ...options, headers: { Origin: server.url, ...options?.headers },
  }));
  const id = await createLink("room", "Diverged replay", encoded);
  async function peer(receive) {
    let local;
    const editor = { room: () => ({
      take() { const patch = local; local = null; return patch; },
      pending: () => !!local,
      accept: () => {},
      restore: patch => { local = patch; },
      receive,
      stop: () => {},
    }) };
    const controller = new AbortController();
    const statuses = [];
    const session = connectRoom(id, editor, message => statuses.push(message), controller.signal);
    t.after(() => { controller.abort(); session.stop(); });
    return { session, statuses, edit: patch => { local = patch; } };
  }
  const writer = await peer(() => true);
  await writer.session.start();
  writer.edit("(compound writer)");
  await writer.session.flush();
  // The reader cannot apply the writer's patch (as a structural patch can
  // fail to apply on replay). Opening must still succeed, paused at the
  // last good revision, instead of failing the open outright.
  const reader = await peer(() => { throw new Error("cannot apply remote"); });
  await reader.session.start();
  assert.ok(reader.statuses.includes("Sync paused"), "expected Sync paused, got " + JSON.stringify(reader.statuses));
  assert.ok(!reader.statuses.includes("Reconnecting"), "must not reconnect, got " + JSON.stringify(reader.statuses));
  await assert.rejects(reader.session.flush(), /could not process a change: cannot apply remote/);
});

test("a patch the room keeps rejecting pauses instead of looping", async t => {
  const server = await startServer();
  t.after(server.close);
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (path, options) => {
    if (String(path).includes("/changes") && options?.method === "POST") {
      return Promise.resolve(new Response(JSON.stringify({ error: "The room has advanced." }), {
        status: 409, headers: { "Content-Type": "application/json" },
      }));
    }
    return realFetch(new URL(path, server.url), {
      ...options, headers: { Origin: server.url, ...options?.headers },
    });
  });
  const id = await createLink("room", "Stale patch", encoded);
  const statuses = [];
  let local = "(compound stale)";
  const editor = { room: () => ({
    take() { const patch = local; local = null; return patch; },
    pending: () => !!local,
    accept: () => {},
    restore: patch => { local = patch; },
    receive: () => true,
    stop: () => {},
  }) };
  const controller = new AbortController();
  const session = connectRoom(id, editor, message => statuses.push(message), controller.signal);
  t.after(() => { controller.abort(); session.stop(); });
  // The room rejects the patch and never advances, so the second rejection
  // must pause sync instead of retrying the same patch forever.
  await session.start();
  assert.ok(statuses.includes("Sync paused"), "expected Sync paused, got " + JSON.stringify(statuses));
  assert.ok(!statuses.includes("Reconnecting"), "must not reconnect, got " + JSON.stringify(statuses));
});
