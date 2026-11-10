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
  let backoff = 0;
  let last409Revision = -1;
  const native = editor.room();

  function pending() {
    return Boolean(outgoing || native.pending() || conflict);
  }

  // A local patch call throws when the editor cannot produce or apply a
  // patch (for example an undo the patch algebra cannot compound). The
  // pending patches are unchanged by the throw, so retrying would fail the
  // same way forever; pause instead and keep the local edits for export.
  function localCall(fn) {
    try {
      return fn();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const wrapped = new Error("The shared editor could not process a change" + (detail ? ": " + detail : "."));
      wrapped.cause = error;
      conflict = wrapped;
      throw wrapped;
    }
  }

  async function update() {
    for (;;) {
      signal.throwIfAborted();
      if (outgoing) {
        onStatus("Syncing", "busy");
        try {
          const receipt = await request(path, outgoing, signal);
          signal.throwIfAborted();
          localCall(() => native.accept(outgoing.patch));
          revision = receipt.revision;
        } catch (error) {
          if (error.status !== 409) throw error;
          localCall(() => native.restore(outgoing.patch));
          // If the room has not advanced since the last rejection, this
          // patch can never be accepted; pause instead of retrying it
          // forever. (This is the state a client is left in when a
          // revision it already holds is removed from the room.)
          if (revision === last409Revision) {
            conflict = new Error("The room has moved on from this version. Export your version to keep a copy, then reopen the room.");
            throw conflict;
          }
          last409Revision = revision;
        }
        outgoing = undefined;
      }
      const entries = await request(path + "?after=" + revision, undefined, signal);
      signal.throwIfAborted();
      for (const entry of entries) {
        if (!localCall(() => native.receive(entry.patch))) {
          conflict = new Error("Concurrent edits overlap. Export your version to keep it before reopening the shared room.");
          throw conflict;
        }
        revision = entry.revision;
      }
      if (entries.length === 16) continue;
      const patch = localCall(() => native.take());
      if (!patch) break;
      outgoing = { id: crypto.randomUUID(), revision, patch };
    }
    if (!stopped) onStatus("Synced");
  }

  function sync() {
    if (conflict) return Promise.reject(conflict);
    if (stopped) return Promise.resolve();
    if (!running) running = update().then(() => {
      backoff = 0;
    }).catch(error => {
      if (!stopped && !signal.aborted) {
        // A bad patch, a missing room, or a signed-out session cannot be
        // fixed by retrying; pause and keep the local edits for export.
        // Anything else is a transport problem, so reconnect with backoff.
        if (error.status === 400 || error.status === 401 || error.status === 404 || conflict) {
          if (!conflict) conflict = error;
          onStatus("Sync paused", "error", error);
        } else {
          backoff += 1;
          onStatus("Reconnecting", "error", error);
        }
      }
      throw error;
    }).finally(() => { running = undefined; });
    return running;
  }

  function poll() {
    sync().catch(() => {}).finally(() => {
      if (stopped || conflict) return;
      const delay = document.hidden ? 2000 : Math.min(650 * (2 ** backoff), 10000);
      timer = setTimeout(poll, delay);
    });
  }
  return {
    async start() {
      try {
        await sync();
      } catch (error) {
        // If the opening replay hit a patch this editor cannot apply,
        // the room is diverged, not unreachable: open it at the last
        // good revision (paused) so the work stays visible and
        // exportable, instead of failing the open outright. A transport
        // failure still rejects, so a room that cannot be reached at all
        // does not open empty.
        if (conflict) return;
        throw error;
      }
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
