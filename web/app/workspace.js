import { documents, claim } from "./documents.js";
import { mountEditor, warmAssets } from "./engine.js";
import { createCopyLink, readCopyLink } from "./sharing.js";

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
  $("save-status").lastElementChild.textContent = message;
  $("save-status").dataset.state = kind;
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
    meta.textContent = "Edited " + new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(draft.updated);
    text.append(name, meta);
    open.append(mark, text);
    open.addEventListener("click", () => openDraft(draft.id));
    const remove = document.createElement("button");
    remove.className = "icon-button";
    remove.setAttribute("aria-label", "Delete " + draft.title);
    remove.append(icon("trash"));
    remove.addEventListener("click", () => ask({
      label: "LOCAL MANUSCRIPT", title: "Delete this draft?",
      copy: "“" + draft.title + "” will be removed from this browser.", confirm: "Delete draft",
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

function ask({ label, title, copy, confirm = "Done", name, action }) {
  $("dialog-label").textContent = label;
  $("dialog-title").textContent = title;
  $("dialog-copy").textContent = copy;
  $("dialog-confirm").textContent = confirm;
  $("name-field").hidden = name === undefined;
  $("name").value = name ?? "";
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
  for (const id of ["rename", "save", "source-mode", "tools", "share"]) $(id).disabled = !ready;
  for (const id of ["exports", "inserts"]) {
    $(id).firstElementChild.setAttribute("aria-disabled", String(!ready));
    for (const button of $(id).querySelectorAll("button")) button.disabled = !ready;
    if (!ready) $(id).open = false;
  }
}

function studioUrl(id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set("draft", id);
  else url.searchParams.delete("draft");
  history.replaceState(null, "", url);
}

async function openDraft(id) {
  if (state) return;
  const session = { controller: new AbortController(), busy: false };
  state = session;
  try {
    session.release = await claim(id);
    if (!session.release) throw new Error("This draft is already open in another tab.");
    const draft = await documents.get(id);
    if (!draft) throw new Error("This manuscript is unavailable in this browser.");
    session.draft = draft;
    $("title").textContent = draft.title;
    $("studio").hidden = false;
    $("library").hidden = true;
    $("editor-hint").textContent = "Starting the editor…";
    $("editor-context").textContent = "";
    $("mode-label").textContent = "TYPESET VIEW";
    $("editor-host").dataset.ready = "false";
    $("editor-host").inert = true;
    $("editor-cover").hidden = false;
    $("cover-title").textContent = "Opening your manuscript";
    $("cover-copy").textContent = "Getting the writing room ready. You can go back while it loads.";
    $("source-mode").setAttribute("aria-pressed", "false");
    $("tools").setAttribute("aria-pressed", "false");
    studioUrl(id);
    status("Opening editor", "busy");
    enable(false);
    session.editor = await mountEditor($("editor-host"), draft, session.controller.signal);
    if (state !== session) return;
    syncView(session.editor);
    $("editor-host").dataset.ready = "true";
    $("editor-host").inert = false;
    $("editor-cover").hidden = true;
    $("editor-hint").textContent = "Click the page to write. Use Source to see the document tree.";
    enable(true);
    if (draft.format === "tex") await save(session, true);
    else status("Saved here");
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
  if (!session.editor) {
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
      label: "LOCAL MANUSCRIPT", title: "The latest changes couldn’t be saved",
      copy: "Cancel to keep editing or export a recovery copy. Returning now opens the library with the last saved version.",
      confirm: "Return with last saved",
      action: () => returnToLibrary(session),
    });
  } finally {
    session.leaving = false;
  }
}

function syncView(editor) {
  const source = editor.source();
  $("source-mode").setAttribute("aria-pressed", String(source));
  $("mode-label").textContent = source ? "SOURCE VIEW" : "TYPESET VIEW";
  try { $("editor-context").textContent = editor.context(); } catch { $("editor-context").textContent = ""; }
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
  copy: "Try Math playground to explore the editor. Click the page to edit, use Source to see its structure, and export a copy when you want to take it with you. Drafts live in this browser.",
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
$("source-mode").addEventListener("click", () => {
  try { state.editor.toggleSource(); syncView(state.editor); }
  catch (error) { notice(error.message); }
});
$("tools").addEventListener("click", () => {
  const next = $("tools").getAttribute("aria-pressed") !== "true";
  try {
    state.editor.setTools(next);
    $("tools").setAttribute("aria-pressed", String(next));
  } catch (error) { notice(error.message); }
});
for (const id of ["exports", "inserts"]) {
  $(id).firstElementChild.addEventListener("click", event => {
    if (!state?.editor) event.preventDefault();
  });
  $(id).addEventListener("toggle", () => {
    if ($(id).open) $(id === "exports" ? "inserts" : "exports").open = false;
  });
}
$("inserts").querySelectorAll("[data-insert]").forEach(button => button.addEventListener("click", () => {
  $("inserts").open = false;
  try { state.editor.insert(button.dataset.insert); }
  catch (error) { notice(error.message); }
}));
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

let shareRequest = 0;
$("share").addEventListener("click", async () => {
  const session = state;
  if (!session?.editor) return;
  const request = ++shareRequest;
  $("copy-link").value = "";
  $("copy-link").placeholder = "Preparing link…";
  $("copy-help").textContent = "The link contains your manuscript. Send it only to people you trust who can sign in to this private workspace.";
  $("copy-link-button").disabled = true;
  $("share-dialog").showModal();
  try {
    const link = await createCopyLink(location.href, session.draft.title, session.editor.exportFile("texmacs"));
    if (state !== session || request !== shareRequest || !$("share-dialog").open) return;
    $("copy-link").value = link;
    $("copy-link-button").disabled = false;
  } catch (error) {
    if (request !== shareRequest) return;
    $("copy-link").placeholder = "Link unavailable";
    $("copy-help").textContent = error.message;
  }
});
$("copy-link-button").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("copy-link").value);
    notice("Editable copy link copied.");
  } catch {
    $("copy-link").focus();
    $("copy-link").select();
    $("copy-help").textContent = "Use your keyboard’s copy shortcut to copy the selected link.";
  }
});
$("share-download").addEventListener("click", () => {
  try { download(state, "texmacs"); } catch (error) { notice(error.message); }
});

