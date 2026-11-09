import { documents, claim } from "./documents.js";
import { mountEditor, warmAssets } from "./engine.js";
import { readCopyLink } from "./sharing.js";
import { connectRoom, createLink, linkUrl, readLink } from "./live.js";

const $ = id => document.getElementById(id);
const utf8 = new TextEncoder();
const blank = `<TeXmacs|2.1.5>

<style|article>

<\\body>
  <section|Untitled section>

  \n</body>
`;
const templates = {
  blank: { title: "Untitled manuscript", format: "tm", bytes: utf8.encode(blank) },
  math: { title: "Math playground", format: "tm", path: "/examples/nested-derivation.tm" },
  latex: { title: "LaTeX example", format: "tex", path: "/examples/nested-import.tex" },
};
const formats = {
  pdf: ["pdf", "application/pdf"],
  latex: ["tex", "text/x-tex"],
  texmacs: ["tm", "application/octet-stream"],
};
const initialUrl = new URL(location.href);
let state;
let cache = [];
let noticeTimer;
let dialogAction;
let creating = false;
let libraryVersion = 0;

function notice(message) {
  $("notice").textContent = message;
  $("notice").hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $("notice").hidden = true; }, 4700);
}

function status(message, kind = "") {
  const indicator = $("save-status");
  if (indicator.lastElementChild.textContent !== message) {
    indicator.lastElementChild.textContent = message;
    indicator.title = message;
  }
  indicator.dataset.state = kind;
}

function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", "#" + name);
  svg.setAttribute("aria-hidden", "true");
  svg.append(use);
  return svg;
}

function showDrafts() {
  const list = $("drafts");
  const term = $("filter").value.trim().toLocaleLowerCase();
  const shown = cache.filter(draft => draft.title.toLocaleLowerCase().includes(term));
  $("count").hidden = cache.length === 0;
  $("count").textContent = cache.length;
  list.replaceChildren();
  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const mark = document.createElement("span");
    mark.className = "draft-icon";
    mark.append(icon(term ? "search" : "paper"));
    const text = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = term ? "No matching manuscripts" : "Nothing on the desk yet";
    const copy = document.createElement("p");
    copy.textContent = term ? "Try a different search." : "Start a manuscript or try a sample. Your drafts will appear here.";
    text.append(title, copy);
    empty.append(mark, text);
    list.append(empty);
    return;
  }
  for (const draft of shown) {
    const row = document.createElement("div");
    row.className = "draft";
    const open = document.createElement("button");
    open.className = "draft-open";
    const mark = document.createElement("span");
    mark.className = "draft-icon";
    mark.append(icon("paper"));
    const text = document.createElement("span");
    text.className = "draft-name";
    const name = document.createElement("strong");
    name.textContent = draft.title;
    const meta = document.createElement("span");
    meta.className = "draft-meta";
    meta.textContent = draft.room ? "Shared" : "Edited " + new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(draft.updated);
    meta.classList.toggle("shared", Boolean(draft.room));
    text.append(name, meta);
    open.append(mark, text);
    open.addEventListener("click", () => openDraft(draft.id));
    const remove = document.createElement("button");
    remove.className = "icon-button";
    remove.setAttribute("aria-label", "Delete " + draft.title);
    remove.append(icon("trash"));
    remove.addEventListener("click", () => ask({
      label: draft.room ? "SHARED MANUSCRIPT" : "PRIVATE MANUSCRIPT",
      title: draft.room ? "Remove this manuscript from your list?" : "Delete this draft?",
      copy: draft.room
        ? "“" + draft.title + "” will disappear from this browser. The shared manuscript and its invitation link will keep working for others."
        : "“" + draft.title + "” will be removed from this browser.",
      confirm: draft.room ? "Remove from list" : "Delete draft",
      action: async () => {
        const release = await claim(draft.id);
        if (!release) throw new Error("Close this manuscript in the other tab before deleting it.");
        try { await documents.remove(draft.id); }
        finally { release(); }
        await refresh();
        notice("Draft deleted.");
      },
    }));
    row.append(open, remove);
    list.append(row);
  }
}

