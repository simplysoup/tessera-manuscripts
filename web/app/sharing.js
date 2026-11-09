const limit = 12000;
const expandedLimit = 256 * 1024;
const encoder = new TextEncoder();

async function readBounded(stream, maximum) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw new Error("This manuscript is too large for a copy link. Download a .tm file instead.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decode(value) {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
}

export async function createCopyLink(base, title, bytes) {
  if (bytes.length > expandedLimit) throw new Error("This manuscript is too large for a copy link. Download a .tm file instead.");
  const payload = JSON.stringify({ title, document: new TextDecoder().decode(bytes) });
  const data = new Blob([payload]);
  if (data.size > expandedLimit) throw new Error("This manuscript is too large for a copy link. Download a .tm file instead.");
  const packed = await readBounded(data.stream().pipeThrough(new CompressionStream("gzip")), limit);
  const token = encode(packed);
  if (token.length > limit) throw new Error("This manuscript is too large for a copy link. Download a .tm file instead.");
  const url = new URL("/?open=copy", base);
  url.hash = "copy=v1." + token;
  return url.href;
}

export async function readCopyLink(hash) {
  const prefix = "#copy=v1.";
  if (!hash.startsWith(prefix)) throw new Error("This copy link uses an unsupported format.");
  const token = hash.slice(prefix.length);
  if (!token || token.length > limit || !/^[A-Za-z0-9_-]+$/u.test(token)) throw new Error("This copy link is invalid.");
  let value;
  try {
    const stream = new Blob([decode(token)]).stream().pipeThrough(new DecompressionStream("gzip"));
    value = JSON.parse(new TextDecoder().decode(await readBounded(stream, expandedLimit)));
  } catch {
    throw new Error("This copy link is damaged or too large.");
  }
  if (typeof value?.title !== "string" || !value.title.trim() || value.title.length > 90 ||
      typeof value.document !== "string" || !value.document.startsWith("<TeXmacs|")) {
    throw new Error("This copy link does not contain a Tessera manuscript.");
  }
  return { title: value.title, format: "tm", bytes: encoder.encode(value.document) };
}
