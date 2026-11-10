import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../worker/index.js";

const origin = "https://tessera.test";
const password = "long-demo-password-42";

class Statement {
  constructor(db, sql, values = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.db, this.sql, values); }
  async first() { return this.db.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.values) }; }
  async run() {
    if (/\bRETURNING\b/iu.test(this.sql)) {
      const results = this.db.prepare(this.sql).all(...this.values);
      return { success: true, results, meta: { changes: results.length } };
    }
    const result = this.db.prepare(this.sql).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

async function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const name of ["0000_manuscript_links.sql", "0001_account_manuscripts.sql", "0002_demo_accounts.sql", "0003_recovery_privacy_limits.sql", "0004_room_snapshot.sql"]) {
    const sql = await readFile(new URL("../drizzle/" + name, import.meta.url), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) if (statement.trim()) sqlite.exec(statement);
  }
  const db = {
    prepare: sql => new Statement(sqlite, sql),
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  t.after(() => sqlite.close());
  const env = { DB: db, DEMO_INVITE_CODE: "demo-test-invite" };
  const call = (path, { method = "GET", body, cookie, ip = "203.0.113.10", requestOrigin = origin } = {}) => {
    const headers = { Origin: requestOrigin, "CF-Connecting-IP": ip };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookie) headers.Cookie = cookie;
    return worker.fetch(new Request(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  };
  return { call, sqlite };
}

async function register(call, email, ip = "203.0.113.10") {
  const response = await call("/api/auth/register", {
    method: "POST", ip, body: { email, password, invite: "demo-test-invite" },
  });
  const body = await response.json();
  return { response, body, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}

test("recovery codes reset passwords once, invalidate sessions, and rotate for existing users", async t => {
  const { call } = await fixture(t);
  const user = await register(call, "nick@example.test");
  assert.equal(user.response.status, 200);
  assert.equal(user.body.recoveryCodes.length, 10);
  assert.equal(new Set(user.body.recoveryCodes).size, 10);
  assert.match(user.response.headers.get("set-cookie"), /SameSite=None;.*Secure/u);
  assert.equal((await call("/api/me", { cookie: user.cookie })).status, 200);

  const reset = await call("/api/auth/recover", {
    method: "POST", ip: "203.0.113.11",
    body: { email: "nick@example.test", recoveryCode: user.body.recoveryCodes[0], password: "replacement-password-84" },
  });
  assert.equal(reset.status, 200);
  assert.equal((await call("/api/me", { cookie: user.cookie })).status, 401);
  assert.equal((await call("/api/auth/login", { method: "POST", body: { email: "nick@example.test", password } })).status, 401);
  const newLogin = await call("/api/auth/login", { method: "POST", body: { email: "nick@example.test", password: "replacement-password-84" } });
  assert.equal(newLogin.status, 200);
  const replay = await call("/api/auth/recover", {
    method: "POST", ip: "203.0.113.12",
    body: { email: "nick@example.test", recoveryCode: user.body.recoveryCodes[0], password },
  });
  assert.equal(replay.status, 400);

  const rotated = await call("/api/auth/recovery-codes", {
    method: "POST", cookie: newLogin.headers.get("set-cookie")?.split(";")[0],
    body: { password: "replacement-password-84" },
  });
  assert.equal(rotated.status, 200);
  assert.equal((await rotated.json()).recoveryCodes.length, 10);
});

test("private manuscripts and link management stay owner-scoped; owners can revoke bearer links", async t => {
  const { call } = await fixture(t);
  const alice = await register(call, "alice@example.test", "203.0.113.20");
  const bob = await register(call, "bob@example.test", "203.0.113.21");
  const privateId = crypto.randomUUID();
  const privateDoc = { id: privateId, title: "Private draft", manuscript: "<TeXmacs|2.1.5>\n" };
  assert.equal((await call("/api/library", { method: "POST", cookie: alice.cookie, body: privateDoc })).status, 201);
  assert.deepEqual(await (await call("/api/library", { cookie: bob.cookie })).json(), []);
  assert.equal((await call("/api/library/" + privateId, { cookie: bob.cookie })).status, 404);
  assert.equal((await call("/api/library/" + privateId, { method: "PUT", cookie: bob.cookie, body: privateDoc })).status, 404);

  const createdRoom = await call("/api/manuscripts/room", {
    method: "POST", cookie: alice.cookie,
    body: { title: "Shared proof", manuscript: privateDoc.manuscript, owner: "forged-owner" },
  });
  assert.equal(createdRoom.status, 201);
  const roomId = (await createdRoom.json()).id;
  assert.equal((await call("/api/manuscripts/room/" + roomId)).status, 200);
  assert.deepEqual((await (await call("/api/account/links", { cookie: bob.cookie })).json()), []);
  assert.equal((await call("/api/account/links/" + roomId, { method: "DELETE", cookie: bob.cookie })).status, 404);
  assert.equal((await call("/api/manuscripts/room/" + roomId)).status, 200);

  const revoke = await call("/api/account/links/" + roomId, { method: "DELETE", cookie: alice.cookie });
  assert.equal(revoke.status, 200);
  assert.equal((await call("/api/manuscripts/room/" + roomId)).status, 404);
  const remaining = await (await call("/api/library", { cookie: alice.cookie })).json();
  assert.equal(remaining.some(row => row.id === roomId), false);
  assert.equal(remaining.some(row => row.id === privateId), true);
});

test("login throttling applies across IPs to one account", async t => {
  const { call } = await fixture(t);
  await register(call, "limit@example.test", "203.0.113.30");
  for (let index = 0; index < 12; index++) {
    const response = await call("/api/auth/login", {
      method: "POST", ip: `198.51.100.${index + 1}`,
      body: { email: "limit@example.test", password: "wrong-password" },
    });
    assert.equal(response.status, 401);
  }
  const blocked = await call("/api/auth/login", {
    method: "POST", ip: "198.51.100.50", body: { email: "limit@example.test", password },
  });
  assert.equal(blocked.status, 429);
});

test("room edit bursts are bounded and share creation has the existing daily cap", async t => {
  const { call, sqlite } = await fixture(t);
  const user = await register(call, "limits@example.test");
  const nonexistentRoom = await call(`/api/manuscripts/room/${crypto.randomUUID()}/changes`, {
    method: "POST", body: { id: crypto.randomUUID(), revision: 0, patch: "(patch spam)" },
  });
  assert.equal(nonexistentRoom.status, 404);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM room_change_limits").get().count, 0);
  const created = await call("/api/manuscripts/room", {
    method: "POST", cookie: user.cookie,
    body: { title: "Rate-limited room", manuscript: "<TeXmacs|2.1.5>\n" },
  });
  const id = (await created.json()).id;
  for (let revision = 0; revision < 60; revision++) {
    const response = await call(`/api/manuscripts/room/${id}/changes`, {
      method: "POST", body: { id: crypto.randomUUID(), revision, patch: "(patch " + revision + ")" },
    });
    assert.equal(response.status, 201);
  }
  assert.equal((await call(`/api/manuscripts/room/${id}/changes`, {
    method: "POST", body: { id: crypto.randomUUID(), revision: 60, patch: "(patch burst)" },
  })).status, 429);
  for (let index = 1; index < 20; index++) {
    assert.equal((await call("/api/manuscripts/copy", {
      method: "POST", cookie: user.cookie, body: { title: "Copy " + index, manuscript: "<TeXmacs|2.1.5>\n" },
    })).status, 201);
  }
  assert.equal((await call("/api/manuscripts/copy", {
    method: "POST", cookie: user.cookie, body: { title: "Over limit", manuscript: "<TeXmacs|2.1.5>\n" },
  })).status, 429);
});

test("state-changing account and share requests reject foreign origins", async t => {
  const { call } = await fixture(t);
  const user = await register(call, "origin@example.test");
  const privateId = crypto.randomUUID();
  assert.equal((await call("/api/library", {
    method: "POST", cookie: user.cookie, requestOrigin: "https://attacker.test",
    body: { id: privateId, title: "Cross-origin", manuscript: "<TeXmacs|2.1.5>\n" },
  })).status, 403);
  assert.equal((await call("/api/manuscripts/copy", {
    method: "POST", cookie: user.cookie, requestOrigin: "https://attacker.test",
    body: { title: "Cross-origin", manuscript: "<TeXmacs|2.1.5>\n" },
  })).status, 403);
  assert.equal((await call("/api/account/links", {
    method: "DELETE", cookie: user.cookie, requestOrigin: "https://attacker.test",
  })).status, 403);
  assert.equal((await call("/api/library", { cookie: user.cookie })).status, 200);
  assert.deepEqual(await (await call("/api/library", { cookie: user.cookie })).json(), []);
});