async function refresh() {
  const version = ++libraryVersion;
  const drafts = await documents.list();
  if (version !== libraryVersion) return;
  cache = drafts.sort((a, b) => b.updated - a.updated);
  showDrafts();
}

function ask({ label, title, copy, confirm = "Done", name, field = "Manuscript name", maxLength = 90, action }) {
  $("dialog-label").textContent = label;
  $("dialog-title").textContent = title;
  $("dialog-copy").textContent = copy;
  $("dialog-confirm").textContent = confirm;
  $("name-field").hidden = name === undefined;
  $("name").value = name ?? "";
  $("name-label").textContent = field;
  $("name").maxLength = maxLength;
  $("name").required = name !== undefined;
  dialogAction = action;
  $("dialog").returnValue = "";
  $("dialog").showModal();
  if (name !== undefined) { $("name").focus(); $("name").select(); }
}

$("dialog").addEventListener("close", async () => {
  const action = dialogAction;
  dialogAction = undefined;
  if ($("dialog").returnValue !== "confirm" || !action) return;
  try { await action($("name").value.trim()); }
  catch (error) { notice(error.message); }
});

function enable(ready) {
  for (const id of ["rename", "save", "share"]) $(id).disabled = !ready;
  $("rename").disabled ||= Boolean(state?.draft?.room);
  const exports = $("exports");
  exports.firstElementChild.setAttribute("aria-disabled", String(!ready));
  for (const button of exports.querySelectorAll("button")) button.disabled = !ready;
  if (!ready) exports.open = false;
}

function studioUrl(id, room) {
  const url = new URL(location.href);
  for (const key of ["draft", "room", "copy", "open"]) url.searchParams.delete(key);
  url.hash = "";
  if (id) url.searchParams.set(room ? "room" : "draft", id);
  history.replaceState(null, "", url);
}

async function openDraft(id, shared, { replaceId } = {}) {
  if (state) return;
  const session = { controller: new AbortController(), busy: false };
  state = session;
  try {
    const local = await documents.get(id);
    const roomId = shared ? id : local?.roomId ?? (local?.room ? id : null);
    const room = Boolean(roomId);
    if (!room) {
      session.release = await claim(id);
      if (!session.release) throw new Error("This draft is already open in another tab.");
      if (!local) throw new Error("This manuscript is unavailable in this browser.");
    }
    const draft = room ? {
      ...await readLink("room", roomId, session.controller.signal), id: local?.id ?? roomId,
      roomId, room: true, updated: Date.now(),
    } : local;
    session.draft = draft;
    $("title").textContent = draft.title;
    $("studio").hidden = false;
    $("library").hidden = true;
    $("editor-hint").textContent = "Starting the editor…";
    $("editor-context").textContent = "Document";
    $("mode-label").textContent = "TYPESET VIEW";
    $("editor-host").dataset.ready = "false";
    $("editor-host").inert = true;
    $("editor-cover").hidden = false;
    $("cover-title").textContent = "Opening your manuscript";
    $("cover-copy").textContent = "Getting the writing room ready. You can go back while it loads.";
    $("resume-manuscript").hidden = true;
    $("draft-kind").textContent = "Shared";
    $("draft-state").hidden = !room;
    studioUrl(room ? roomId : id, room);
    status("Opening", "busy");
    enable(false);
    session.editor = await mountEditor($("editor-host"), draft, session.controller.signal, {
      onShortcut: insert,
      shortcutHint: message => { $("shortcut-hint").textContent = message; },
    });
    if (state !== session) return;
    if (room) {
      session.room = connectRoom(roomId, session.editor, (message, kind, error) => {
        if (state !== session) return;
        status(message, kind);
        if (message === "Sync paused") $("editor-hint").textContent = error.message + " Your local edits are still here. Use Export to keep a copy.";
      }, session.controller.signal);
      await session.room.start();
      if (state !== session) return;
      await documents.replace(replaceId ?? local?.id, {
        id: draft.id, roomId, room: true, title: draft.title, updated: draft.updated,
      });
    }
    syncView(session.editor);
    $("editor-host").dataset.ready = "true";
    $("editor-host").inert = false;
    $("editor-cover").hidden = true;
    $("editor-hint").textContent = "Tools follow the cursor. Choose View → Toolbars to control which rows are visible.";
    enable(true);
    if (draft.format === "tex") await save(session, true);
    else if (!room) status("Saved");
  } catch (error) {
    if (state !== session) return;
    if ($("studio").hidden) {
      session.release?.();
      state = undefined;
      studioUrl();
    } else {
      status(session.editor ? "Save failed" : "Editor unavailable", "error");
      $("editor-hint").textContent = error.message;
      $("cover-title").textContent = "Couldn’t open the manuscript";
      $("cover-copy").textContent = error.message;
    }
    notice(error.message);
  }
}

