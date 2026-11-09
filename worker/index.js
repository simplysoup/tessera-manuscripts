const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const sizeLimit = 512 * 1024;
const sessionLifetime = 30 * 24 * 60 * 60 * 1000;
// Cloudflare Workers caps Web Crypto PBKDF2 at 100,000 iterations.
const passwordIterations = 100000;

function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
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

function decodeBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function digest(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

const bytesToHex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

function cookieValue(request, name) {
  const prefix = name + "=";
  const value = request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(prefix));
  return value?.slice(prefix.length);
}

function sessionCookie(token, request, clear = false) {
  const parts = ["tessera_session=" + (clear ? "" : token), "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=" + (clear ? "0" : Math.floor(sessionLifetime / 1000))];
  if (new URL(request.url).protocol === "https:") parts.push("Secure");
  return parts.join("; ");
}

async function passwordDigest(password, salt, iterations = passwordIterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

async function createSession(user, request, db) {
  const token = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = bytesToHex(await digest(new TextEncoder().encode(token)));
  const expires = Date.now() + sessionLifetime;
  await db.prepare("INSERT INTO demo_sessions (token_hash, owner_id, expires_at, created) VALUES (?, ?, ?, ?)")
    .bind(tokenHash, user.id, expires, Date.now()).run();
  return json({ user: { sub: user.id, email: user.email } }, 200, { "Set-Cookie": sessionCookie(token, request) });
}

async function consumeAuthAttempt(request, db) {
  const address = request.headers.get("cf-connecting-ip") ?? "local-development";
  const ipHash = bytesToHex(await digest(new TextEncoder().encode(address)));
  const now = Date.now();
  await db.prepare("DELETE FROM demo_auth_attempts WHERE attempted < ?").bind(now - 24 * 60 * 60 * 1000).run();
  const recent = await db.prepare("SELECT COUNT(*) AS count FROM demo_auth_attempts WHERE ip_hash = ? AND attempted > ?")
    .bind(ipHash, now - 15 * 60 * 1000).first();
  if (recent.count >= 12) return false;
  await db.prepare("INSERT INTO demo_auth_attempts (ip_hash, attempted) VALUES (?, ?)").bind(ipHash, now).run();
  return true;
}

async function identity(request, env) {
  // The local Node harness supplies a development-only identity.
  if (env.DEV_USER) return { sub: env.DEV_USER, email: env.DEV_USER, local: true };
  const sessionToken = cookieValue(request, "tessera_session");
  if (!sessionToken) return null;
  try {
    const tokenHash = bytesToHex(await digest(new TextEncoder().encode(sessionToken)));
    const user = await env.DB.prepare(`
      SELECT u.id AS sub, u.email FROM demo_sessions s
      JOIN demo_users u ON u.id = s.owner_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).bind(tokenHash, Date.now()).first();
    return user ?? null;
  } catch {
    return null;
  }
}

async function authenticate(request, env, url) {
  if (request.method === "GET" && url.pathname === "/api/me") {
    const user = await identity(request, env);
    return user ? json(user) : json({ error: "Sign in to your Tessera account." }, 401);
  }
  if (request.method !== "POST" || request.headers.get("origin") !== url.origin) {
    return json({ error: "Sign-in requests must come from Tessera." }, 403);
  }
  const value = await payload(request);
  if (!value) return json({ error: "Enter your account details." }, 400);
  if (url.pathname === "/api/auth/register") {
    if (!await consumeAuthAttempt(request, env.DB)) return json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
    if (!env.DEMO_INVITE_CODE) return json({ error: "Demo registration is not configured." }, 503);
    if (typeof value.invite !== "string" || !equalBytes(new TextEncoder().encode(value.invite), new TextEncoder().encode(env.DEMO_INVITE_CODE))) {
      return json({ error: "That demo access code isn’t valid." }, 403);
    }
    const email = typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
    const password = typeof value.password === "string" ? value.password : "";
    if (!/^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/u.test(email) || email.length > 254 ||
        password.length < 12 || password.length > 128 || new TextEncoder().encode(password).length > 512) {
      return json({ error: "Use a valid email and a password between 12 and 128 characters." }, 400);
    }
    const total = await env.DB.prepare("SELECT COUNT(*) AS count FROM demo_users").first();
    if (total.count >= 25) return json({ error: "The demo has reached its 25 account limit." }, 429);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await passwordDigest(password, salt);
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare("INSERT INTO demo_users (id, email, salt, password_hash, created) VALUES (?, ?, ?, ?, ?)")
        .bind(id, email, encodeBase64Url(salt), encodeBase64Url(hash), Date.now()).run();
    } catch {
      return json({ error: "An account with that email already exists." }, 409);
    }
    await env.DB.prepare("DELETE FROM demo_auth_attempts WHERE attempted < ?").bind(Date.now() - 24 * 60 * 60 * 1000).run();
    return createSession({ id, email }, request, env.DB);
  }
  if (url.pathname === "/api/auth/login") {
    if (!await consumeAuthAttempt(request, env.DB)) return json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
    const email = typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
    const password = typeof value.password === "string" ? value.password : "";
    const user = await env.DB.prepare("SELECT id, email, salt, password_hash FROM demo_users WHERE email = ?").bind(email).first();
    let valid = false;
    if (user && password.length <= 128) {
      const actual = await passwordDigest(password, decodeBase64Url(user.salt));
      valid = equalBytes(actual, decodeBase64Url(user.password_hash));
    }
    if (!valid) return json({ error: "Email or password is incorrect." }, 401);
    return createSession(user, request, env.DB);
  }
  if (url.pathname === "/api/auth/logout") {
    const user = await identity(request, env);
    const sessionToken = cookieValue(request, "tessera_session");
    if (user && sessionToken) {
      const tokenHash = bytesToHex(await digest(new TextEncoder().encode(sessionToken)));
      await env.DB.prepare("DELETE FROM demo_sessions WHERE token_hash = ?").bind(tokenHash).run();
    }
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", request, true) });
  }
  return json({ error: "Not found." }, 404);
}

function ownerId(request, url) {
  const [, , , id, action] = url.pathname.split("/");
  return { id, action };
}

async function library(request, url, db, user) {
  const { id, action } = ownerId(request, url);
  if (!id && request.method === "GET") {
    const { results } = await db.prepare(`
      SELECT id, title, manuscript, updated, 0 AS room FROM user_manuscripts WHERE owner_id = ?
      UNION ALL
      SELECT l.id, l.title, l.manuscript, l.created AS updated, 1 AS room FROM user_room_access a
      JOIN manuscript_links l ON l.id = a.room_id
      WHERE a.owner_id = ? AND l.kind = 'room'
      ORDER BY updated DESC
    `).bind(user.sub, user.sub).all();
    return json(results);
  }
  if (!id && request.method === "POST") {
    const value = await payload(request);
    if (!value || !uuid.test(value.id) || typeof value.title !== "string" || !value.title.trim() || value.title.length > 90 ||
        !small(value.manuscript) || !value.manuscript.startsWith("<TeXmacs|")) return json({ error: "Invalid manuscript." }, 400);
    const count = await db.prepare("SELECT COUNT(*) AS count FROM user_manuscripts WHERE owner_id = ?").bind(user.sub).first();
    if (count.count >= 100) return json({ error: "Your account has reached its 100 manuscript limit." }, 429);
    const now = Date.now();
    const saved = await db.prepare(`
      INSERT INTO user_manuscripts (id, owner_id, title, manuscript, updated)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `).bind(value.id, user.sub, value.title.trim(), value.manuscript, now).first();
    if (!saved) return json({ error: "That manuscript ID is already in use." }, 409);
    return json({ id: saved.id, updated: now }, 201);
  }
  if (!uuid.test(id ?? "")) return json({ error: "Manuscript not found." }, 404);
  if (action === "seen" && request.method === "POST") {
    const room = await db.prepare("SELECT id FROM manuscript_links WHERE id = ? AND kind = 'room'").bind(id).first();
    if (!room) return json({ error: "Manuscript not found." }, 404);
    await db.prepare("INSERT INTO user_room_access (owner_id, room_id, created) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .bind(user.sub, id, Date.now()).run();
    return json({ ok: true });
  }
  if (action === "remove" && request.method === "DELETE") {
    await db.prepare("DELETE FROM user_room_access WHERE owner_id = ? AND room_id = ?").bind(user.sub, id).run();
    return json({ ok: true });
  }
  if (action !== undefined) return json({ error: "Manuscript not found." }, 404);
  if (request.method === "GET") {
    const row = await db.prepare("SELECT id, title, manuscript, updated FROM user_manuscripts WHERE id = ? AND owner_id = ?")
      .bind(id, user.sub).first();
    return row ? json(row) : json({ error: "Manuscript not found." }, 404);
  }
  if (request.method === "PUT") {
    const value = await payload(request);
    if (!value || typeof value.title !== "string" || !value.title.trim() || value.title.length > 90 ||
        !small(value.manuscript) || !value.manuscript.startsWith("<TeXmacs|")) return json({ error: "Invalid manuscript." }, 400);
    const now = Date.now();
    const saved = await db.prepare(`UPDATE user_manuscripts SET title = ?, manuscript = ?, updated = ? WHERE id = ? AND owner_id = ? RETURNING id`)
      .bind(value.title.trim(), value.manuscript, now, id, user.sub).first();
    return saved ? json({ id, updated: now }) : json({ error: "Manuscript not found." }, 404);
  }
  if (request.method === "DELETE") {
    const deleted = await db.prepare("DELETE FROM user_manuscripts WHERE id = ? AND owner_id = ? RETURNING id").bind(id, user.sub).first();
    return deleted ? json({ ok: true }) : json({ error: "Manuscript not found." }, 404);
  }
  return json({ error: "Method not allowed." }, 405);
}

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
    const day = new Date().toISOString().slice(0, 10);
    const budget = await db.prepare(`
      INSERT INTO user_share_limits (owner_id, day, count) VALUES (?, ?, 1)
      ON CONFLICT (owner_id, day) DO UPDATE SET count = count + 1 WHERE count < 20
      RETURNING count
    `).bind(value.owner, day).first();
    if (!budget) return json({ error: "Your account has reached its 20 new share links per day limit." }, 429);
    await db.prepare("INSERT INTO manuscript_links (id, kind, title, manuscript, owner_id, created) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(key, kind, value.title, value.manuscript, value.owner, Date.now()).run();
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
          AND (SELECT COALESCE(SUM(length(CAST(patch AS BLOB))), 0) FROM room_changes WHERE room_id = ?) + length(CAST(? AS BLOB)) <= 20971520
        ON CONFLICT DO NOTHING RETURNING revision
      `).bind(id, value.revision + 1, value.id, value.patch, id, id, value.revision, id, value.patch).first();
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
    if (url.pathname === "/api/me" || url.pathname.startsWith("/api/auth/")) {
      try { return await authenticate(request, env, url); }
      catch (error) {
        console.error("Tessera account sign-in failed", error.name);
        return json({ error: "Account sign-in is temporarily unavailable." }, 503);
      }
    }
    if (url.pathname === "/api/library" || url.pathname.startsWith("/api/library/")) {
      try {
        const user = await identity(request, env);
        if (!user) return json({ error: "Sign in to your workspace." }, 401);
        if (request.method !== "GET" && request.headers.get("origin") !== url.origin) return json({ error: "Open Tessera to update a manuscript." }, 403);
        return await library(request, url, env.DB, user);
      } catch (error) {
        console.error("Tessera account storage failed", error.name);
        return json({ error: "Manuscript storage is temporarily unavailable." }, 503);
      }
    }
    if (!url.pathname.startsWith("/api/manuscripts/")) return env.ASSETS.fetch(request);
    if (request.method === "POST" && request.headers.get("origin") !== url.origin) {
      return json({ error: "Open Tessera to update a manuscript." }, 403);
    }
    try {
      if (request.method === "POST" && !url.pathname.endsWith("/changes")) {
        const user = await identity(request, env);
        if (!user) return json({ error: "Sign in to share a manuscript." }, 401);
        const original = request.clone();
        const value = await payload(original);
        if (!value) return json({ error: "Invalid manuscript." }, 400);
        const body = JSON.stringify({ ...value, owner: user.sub });
        return await links(new Request(request.url, { method: "POST", headers: { "Content-Type": "application/json" }, body }), url, env.DB);
      }
      return await links(request, url, env.DB);
    } catch (error) {
      console.error("Tessera manuscript storage failed", error.name);
      return json({ error: "Manuscript storage is temporarily unavailable." }, 503);
    }
  },
};
