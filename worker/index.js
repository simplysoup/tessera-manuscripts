const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const sizeLimit = 512 * 1024;

function json(value, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

async function payload(request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * sizeLimit) return null;
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

const small = text => typeof text === "string" && new TextEncoder().encode(text).length <= sizeLimit;

async function links(request, url, db) {
  const [, , , kind, id, action, extra] = url.pathname.split("/");
  const method = request.method;
  if (extra !== undefined || !["copy", "room"].includes(kind) ||
      (id !== undefined && !uuid.test(id))) return json({ error: "Link not found." }, 404);

  if (!id && method === "POST") {
    const value = await payload(request);
    if (!value || typeof value.title !== "string" || !value.title.trim() || value.title.length > 90 ||
        !small(value.manuscript) || !value.manuscript.startsWith("<TeXmacs|")) {
      return json({ error: "Choose a native manuscript under 512 KB to create a link." }, 400);
    }
    const key = crypto.randomUUID();
    await db.prepare("INSERT INTO manuscript_links VALUES (?, ?, ?, ?)").bind(key, kind, value.title, value.manuscript).run();
    return json({ id: key }, 201);
  }

  if (id && action === undefined && method === "GET") {
    const row = await db.prepare("SELECT title, manuscript FROM manuscript_links WHERE id = ? AND kind = ?").bind(id, kind).first();
    return row ? json(row) : json({ error: "This manuscript link is unavailable." }, 404);
  }

  if (id && kind === "room" && action === "changes") {
    if (method === "GET") {
      const since = Number(url.searchParams.get("after") ?? 0);
      if (!Number.isSafeInteger(since) || since < 0) return json({ error: "Invalid room revision." }, 400);
      const { results } = await db.prepare(
        "SELECT revision, patch FROM room_changes WHERE room_id = ? AND revision > ? ORDER BY revision LIMIT 16"
      ).bind(id, since).all();
      return json(results);
    }

    if (method === "POST") {
      const value = await payload(request);
      if (!value || !uuid.test(value.id) || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
          !small(value.patch) || !value.patch.startsWith("(")) return json({ error: "Invalid manuscript change." }, 400);
      // Checking the head and inserting the next revision is one SQLite statement.
      const saved = await db.prepare(`
        INSERT INTO room_changes (room_id, revision, operation_id, patch)
        SELECT ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM manuscript_links WHERE id = ? AND kind = 'room')
          AND COALESCE((SELECT MAX(revision) FROM room_changes WHERE room_id = ?), 0) = ?
        ON CONFLICT DO NOTHING RETURNING revision
      `).bind(id, value.revision + 1, value.id, value.patch, id, id, value.revision).first();
      if (saved) return json(saved, 201);
      const prior = await db.prepare(
        "SELECT revision, patch FROM room_changes WHERE room_id = ? AND operation_id = ?"
      ).bind(id, value.id).first();
      if (prior && prior.revision === value.revision + 1 && prior.patch === value.patch) return json({ revision: prior.revision });
      return json({ error: "The room has advanced." }, 409);
    }
  }

  return json({ error: "Link not found." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/manuscripts/")) return env.ASSETS.fetch(request);
    if (request.method === "POST" && request.headers.get("origin") !== url.origin) {
      return json({ error: "Open Tessera to update a manuscript." }, 403);
    }
    try {
      return await links(request, url, env.DB);
    } catch (error) {
      console.error("Tessera manuscript storage failed", error.name);
      return json({ error: "Manuscript storage is temporarily unavailable." }, 503);
    }
  },
};