async function createDraft(template) {
  if (creating || state) return;
  creating = true;
  try {
    let { title, format, bytes } = template;
    if (!bytes) {
      const response = await fetch(template.path);
      if (!response.ok) throw new Error("The sample could not be loaded.");
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    const id = crypto.randomUUID();
    await documents.put({ id, title, format, bytes, updated: Date.now() });
    await openDraft(id);
  } catch (error) {
    notice(error.message);
  } finally {
    creating = false;
  }
}

function save(session, force = false) {
  if (session.room) return session.room.flush();
  if (session.saving) return session.saving;
  if (!session.editor || (!force && !session.retry && !session.editor.dirty())) return Promise.resolve();
  session.saving = (async () => {
    status("Saving", "busy");
    const bytes = session.editor.capture();
    const next = { ...session.draft, format: "tm", bytes, updated: Date.now() };
    await documents.put(next);
    session.draft = next;
    session.retry = false;
    if (state === session) status(session.editor.dirty() ? "Unsaved changes" : "Saved here");
  })().catch(error => {
    session.retry = true;
    if (state === session) status("Save failed", "error");
    throw error;
  }).finally(() => { session.saving = undefined; });
  return session.saving;
}

function returnToLibrary(session) {
  if (state !== session) return;
  session.controller.abort();
  try { session.room?.stop(); } catch { /* The editor may have been closed in the native menus. */ }
  session.release?.();
  state = undefined;
  $("editor-host").dataset.ready = "false";
  $("studio").hidden = true;
  $("library").hidden = false;
  studioUrl();
  $("new").focus({ preventScroll: true });
  refresh().catch(error => notice(error.message));
}

async function leave() {
  const session = state;
  if (!session || session.leaving) return;
  if (!session.editor || $("editor-host").inert) {
    returnToLibrary(session);
    return;
  }
  session.leaving = true;
  try {
    await session.renaming;
    await session.saving;
    await save(session);
    returnToLibrary(session);
  } catch {
    ask({
      label: session.room ? "SHARED MANUSCRIPT" : "PRIVATE MANUSCRIPT", title: "The latest changes couldn’t be saved",
      copy: "Cancel to keep editing or export a recovery copy. Returning now opens the library with the last saved version.",
      confirm: "Return with last saved",
      action: () => returnToLibrary(session),
    });
  } finally {
    session.leaving = false;
  }
}

function syncManuscriptMenu(editor) {
  const active = editor.active();
  $("resume-manuscript").hidden = active;
  if ($("save").disabled === active) enable(active);
  if (active) syncView(editor);
  else {
    $("editor-context").textContent = "Reference";
    $("mode-label").textContent = "AUXILIARY VIEW";
  }
}

function syncView(editor) {
  const source = editor.source();
  $("mode-label").textContent = source ? "SOURCE VIEW" : "TYPESET VIEW";
  try { $("editor-context").textContent = editor.context() || "Document"; } catch { $("editor-context").textContent = "Document"; }
}

$("new").addEventListener("click", () => createDraft(templates.blank));
document.querySelectorAll("[data-template]").forEach(button => button.addEventListener("click", () => createDraft(templates[button.dataset.template])));
$("filter").addEventListener("input", showDrafts);
$("import").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const extension = /\.(tm|tex)$/i.exec(file.name);
  if (!extension || file.size > 3 * 1024 * 1024 || file.size === 0) {
    notice("Choose a non-empty .tm or .tex file up to 3 MB.");
    return;
  }
  try {
    await createDraft({
      title: file.name.slice(0, extension.index).slice(0, 90) || "Imported manuscript",
      format: extension[1].toLowerCase(), bytes: new Uint8Array(await file.arrayBuffer()),
    });
  } catch (error) { notice(error.message); }
});

