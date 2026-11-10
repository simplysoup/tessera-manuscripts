import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

export async function startServer(extraEnv = {}) {
  const server = spawn(process.execPath, [new URL("../scripts/serve.mjs", import.meta.url).pathname], {
    env: { ...process.env, PORT: "0", ...extraEnv }, stdio: ["ignore", "pipe", "inherit"],
  });
  const [chunk] = await Promise.race([
    once(server.stdout, "data"),
    once(server, "exit").then(([code]) => { throw new Error("Server exited with " + code); }),
  ]);
  return { url: chunk.toString().trim().replace(/^Open /u, ""), close: () => server.kill() };
}

if (process.env.NODE_TEST_CONTEXT) {
  test("serves the pinned native editor, assets, examples and byte ranges", async t => {
    const server = await startServer();
    t.after(server.close);
    const get = (path, options) => fetch(server.url + path, options);
    const launch = await get("/?open=examples/nested-derivation.tm", { redirect: "manual" });
    assert.equal(launch.headers.get("location"), "/texmacs.html?open=examples/nested-derivation.tm");
    assert.match(await (await get("/")).text(), /Tessera/u);
    assert.match(await (await get("/legal/")).text(), /Exact TeXmacs Upsilon source revision/u);
    assert.match(await (await get("/legal/upstream-licenses/GPL-3.0.txt")).text(), /GNU GENERAL PUBLIC LICENSE/u);
    assert.match(await (await get("/legal/texmacs.html.txt")).text(), /tessera-embedded/u);
    assert.equal((await get("/app/style.css")).headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal((await get("/app/shortcuts.js")).headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal((await get("/")).headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal((await get("/legal/")).headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(await (await get("/texmacs.html")).text(), /TeXmacs Upsilon/u);
    const wasm = await get("/texmacs.wasm", { headers: { Range: "bytes=0-7" } });
    assert.equal(wasm.status, 206);
    assert.equal(wasm.headers.get("content-type"), "application/wasm");
    assert.deepEqual([...new Uint8Array(await wasm.arrayBuffer())], [0, 97, 115, 109, 1, 0, 0, 0]);
    const manifest = await (await get("/texmacs-files.json")).json();
    const boot = manifest.packages.find(pack => pack.boot);
    assert.equal((await get("/" + boot.gz, { method: "HEAD" })).status, 200);
    assert.equal((await get("/" + boot.url, { headers: { Range: "bytes=0-9" } })).status, 206);
    assert.match(await (await get("/examples/nested-derivation.tm")).text(), /<frac\|x<rsup\|2>/u);
    assert.equal((await get("/%2e%2e%2fpackage.json")).status, 404);
    assert.equal((await get("/tm-font-000000000000.otf")).status, 404);
  });

  test("state-changing API calls accept the proxied https origin", async t => {
    const server = await startServer();
    t.after(server.close);
    // fetch() forbids setting Origin, so use a raw request here.
    const post = headers => new Promise((resolve, reject) => {
      const url = new URL(server.url + "/api/library");
      const req = httpRequest({ method: "POST", hostname: url.hostname, port: url.port, path: url.pathname, headers: { "Content-Type": "application/json", ...headers } }, res => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end("{}");
    });
    // Same-origin POST passes the origin check (400: empty manuscript, not 403).
    assert.notEqual(await post({ Origin: server.url }), 403);
    // A foreign origin is still rejected.
    assert.equal(await post({ Origin: "https://example.com" }), 403);
    // Behind a proxy, X-Forwarded-Proto: https makes the https origin pass.
    assert.notEqual(await post({ Origin: server.url.replace(/^http:/u, "https:"), "X-Forwarded-Proto": "https" }), 403);
  });

  test("demo accounts register, sign in and persist to a file database", async t => {
    const dir = await mkdtemp(join(tmpdir(), "tessera-demo-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const env = { DEMO_INVITE_CODE: "demo-invite-code", TESSERA_DB_PATH: join(dir, "tessera.db") };
    const manuscript = await readFile(new URL("../web/examples/nested-derivation.tm", import.meta.url), "utf8");
    // fetch() sends no Origin header, and the worker requires one for
    // state-changing calls, so use raw requests here like a browser would.
    const call = (server, method, path, body, headers = {}) => new Promise((resolve, reject) => {
      const url = new URL(server.url + path);
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest({ method, hostname: url.hostname, port: url.port, path: url.pathname, headers: { Origin: server.url, ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...headers } }, res => {
        let text = "";
        res.on("data", chunk => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, json: () => JSON.parse(text) }));
      });
      req.on("error", reject);
      req.end(data);
    });
    const server = await startServer(env);
    t.after(server.close);
    assert.equal((await fetch(server.url + "/api/me")).status, 401);
    assert.equal((await call(server, "POST", "/api/auth/register", { email: "demo@example.com", password: "twelve-chars!", invite: "wrong" })).status, 403);
    const registered = await call(server, "POST", "/api/auth/register", { email: "demo@example.com", password: "twelve-chars!", invite: "demo-invite-code" });
    assert.equal(registered.status, 200);
    assert.equal(registered.json().recoveryCodes.length, 10);
    const session = registered.headers["set-cookie"]?.[0]?.split(";")[0];
    assert.ok((session ?? "").includes("tessera_session="));
    const created = await call(server, "POST", "/api/library", { id: "11111111-2222-3333-4444-555555555555", title: "demo", manuscript }, { Cookie: session });
    assert.equal(created.status, 201);
    // Restart: the account and manuscript survive in the file database.
    server.close();
    const restarted = await startServer(env);
    t.after(restarted.close);
    const library = await call(restarted, "GET", "/api/library", undefined, { Cookie: session });
    assert.equal(library.status, 200);
    assert.equal(library.json().length, 1);
    // A saved edit round-trips through PUT, which needs the request body forwarded.
    const updated = await call(restarted, "PUT", "/api/library/11111111-2222-3333-4444-555555555555", { id: "11111111-2222-3333-4444-555555555555", title: "demo edited", manuscript }, { Cookie: session });
    assert.equal(updated.status, 200);
    const fetched = await call(restarted, "GET", "/api/library/11111111-2222-3333-4444-555555555555", undefined, { Cookie: session });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.json().title, "demo edited");
  });
}
