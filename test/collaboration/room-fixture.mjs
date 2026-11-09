// Test-only checkpoint and patch journal. The clock is controlled by the
// caller so host expiry and delayed commits are reproducible.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export function openRoom(path, now, initial) {
  function read() {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  function write(state) {
    const temporary = path + ".tmp";
    writeFileSync(temporary, JSON.stringify(state));
    renameSync(temporary, path);
  }
  try {
    read();
  } catch (error) {
    if (error.code !== "ENOENT" || initial === undefined) throw error;
    write({ initial, lease: null, revision: 0, log: [] });
  }

  function claim(owner, ttl) {
    const state = read();
    if (state.lease?.until > now()) return null;
    state.lease = { owner, generation: (state.lease?.generation ?? 0) + 1, until: now() + ttl };
    write(state);
    return state.lease;
  }

  function append(lease, expectedRevision, operation, patch) {
    const state = read();
    if (state.lease?.generation !== lease.generation || state.lease.owner !== lease.owner ||
        state.lease.until <= now()) return { status: "stale-host" };
    const saved = state.log.find(entry => entry.id === operation.id);
    if (saved) {
      const sameOperation = saved.sourcePatch === operation.patch && saved.author === operation.author &&
        saved.baseRevision === operation.baseRevision;
      return sameOperation ? { status: "duplicate", revision: saved.revision } : { status: "id-conflict" };
    }
    if (expectedRevision !== state.revision) return { status: "stale-revision" };
    state.revision++;
    state.log.push({
      id: operation.id, author: operation.author, baseRevision: operation.baseRevision,
      sourcePatch: operation.patch, patch, revision: state.revision,
    });
    write(state);
    return { status: "saved", revision: state.revision };
  }

  return { read, claim, append };
}