$("about").addEventListener("click", () => ask({
  label: "A QUICK TOUR", title: "Your writing room",
  copy: "Try Math playground to explore the editor. Click the page to edit and use Source to see its structure. Share lets you invite someone to edit together or send an editable copy.",
}));
$("back").addEventListener("click", leave);
$("save").addEventListener("click", async () => {
  if (!state?.editor) return;
  try { await save(state, true); }
  catch (error) { notice(error.message); }
});
$("rename").addEventListener("click", () => {
  const session = state;
  if (!session?.editor) return;
  ask({
    label: "MANUSCRIPT DETAILS", title: "Give it a name", name: session.draft.title,
    copy: "This is the name shown in your workspace and used for downloads.", confirm: "Rename",
    action: async name => {
      if (!name || state !== session || session.leaving) return;
      session.busy = true;
      session.renaming = (async () => {
        await session.saving;
        const next = { ...session.draft, title: name, updated: Date.now() };
        await documents.put(next);
        session.draft = next;
        $("title").textContent = name;
        session.editor.rename(name);
      })();
      try { await session.renaming; }
      finally {
        session.busy = false;
        session.renaming = undefined;
      }
    },
  });
});
$("resume-manuscript").addEventListener("click", () => {
  try {
    state.editor.resume();
    syncManuscriptMenu(state.editor);
  } catch (error) { notice(error.message); }
});
$("exports").firstElementChild.addEventListener("click", event => {
  if ($("save").disabled) event.preventDefault();
});
function insert(kind) {
  try { state.editor.insert(kind); }
  catch (error) { notice(error.message); }
}

