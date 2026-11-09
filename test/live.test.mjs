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
