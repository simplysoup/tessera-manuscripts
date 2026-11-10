import { documents, claim, accountState } from "./documents.js";
import { mountEditor, warmAssets } from "./engine.js";
import { readCopyLink } from "./sharing.js";
import { connectRoom, createLink, linkUrl, readLink } from "./live.js";
import { searchEditor, editorTutorials } from "./command-search.js";
import { commandKeys } from "./shortcuts.js";

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
  for (const id of ["rename", "save", "share", "feature-search"]) $(id).disabled = !ready;
  $("rename").disabled ||= Boolean(state?.draft?.room);
  const localOnly = Boolean(accountState.current()?.localOnly);
  $("share").disabled ||= localOnly;
  $("share").title = localOnly ? "Local manuscripts can’t be shared by link. Export a file instead." : "Share manuscript";
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
      ...await readLink("room", roomId, session.controller.signal), id: roomId,
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
    const localOnly = Boolean(accountState.current()?.localOnly);
    $("editor-hint").textContent = localOnly
      ? "Saved only in this browser. Export a file to move or share it."
      : "Tools follow the cursor. Choose View → Toolbars to control which rows are visible.";
    $("draft-kind").textContent = localOnly ? "Local only" : "Shared";
    $("draft-state").hidden = !room && !localOnly;
    enable(true);
    if (draft.format === "tex") await save(session, true);
    else if (!room) status(localOnly ? "Saved locally" : "Saved");
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
    status(accountState.current()?.localOnly ? "Saving locally" : "Saving", "busy");
    const bytes = session.editor.capture();
    const next = { ...session.draft, format: "tm", bytes, updated: Date.now() };
    await documents.put(next);
    session.draft = next;
    session.retry = false;
    if (state === session) status(session.editor.dirty() ? "Unsaved changes" : accountState.current()?.localOnly ? "Saved locally" : "Saved");
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
async function loadAccountLinks() {
  const target = $("account-links");
  target.replaceChildren();
  const links = await accountState.sharedLinks();
  if (!links.length) {
    const empty = document.createElement("p");
    empty.className = "account-links-empty";
    empty.textContent = "You have no active share links.";
    target.append(empty);
    return;
  }
  for (const link of links) {
    const row = document.createElement("div");
    row.className = "account-link-row";
    const details = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = link.title;
    const kind = document.createElement("small");
    kind.textContent = link.kind === "room" ? "Shared editing room" : "Editable copy link";
    details.append(title, kind);
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "button outline";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", () => ask({
      label: "SHARED LINK",
      title: "Revoke this link?",
      copy: "New visitors will lose access. A person who already made or downloaded a copy will keep that copy.",
      confirm: "Revoke link",
      action: async () => {
        const active = state?.room && state.draft.roomId === link.id ? state : undefined;
        if (active) await active.room.flush();
        await accountState.revokeSharedLink(link.id);
        if (active) returnToLibrary(active);
        await loadAccountLinks();
        notice("Share link revoked.");
      },
    }));
    row.append(details, revoke);
    target.append(row);
  }
}

$("account").addEventListener("click", async () => {
  const user = accountState.current();
  if (user?.localOnly) {
    try {
      await accountState.logout();
      $("library").hidden = true;
      $("auth-screen").hidden = false;
      setAuthMode("login");
    } catch (error) { notice(error.message); }
    return;
  }
  if (!user || user.local) return;
  $("account-email").textContent = user.email;
  try {
    await loadAccountLinks();
    $("account-dialog").showModal();
  } catch (error) { notice(error.message); }
});
$("generate-recovery-codes").addEventListener("click", async () => {
  const button = $("generate-recovery-codes");
  const password = $("recovery-current-password").value;
  if (!password) return notice("Enter your current password first.");
  button.disabled = true;
  try {
    const result = await accountState.rotateRecoveryCodes(password);
    $("recovery-current-password").value = "";
    $("account-dialog").close();
    showRecoveryCodes(result.recoveryCodes, () => $("account-dialog").showModal());
  } catch (error) { notice(error.message); }
  finally { button.disabled = false; }
});
$("account-sign-out").addEventListener("click", async () => {
  try {
    await accountState.logout();
    state = undefined;
    cache = [];
    $("account-dialog").close();
    $("library").hidden = true;
    $("studio").hidden = true;
    $("auth-screen").hidden = false;
    setAuthMode("login");
  } catch (error) { notice(error.message); }
});
document.querySelectorAll("[data-template]").forEach(button => button.addEventListener("click", () => createDraft(templates[button.dataset.template])));
document.querySelectorAll("[data-tutorial]").forEach(button => button.addEventListener("click", () => {
  const tutorial = editorTutorials.find(item => item.id === button.dataset.tutorial);
  if (tutorial) createDraft({ title: tutorial.title, format: "tm", path: tutorial.file });
}));
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

const commandDialog = $("command-dialog");
const commandQuery = $("command-query");
const commandResults = $("command-results");
let commandEntries = [];
let selectedCommand = 0;

