const encoder = new TextEncoder();

class RequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, data, signal) {
  const options = { signal, cache: "no-store", credentials: "include" };
  if (data !== undefined) Object.assign(options, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  const response = await fetch("/api/manuscripts/" + path, options);
  const value = await response.json().catch(() => null);
  if (!response.ok || value === null) {
    throw new RequestError(value?.error ?? "Couldn’t reach Tessera manuscript storage.", response.status);
  }
  return value;
}

export async function createLink(kind, title, bytes) {
  return (await request(kind, { title, manuscript: new TextDecoder().decode(bytes) })).id;
}

export async function readLink(kind, id, signal) {
  const value = await request(kind + "/" + id, undefined, signal);
  return { title: value.title, format: "tm", bytes: encoder.encode(value.manuscript) };
}

export function linkUrl(kind, id) {
  const url = new URL("/", location.origin);
  url.searchParams.set(kind, id);
  return url.href;
}

export function connectRoom(id, editor, onStatus, signal) {
  const path = "room/" + id + "/changes";
  let revision = 0;
  let outgoing;
  let running;
  let conflict;
  let stopped = false;
  let timer;
  const native = editor.room();

  function pending() {
    return Boolean(outgoing || native.pending() || conflict);
  }

  async function update() {
    for (;;) {
      signal.throwIfAborted();
      if (outgoing) {
        onStatus("Syncing", "busy");
        try {
          const receipt = await request(path, outgoing, signal);
          signal.throwIfAborted();
          native.accept(outgoing.patch);
          revision = receipt.revision;
        } catch (error) {
          if (error.status !== 409) throw error;
          native.restore(outgoing.patch);
        }
        outgoing = undefined;
      }
      const entries = await request(path + "?after=" + revision, undefined, signal);
      signal.throwIfAborted();
      for (const entry of entries) {
        if (!native.receive(entry.patch)) {
          conflict = new Error("Concurrent edits overlap. Export your version to keep it before reopening the shared room.");
          throw conflict;
        }
        revision = entry.revision;
      }
      if (entries.length === 16) continue;
      const patch = native.take();
      if (!patch) break;
      outgoing = { id: crypto.randomUUID(), revision, patch };
    }
    if (!stopped) onStatus("Synced");
  }

  function sync() {
    if (conflict) return Promise.reject(conflict);
    if (stopped) return Promise.resolve();
    if (!running) running = update().catch(error => {
      if (!stopped && !signal.aborted) {
        if (error.status === 400) conflict = error;
        onStatus(conflict ? "Sync paused" : "Reconnecting", "error", error);
      }
      throw error;
    }).finally(() => { running = undefined; });
    return running;
  }

  function poll() {
    sync().catch(() => {}).finally(() => {
      if (!stopped && !conflict) timer = setTimeout(poll, document.hidden ? 2000 : 650);
    });
  }
  return {
    async start() {
      await sync();
      timer = setTimeout(poll, 650);
    },
    async flush() {
      await sync();
      while (pending()) await sync();
    },
    pending,
    stop() {
      stopped = true;
      clearTimeout(timer);
      native.stop();
    },
  };
}
