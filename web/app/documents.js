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

export const documents = {
  list: () => request("readonly", store => store.getAll()),
  get: id => request("readonly", store => store.get(id)),
  put: draft => request("readwrite", store => store.put(draft)),
  remove: id => request("readwrite", store => store.delete(id)),
};

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