function download(session, format) {
  const [suffix, type] = formats[format];
  const url = URL.createObjectURL(new Blob([session.editor.exportFile(format)], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = (session.draft.title.replace(/[\\/:*?"<>|]/g, "-") || "manuscript") + "." + suffix;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notice("Export downloaded.");
}

$("exports").querySelectorAll("[data-format]").forEach(button => button.addEventListener("click", () => {
  if (!state?.editor) return;
  $("exports").open = false;
  try { download(state, button.dataset.format); } catch (error) { notice(error.message); }
}));

function showShare(session) {
  $("start-room").hidden = Boolean(session.room);
  $("start-room").disabled = false;
  $("room-link-row").hidden = !session.room;
  $("room-link").value = session.room ? linkUrl("room", session.draft.roomId) : "";
  $("room-help").textContent = session.room
    ? "Anyone with workspace access and this invitation link can edit the same manuscript."
    : "This changes the manuscript from private to shared. Anyone with workspace access and the invitation link can edit it.";
  $("start-room").textContent = "Share & collaborate";
  $("start-copy").hidden = false;
  $("start-copy").disabled = false;
  $("copy-link-row").hidden = true;
  $("copy-link").value = "";
  $("copy-help").textContent = "Create a snapshot that opens as a separate draft, or download the native file.";
  if (!$("share-dialog").open) $("share-dialog").showModal();
}

$("share").addEventListener("click", () => {
  if (state?.editor) showShare(state);
});
$("start-room").addEventListener("click", async () => {
  const session = state;
  if (!session?.editor || session.room) return;
  $("start-room").disabled = true;
  $("room-help").textContent = "Creating your shared room…";
  try {
    await save(session);
    const id = await createLink("room", session.draft.title, session.editor.exportFile("texmacs"));
    if (state !== session) return;
    const showLink = $("share-dialog").open;
    $("share-dialog").close();
    await leave();
    if (state === session) throw new Error("Save this draft before sharing it.");
    await openDraft(id, true, { replaceId: session.draft.id });
    if (showLink && state?.room && !$("editor-host").inert) showShare(state);
  } catch (error) {
    $("room-help").textContent = error.message;
    if (!$("share-dialog").open) notice(error.message);
  } finally {
    $("start-room").disabled = false;
  }
});
$("start-copy").addEventListener("click", async () => {
  const session = state;
  if (!session?.editor) return;
  $("start-copy").disabled = true;
  $("copy-help").textContent = "Creating your copy…";
  try {
    const id = await createLink("copy", session.draft.title, session.editor.exportFile("texmacs"));
    if (state !== session || !$("share-dialog").open) return;
    $("copy-link").value = linkUrl("copy", id);
    $("copy-link-row").hidden = false;
    $("start-copy").hidden = true;
    $("copy-help").textContent = "Anyone with this link and workspace access can open a separate editable draft.";
  } catch (error) {
    $("copy-help").textContent = error.message;
  } finally {
    $("start-copy").disabled = false;
  }
});
for (const kind of ["copy", "room"]) {
  $(kind + "-link-button").addEventListener("click", async () => {
    const field = $(kind + "-link");
    try {
      await navigator.clipboard.writeText(field.value);
      $(kind + "-help").textContent = "Link copied.";
    } catch {
      field.focus();
      field.select();
      $(kind + "-help").textContent = "Use your keyboard’s copy shortcut to copy the selected link.";
    }
  });
}
$("share-download").addEventListener("click", () => {
  try { download(state, "texmacs"); } catch (error) { notice(error.message); }
});

const linkId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

async function openLink(url) {
  if (url.origin !== location.origin) throw new Error("Enter a link from this Tessera workspace.");
  const room = url.searchParams.get("room");
  const copy = url.searchParams.get("copy");
  if (room && linkId.test(room)) {
    await openDraft(room, true);
    return;
  }
  let manuscript;
  if (copy && linkId.test(copy)) manuscript = await readLink("copy", copy);
  else if (url.hash.startsWith("#copy=")) manuscript = await readCopyLink(url.hash);
  else throw new Error("Paste the complete manuscript link using Open a link.");
  ask({
    label: "EDITABLE MANUSCRIPT COPY", title: "Open “" + manuscript.title + "”?",
    copy: "Tessera will make a separate local draft. Open copies from people you trust.",
    confirm: "Open editable copy", action: () => createDraft(manuscript),
  });
}

$("open-link").addEventListener("click", () => ask({
  label: "MANUSCRIPT LINKS", title: "Open a manuscript link",
  copy: "Paste a shared manuscript link or an editable copy link.",
  confirm: "Open link", name: "", field: "Manuscript link", maxLength: 12500,
  action: async value => {
    let url;
    try { url = new URL(value); } catch { throw new Error("Enter the complete Tessera link."); }
    await openLink(url);
  },
}));

setInterval(() => {
  if (!state?.editor || state.busy || state.saving || state.leaving) return;
  try {
    syncManuscriptMenu(state.editor);
    if (!state.room) {
      if (state.editor.recentlyActive()) {
        state.autosaveDeferredAt ??= performance.now();
        if (performance.now() - state.autosaveDeferredAt < 8000) return;
      }
      state.autosaveDeferredAt = undefined;
      save(state).catch(() => {});
    }
  } catch { status("Editor unavailable", "error"); }
}, 2500);

addEventListener("beforeunload", event => {
  let pending = state?.saving || state?.retry || state?.renaming;
  try { pending ||= state?.room ? state.room.pending() : state?.editor?.dirty(); } catch { pending = true; }
  if (pending) {
    event.preventDefault();
    event.returnValue = "";
  }
});
addEventListener("focus", () => {
  if (!state) refresh().catch(error => notice(error.message));
});

try {
  await refresh();
  if (initialUrl.searchParams.has("room") || initialUrl.searchParams.has("copy") ||
      initialUrl.searchParams.get("open") === "copy" || initialUrl.hash.startsWith("#copy=")) {
    try { await openLink(initialUrl); }
    catch (error) { notice(error.message); }
  } else {
    const requested = initialUrl.searchParams.get("draft");
    if (requested) await openDraft(requested);
    else if (typeof requestIdleCallback === "function") requestIdleCallback(() => { if (!state) warmAssets(); });
  }
} catch (error) {
  notice("Browser storage is unavailable. " + error.message);
}