function renderCommandResults() {
  commandEntries = searchEditor(commandQuery.value);
  selectedCommand = Math.min(selectedCommand, Math.max(0, commandEntries.length - 1));
  commandResults.replaceChildren();
  if (!commandEntries.length) {
    const empty = document.createElement("div");
    empty.className = "command-result-empty";
    empty.textContent = "No matching tools or tutorials. Try “matrix”, “macro”, or “citation”.";
    commandResults.append(empty);
    return;
  }
  commandEntries.forEach(({ item }, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "command-result";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === selectedCommand));
    const title = document.createElement("span");
    title.className = "command-result-title";
    title.textContent = item.title;
    const path = document.createElement("span");
    path.className = "command-result-path";
    path.textContent = item.path;
    const detail = document.createElement("span");
    detail.className = "command-result-description";
    const commandKey = item.action ? commandKeys[item.action.slice("insert:".length)] : undefined;
    detail.textContent = item.availability ?? (item.file
      ? "Editable .tm lesson · Opens in the manuscript editor"
      : item.category + (commandKey ? " · F2, then " + commandKey.toUpperCase() : " · " + item.path));
    button.append(title, path, detail);
    button.addEventListener("click", () => runCommandEntry(item));
    commandResults.append(button);
  });
}

async function openTutorial(item) {
  if (state) {
    await leave();
    if (state) return;
  }
  await createDraft({ title: item.title, format: "tm", path: item.file });
}

function runCommandEntry(item) {
  commandDialog.close();
  if (item.file) {
    openTutorial(item).catch(error => notice(error.message));
    return;
  }
  if (item.action.startsWith("insert:")) insert(item.action.slice("insert:".length));
}

function openCommandSearch() {
  if (!state?.editor) return;
  commandQuery.value = "";
  selectedCommand = 0;
  renderCommandResults();
  commandDialog.showModal();
  commandQuery.focus();
}

$("feature-search").addEventListener("click", openCommandSearch);
commandQuery.addEventListener("input", () => { selectedCommand = 0; renderCommandResults(); });
commandQuery.addEventListener("keydown", event => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!commandEntries.length) return;
    selectedCommand = (selectedCommand + (event.key === "ArrowDown" ? 1 : commandEntries.length - 1)) % commandEntries.length;
    renderCommandResults();
    commandResults.querySelectorAll(".command-result")[selectedCommand]?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && commandEntries[selectedCommand]) {
    event.preventDefault();
    runCommandEntry(commandEntries[selectedCommand].item);
  }
});

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
    ? "Anyone with this invitation link can edit this manuscript. Revoke it any time from Account."
    : "This changes the manuscript from private to shared. Anyone with its invitation link can edit it.";
  $("start-room").textContent = "Share & collaborate";
  $("start-copy").hidden = false;
  $("start-copy").disabled = false;
  $("copy-link-row").hidden = true;
  $("copy-link").value = "";
  $("copy-help").textContent = "Create a snapshot that opens as a separate draft, or download the native file.";
  if (!$("share-dialog").open) $("share-dialog").showModal();
}

