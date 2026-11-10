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
  assert.deepEqual(await readLink("room", id), { title: "Two editors", format: "tm", bytes: encoded });

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
