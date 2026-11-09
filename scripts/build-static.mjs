import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../", import.meta.url));
const engine = join(root, "engine");
const output = join(root, "dist");
const dist = join(output, "client");
await rm(output, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await mkdir(join(output, "server"));
await cp(join(root, "worker/index.js"), join(output, "server/index.js"));
await cp(join(root, "web/app"), join(dist, "app"), { recursive: true });
await cp(join(root, "web/app/index.html"), join(dist, "index.html"));
await cp(join(root, "web/examples"), join(dist, "examples"), { recursive: true });
for (const entry of await readdir(engine, { withFileTypes: true })) {
  if (entry.isFile()) await cp(join(engine, entry.name), join(dist, entry.name));
}
for (const file of await readdir(join(engine, "fonts"))) {
  await cp(join(engine, "fonts", file), join(dist, file));
}
const manifest = JSON.parse(await readFile(join(engine, "texmacs-files.json")));
for (const pack of manifest.packages) {
  const bytes = gunzipSync(await readFile(join(engine, pack.gz)));
  await writeFile(join(dist, pack.url), bytes);
}