setInterval(() => {
  if (!state?.editor || state.busy || state.saving || state.leaving) return;
  try {
    if (state.editor.active()) syncView(state.editor);
    else if ($("tools").getAttribute("aria-pressed") !== "true") {
      state.editor.setTools(true);
      $("tools").setAttribute("aria-pressed", "true");
    }
    save(state).catch(() => {});
  } catch { status("Editor unavailable", "error"); }
}, 2500);

addEventListener("beforeunload", event => {
  let pending = state?.saving || state?.retry || state?.renaming;
  try { pending ||= state?.editor?.dirty(); } catch { pending = true; }
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
  if (initialUrl.hash.startsWith("#copy=")) {
    const clean = new URL(location.href);
    clean.hash = "";
    clean.searchParams.delete("draft");
    clean.searchParams.delete("open");
    history.replaceState(null, "", clean);
    try {
      const copy = await readCopyLink(initialUrl.hash);
      ask({
        label: "EDITABLE MANUSCRIPT COPY", title: "Open “" + copy.title + "”?",
        copy: "Tessera will make a new local draft. Open copies from people you trust.",
        confirm: "Open editable copy", action: () => createDraft(copy),
      });
    } catch (error) { notice(error.message); }
  } else {
    const requested = initialUrl.searchParams.get("draft");
    if (requested) await openDraft(requested);
    else if (typeof requestIdleCallback === "function") requestIdleCallback(() => { if (!state) warmAssets(); });
  }
} catch (error) {
  notice("Browser storage is unavailable. " + error.message);
}
