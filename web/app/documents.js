const opened = new Promise((resolve, reject) => {
  const request = indexedDB.open("tessera-manuscripts", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("drafts", { keyPath: "id" });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function request(mode, operation) {
  const database = await opened;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("drafts", mode);
    const query = operation(transaction.objectStore("drafts"));
    transaction.oncomplete = () => resolve(query.result);
    transaction.onabort = () => reject(transaction.error ?? new Error("Browser storage closed the transaction."));
  });
}

export function claim(id) {
  if (!navigator.locks) return Promise.reject(new Error("This browser cannot lock a local manuscript."));
  return new Promise((resolve, reject) => {
    navigator.locks.request("tessera-draft:" + id, { ifAvailable: true }, lock => {
      if (!lock) {
        resolve(null);
        return;
      }
      return new Promise(release => resolve(release));
    }).catch(reject);
  });
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let account;
let cloudIds = new Set();

async function cloud(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(value?.error ?? "Could not sync your manuscript library.");
    error.status = response.status;
    throw error;
  }
  return value;
}

function fromCloud(row) {
  if (row.room) return {
    id: row.id, roomId: row.id, room: true, title: row.title,
    updated: row.updated, ownerId: account.sub,
  };
  return {
    id: row.id, title: row.title, format: "tm", bytes: encoder.encode(row.manuscript),
    updated: row.updated, ownerId: account.sub,
  };
}

async function writeCloud(draft, create = false) {
  if (!account || draft.room || draft.format !== "tm") return;
  draft.ownerId = account.sub;
  await cloud(create ? "/api/library" : "/api/library/" + draft.id, {
    method: create ? "POST" : "PUT",
    body: { id: draft.id, title: draft.title, manuscript: decoder.decode(draft.bytes) },
  });
}

async function syncLibrary() {
  account = await cloud("/api/me");
  const [local, remote] = await Promise.all([request("readonly", store => store.getAll()), cloud("/api/library")]);
  const cloudById = new Map(remote.map(row => [row.id, row]));
  cloudIds = new Set(remote.map(row => row.id));
  for (const draft of local) {
    if (draft.room || (draft.ownerId && draft.ownerId !== account.sub)) continue;
    if (!draft.ownerId) {
      draft.ownerId = account.sub;
      await request("readwrite", store => store.put(draft));
    }
    if (draft.format !== "tm") continue;
    const remoteDraft = cloudById.get(draft.id);
    if (!remoteDraft) {
      await writeCloud(draft, true);
      draft.ownerId = account.sub;
      await request("readwrite", store => store.put(draft));
      cloudById.set(draft.id, { id: draft.id, title: draft.title, manuscript: decoder.decode(draft.bytes), updated: draft.updated, room: 0 });
    } else if (!remoteDraft.room && draft.updated > remoteDraft.updated) {
      // Keep newer edits from the device that is signing in, then converge all
      // older local caches to the durable account copy below.
      await writeCloud(draft);
      cloudById.set(draft.id, { ...remoteDraft, title: draft.title, manuscript: decoder.decode(draft.bytes), updated: draft.updated });
    } else {
      if (remoteDraft.room) {
        await request("readwrite", store => store.put(fromCloud(remoteDraft)));
      } else {
        const stored = await cloud("/api/library/" + draft.id);
        await request("readwrite", store => store.put(fromCloud(stored)));
      }
    }
  }
  const synced = [];
  for (const remoteDraft of cloudById.values()) {
    if (remoteDraft.room) {
      const draft = fromCloud(remoteDraft);
      await request("readwrite", store => store.put(draft));
      synced.push(draft);
    } else {
      let cached = local.find(draft => draft.id === remoteDraft.id && draft.ownerId === account.sub);
      if (cached && cached.updated > remoteDraft.updated) {
        synced.push(cached);
      } else {
        const stored = await cloud("/api/library/" + remoteDraft.id);
        cached = fromCloud(stored);
        await request("readwrite", store => store.put(cached));
        synced.push(cached);
      }
    }
  }
  for (const draft of local) {
    if (draft.room && draft.ownerId === account.sub && !cloudById.has(draft.id)) synced.push(draft);
    else if (!cloudById.has(draft.id) && draft.ownerId === account.sub && draft.format !== "tm") synced.push(draft);
  }
  for (const draft of local) if (!draft.ownerId && draft.format !== "tm") synced.push(draft);
  return synced;
}

export const accountState = {
  current: () => account,
  initialize: async () => {
    try { return await syncLibrary(); }
    catch (error) {
      if (error.status === 401) { account = null; return null; }
      throw error;
    }
  },
  register: (email, password, invite) => cloud("/api/auth/register", { method: "POST", body: { email, password, invite } }),
  login: (email, password) => cloud("/api/auth/login", { method: "POST", body: { email, password } }),
  logout: async () => {
    if (account?.local) return;
    await cloud("/api/auth/logout", { method: "POST", body: {} });
    account = null;
    cloudIds = new Set();
  },
};

export const cloudDocuments = {
  list: async () => syncLibrary(),
  get: async id => {
    const draft = await request("readonly", store => store.get(id));
    return draft?.ownerId === account?.sub ? draft : undefined;
  },
  put: async draft => {
    if (account && !draft.room) draft.ownerId = account.sub;
    await request("readwrite", store => store.put(draft));
    if (account && !draft.room && draft.format === "tm") {
      const create = !cloudIds.has(draft.id);
      await writeCloud(draft, create);
      cloudIds.add(draft.id);
    }
    return draft;
  },
  replace: async (id, draft) => {
    if (account) draft.ownerId = account.sub;
    await request("readwrite", store => {
      const saved = store.put(draft);
      if (id && id !== draft.id) store.delete(id);
      return saved;
    });
    if (draft.room && account) {
      await cloud("/api/library/" + draft.roomId + "/seen", { method: "POST", body: {} });
      if (id && id !== draft.id && cloudIds.has(id)) {
        await cloud("/api/library/" + id, { method: "DELETE" });
        cloudIds.delete(id);
      }
    }
    else if (account && draft.format === "tm") {
      await writeCloud(draft, true);
      cloudIds.add(draft.id);
    }
    return draft;
  },
  remove: async id => {
    const draft = await request("readonly", store => store.get(id));
    if (account && draft?.ownerId === account.sub) {
      if (draft.room) await cloud("/api/library/" + draft.roomId + "/remove", { method: "DELETE" });
      else {
        await cloud("/api/library/" + id, { method: "DELETE" });
        cloudIds.delete(id);
      }
    }
    return request("readwrite", store => store.delete(id));
  },
};

export const documents = cloudDocuments;
