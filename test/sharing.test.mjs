import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { createCopyLink, readCopyLink } from "../web/app/sharing.js";

test("a copy link carries the native manuscript without retaining its local draft ID", async () => {
  const original = await readFile(new URL("../web/examples/nested-derivation.tm", import.meta.url));
  const link = new URL(await createCopyLink("https://tessera.example/?draft=local-id", "A nested derivation", original));
  assert.equal(link.origin, "https://tessera.example");
  assert.equal(link.search, "?open=copy");
  assert.deepEqual(await readCopyLink(link.hash), {
    title: "A nested derivation", format: "tm", bytes: new Uint8Array(original),
  });
});

test("invalid versions and corrupt data cannot open a draft", async () => {
  await assert.rejects(readCopyLink("#copy=v2.data"), /unsupported format/u);
  await assert.rejects(readCopyLink("#copy=v1.invalid"), /damaged/u);
});

test("oversized manuscripts use file export and incoming links have an expansion limit", async () => {
  const body = "<TeXmacs|2.1.5>\n" + "x".repeat(256 * 1024);
  await assert.rejects(createCopyLink("https://tessera.example/", "Large", Buffer.from(body)), /Download a .tm/u);
  const token = gzipSync(JSON.stringify({ title: "Large", document: body })).toString("base64url");
  await assert.rejects(readCopyLink("#copy=v1." + token), /too large/u);
});
