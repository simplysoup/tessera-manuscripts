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
  // A room reports the revision its stored manuscript covers; a copy link
  // has no revision, so it reads as 0.
  return { title: value.title, format: "tm", bytes: encoder.encode(value.manuscript), snapshotRevision: value.snapshot_revision ?? 0 };
}

export function linkUrl(kind, id) {
  const url = new URL("/", location.origin);
  url.searchParams.set(kind, id);
  return url.href;
}

export function connectRoom(id, editor, onStatus, signal, startRevision = 0) {
  const path = "room/" + id + "/changes";
  // A joining client starts from the server's checkpoint instead of
  // revision 0, so it fetches only the changes after the checkpoint and
  // never replays a patch the checkpoint already absorbed.
  let revision = startRevision;
  // The revision the server's stored manuscript covers. A snapshot upload
  // advances it; the change log itself is untouched.
  let snapshotRevision = startRevision;
  let outgoing;
  let running;
  let conflict;
  let stopped = false;
  let timer;
  let backoff = 0;
  let last409Revision = -1;
  let snapshotting = false;
  const native = editor.room();
  // A synced client checkpoints the room this many revisions past the last
  // checkpoint, so a client joining later starts from a recent document.
  const snapshotGap = 25;

  // Upload a checkpoint of the current document. Best effort: a snapshot
  // that is rejected (another client checkpointed further, or the document
  // is too large) just leaves the room on its previous checkpoint, and the
  // change log still replays. Only a synced client snapshots, so the
  // document it exports is exactly the document at the revision it sends.
  async function snapshot() {
    if (stopped || conflict || snapshotting || revision <= snapshotRevision) return false;
    if (typeof editor.exportFile !== "function") return false;
    snapshotting = true;
    try {
      const at = revision;
      const manuscript = new TextDecoder().decode(editor.exportFile("texmacs"));
      // A manuscript may carry embedded images, so its limit is 10 MB,
      // not the 512 KB patch limit; a larger export simply never snapshots.
      if (!manuscript.startsWith("<TeXmacs|") || encoder.encode(manuscript).length > 10 * 1024 * 1024) return false;
      const receipt = await request("room/" + id + "/snapshot", { revision: at, manuscript }, signal);
      snapshotRevision = receipt.snapshot_revision;
      return true;
    } catch {
      return false;
    } finally {
      snapshotting = false;
    }
  }

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
      if (revision - snapshotRevision >= snapshotGap) snapshot();
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
    snapshot,
    pending,
    stop() {
      stopped = true;
      clearTimeout(timer);
      native.stop();
    },
  };
}
