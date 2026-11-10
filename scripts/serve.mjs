import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/index.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const engine = join(root, "engine");
const cache = join(root, ".cache");
const manifest = JSON.parse(await readFile(join(engine, "texmacs-files.json"), "utf8"));
const packGzip = new Map(manifest.packages.map(pack => [pack.url, pack.gz]));
const fonts = new Map(manifest.lazy.map(([, file, size]) => [file, size]));
const engineFiles = new Set([
  "texmacs.html", "texmacs.js", "texmacs.wasm.gz", "texmacs-files.json", "favicon.ico",
  ...[16, 32, 64, 128, 192, 256, 512].map(size => "texmacs-vue-" + size + ".png"),
  ...packGzip.values(),
]);
const appFiles = new Set(["index.html", "style.css", "workspace.js", "documents.js", "engine.js", "shortcuts.js", "native-room.js", "live.js", "sharing.js", "command-search.js", "mark.svg"]);
const examples = new Set(["nested-derivation.tm", "nested-import.tex"]);
const tutorials = new Set(["matrices.tm", "macros.tm", "references.tm", "structure.tm", "formatting.tm", "file-workflows.tm"]);
const upstream = "https://mgubi.github.io/texmacs/";
const types = {
  ".css": "text/css; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".patch": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".gz": "application/gzip",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".tm": "text/plain; charset=utf-8",
  ".tex": "text/plain; charset=utf-8",
};
const downloads = new Map();

const sqlite = new DatabaseSync(":memory:");
for (const migration of ["0000_manuscript_links.sql", "0001_account_manuscripts.sql", "0002_demo_accounts.sql", "0003_recovery_privacy_limits.sql"]) {
  sqlite.exec(await readFile(join(root, "drizzle", migration), "utf8"));
}
const DB = {
  prepare(sql) {
    const statement = sqlite.prepare(sql);
    return { bind: (...parameters) => ({
      run: async () => statement.run(...parameters),
      first: async () => statement.get(...parameters),
      all: async () => ({ results: statement.all(...parameters) }),
    }) };
  },
};

function verifyFont(file, bytes) {
  const digest = /^tm-font-([a-f0-9]{12})\./u.exec(file)?.[1];
  if (!digest || bytes.length !== fonts.get(file) ||
      !createHash("sha1").update(bytes).digest("hex").startsWith(digest)) {
    throw new Error("Font does not match the pinned manifest: " + file);
  }
  return bytes;
}

async function fetchFont(file) {
  try {
    return verifyFont(file, await readFile(join(engine, "fonts", file)));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    return verifyFont(file, await readFile(join(cache, file)));
  } catch {
    const response = await fetch(new URL(file, upstream), {
      redirect: "error", signal: AbortSignal.timeout(18000),
    });
    if (!response.ok) throw new Error("Upstream font request returned " + response.status);
    const bytes = verifyFont(file, Buffer.from(await response.arrayBuffer()));
    await mkdir(cache, { recursive: true });
    const temporary = join(cache, file + "." + process.pid + ".part");
    await writeFile(temporary, bytes);
    await rename(temporary, join(cache, file));
    return bytes;
  }
}

async function load(path) {
  const file = basename(path);
  if (path === "/" || (path === "/app/" + file && appFiles.has(file))) {
    return readFile(join(root, "web/app", path === "/" ? "index.html" : file));
  }
  if (path === "/examples/" + file && examples.has(file)) return readFile(join(root, "web/examples", file));
  if (path === "/tutorials/" + file && tutorials.has(file)) return readFile(join(root, "web/tutorials", file));
  if (path === "/legal/" || path === "/legal/index.html") return readFile(join(root, "web/legal/index.html"));
  if (path === "/legal/upsilon/" + file && /^(?:README\.md|000[1-7]-[a-z-]+\.patch)$/u.test(file)) {
    return readFile(join(root, "upsilon", file)).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  if (path === "/legal/texmacs.html.txt") return readFile(join(engine, "texmacs.html"));
  if (path === "/legal/" + file && ["PORT.md", "ENGINE-SHA256.txt", "COLLABORATION.md"].includes(file)) {
    return readFile(join(root, "docs", file));
  }
  if (path === "/legal/upstream-licenses/" + file && /^[A-Za-z0-9.-]+\.(?:txt|md)$/u.test(file)) {
    return readFile(join(root, "docs/upstream-licenses", file)).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  if (path !== "/" + file) return undefined;
  if (engineFiles.has(file)) return readFile(join(engine, file));
  const compressed = packGzip.get(file) ?? (file === "texmacs.wasm" ? "texmacs.wasm.gz" : undefined);
  if (compressed) return gunzipSync(await readFile(join(engine, compressed)));
  if (!fonts.has(file)) return undefined;
  if (!downloads.has(file)) downloads.set(file, fetchFont(file).finally(() => downloads.delete(file)));
  return downloads.get(file);
}

function respond(request, response, path, bytes) {
  const headers = {
    "Content-Type": types[extname(path)] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  };
  if (request.headers.range) {
    const range = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range);
    const start = Number(range?.[1]);
    const end = Math.min(range?.[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1);
    if (!range || start >= bytes.length || end < start) {
      response.writeHead(416, { "Content-Range": "bytes */" + bytes.length }).end();
      return;
    }
    headers["Content-Range"] = `bytes ${start}-${end}/${bytes.length}`;
    bytes = bytes.subarray(start, end + 1);
  }
  headers["Content-Length"] = bytes.length;
  response.writeHead(request.headers.range ? 206 : 200, headers);
  response.end(request.method === "HEAD" ? undefined : bytes);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://" + request.headers.host);
    const path = decodeURIComponent(url.pathname);
    if (path === "/api/me" || path === "/api/library" || path.startsWith("/api/library/") || path.startsWith("/api/manuscripts/")) {
      const options = { method: request.method, headers: request.headers };
      if (request.method === "POST") Object.assign(options, { body: Readable.toWeb(request), duplex: "half" });
      const result = await worker.fetch(new Request(url, options), { DB, DEV_USER: "local-development-user" });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    if (path === "/" && url.searchParams.get("open") !== "copy" && ["open", "file", "x"].some(key => url.searchParams.has(key))) {
      response.writeHead(302, { Location: "/texmacs.html" + url.search }).end();
      return;
    }
    const bytes = await load(path);
    if (!bytes) response.writeHead(404).end();
    else respond(request, response, path, bytes);
  } catch (error) {
    console.error(error.message);
    response.writeHead(503).end("Could not load editor asset.");
  }
});

const { values } = parseArgs({ options: {
  host: { type: "string", default: "127.0.0.1" },
  port: { type: "string", default: process.env.PORT ?? "4173" },
}, strict: false });
server.listen(Number(values.port), values.host, () => {
  console.log("Open http://127.0.0.1:" + server.address().port);
});