$("share").addEventListener("click", () => {
  if (accountState.current()?.localOnly) {
    notice("Local manuscripts can’t be shared by link. Export a file to share your work.");
    return;
  }
  if (state?.editor) showShare(state);
});
$("start-room").addEventListener("click", async () => {
  if (accountState.current()?.localOnly) return notice("Sign in to create a shared manuscript link. You can also export a file.");
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
  if (accountState.current()?.localOnly) return notice("Sign in to create an editable copy link. You can also export a file.");
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
    $("copy-help").textContent = "Anyone with this link can open a separate editable draft. Revoke it any time from Account.";
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
  if (accountState.current()?.localOnly) throw new Error("Local mode can’t open shared links. Sign in to use a link, or import an exported file.");
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

let authMode = "login";
function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  const recovering = mode === "recover";
  $("auth-tabs").hidden = recovering;
  $("auth-recover").hidden = registering || recovering;
  $("auth-back").hidden = !recovering;
  $("auth-login-tab").classList.toggle("selected", !registering);
  $("auth-register-tab").classList.toggle("selected", registering);
  $("auth-title").innerHTML = registering ? "Join the demo<span>.</span>" : recovering ? "Recover your account<span>.</span>" : "Welcome back<span>.</span>";
  $("auth-copy").textContent = registering
    ? "Create an account with the demo access code to save manuscripts across devices."
    : recovering ? "Enter one unused recovery code to choose a new password."
      : "Sign in to open your manuscripts from any device.";
  $("invite-field").hidden = !registering;
  $("auth-invite").required = registering;
  $("recovery-field").hidden = !recovering;
  $("auth-recovery-code").required = recovering;
  $("auth-password-label").textContent = recovering ? "New password" : "Password";
  $("auth-password").minLength = registering || recovering ? 12 : 1;
  $("auth-password").autocomplete = registering || recovering ? "new-password" : "current-password";
  $("auth-submit").textContent = registering ? "Create account" : recovering ? "Reset password" : "Sign in";
  $("auth-error").hidden = true;
  $("auth-error").textContent = "";
  $("auth-error").classList.remove("auth-success");
}

let recoveryDone;
function showRecoveryCodes(codes, onContinue) {
  recoveryDone = onContinue;
  $("recovery-code-list").textContent = codes.join("\n");
  $("recovery-saved").checked = false;
  $("recovery-continue").disabled = true;
  $("recovery-error").hidden = true;
  if (!$("recovery-dialog").open) $("recovery-dialog").showModal();
}

$("recovery-saved").addEventListener("change", () => {
  $("recovery-continue").disabled = !$("recovery-saved").checked;
});
$("download-recovery-codes").addEventListener("click", () => {
  const file = new Blob([$("recovery-code-list").textContent + "\n"], { type: "text/plain" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = "tessera-recovery-codes.txt";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("recovery-continue").addEventListener("click", async () => {
  if (!$("recovery-saved").checked) return;
  $("recovery-dialog").close();
  const action = recoveryDone;
  recoveryDone = undefined;
  if (action) {
    try { await action(); }
    catch (error) {
      $("auth-error").textContent = error.message;
      $("auth-error").hidden = false;
    }
  }
});
$("recovery-dialog").addEventListener("cancel", event => event.preventDefault());

async function enterWorkspace() {
  const user = accountState.current();
  if (!user) return;
  $("auth-screen").hidden = true;
  $("library").hidden = false;
  $("account").textContent = user.localOnly ? "Sign in" : user.local ? "Local user" : user.email;
  $("account").title = user.localOnly ? "Switch to account sign-in" : user.local ? "Local development identity" : user.email + " · Sign out";
  $("account").disabled = Boolean(user.local);
  $("storage-mode-label").textContent = user.localOnly ? "Only on this browser" : "Private by default";
  $("storage-mode").title = user.localOnly
    ? "Local mode: drafts stay in this browser. Use Export to move or share files."
    : "Account manuscripts are private until you share a link.";
  $("local-mode-note").hidden = !user.localOnly;
  $("open-link").disabled = Boolean(user.localOnly);
  $("open-link").title = user.localOnly ? "Sign in to open manuscript links, or import an exported file." : "Open a shared or editable copy link";
  await refresh();
  if (initialUrl.searchParams.has("room") || initialUrl.searchParams.has("copy") ||
      initialUrl.searchParams.get("open") === "copy" || initialUrl.hash.startsWith("#copy=")) {
    if (user.localOnly) {
      studioUrl();
      notice("Sign in to open a manuscript link. Local mode works with exported files.");
    } else {
      try { await openLink(initialUrl); }
      catch (error) { notice(error.message); }
    }
  } else {
    const requested = initialUrl.searchParams.get("draft");
    if (requested) await openDraft(requested);
    else if (typeof requestIdleCallback === "function") requestIdleCallback(() => { if (!state) warmAssets(); });
  }
}

$("auth-login-tab").addEventListener("click", () => setAuthMode("login"));
$("auth-register-tab").addEventListener("click", () => setAuthMode("register"));
$("auth-recover").addEventListener("click", () => setAuthMode("recover"));
$("auth-back").addEventListener("click", () => setAuthMode("login"));
$("auth-local").addEventListener("click", async () => {
  const button = $("auth-local");
  button.disabled = true;
  button.textContent = "Opening local workspace…";
  try {
    await accountState.initializeLocal();
    await enterWorkspace();
  } catch (error) {
    $("auth-error").textContent = "Could not open browser storage. " + error.message;
    $("auth-error").hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Continue locally";
  }
});
$("auth-form").addEventListener("submit", async event => {
  event.preventDefault();
  const submit = $("auth-submit");
  const errorBox = $("auth-error");
  submit.disabled = true;
  submit.textContent = authMode === "register" ? "Creating account…" : authMode === "recover" ? "Resetting password…" : "Signing in…";
  errorBox.hidden = true;
  try {
    const email = $("auth-email").value;
    const password = $("auth-password").value;
    if (authMode === "recover") {
      const result = await accountState.recover(email, $("auth-recovery-code").value, password);
      setAuthMode("login");
      errorBox.textContent = result.message;
      errorBox.classList.add("auth-success");
      errorBox.hidden = false;
      return;
    }
    if (authMode === "register") {
      const registration = await accountState.register(email, password, $("auth-invite").value);
      if (registration.recoveryCodes) {
        showRecoveryCodes(registration.recoveryCodes, async () => {
          const manuscripts = await accountState.initialize();
          if (!manuscripts) throw new Error("Your sign-in did not start a session. Please try again.");
          await enterWorkspace();
        });
        return;
      }
    } else await accountState.login(email, password);
    const manuscripts = await accountState.initialize();
    if (!manuscripts) throw new Error("Your sign-in did not start a session. Please try again.");
    await enterWorkspace();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = authMode === "register" ? "Create account" : authMode === "recover" ? "Reset password" : "Sign in";
  }
});

try {
  const manuscripts = await accountState.initialize();
  if (manuscripts) await enterWorkspace();
  else {
    $("auth-screen").hidden = false;
    $("library").hidden = true;
  }
} catch (error) {
  $("auth-screen").hidden = false;
  $("auth-error").textContent = "Could not reach Tessera. " + error.message;
  $("auth-error").hidden = false;
}
