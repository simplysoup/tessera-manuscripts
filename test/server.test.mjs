import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

export async function startServer() {
  const server = spawn(process.execPath, [new URL("../scripts/serve.mjs", import.meta.url).pathname], {
    env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "inherit"],
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
}
