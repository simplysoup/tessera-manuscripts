import { installRoom } from "./native-room.js";

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function until(check, signal, failure, timeout = 45000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (signal.aborted) throw signal.reason;
    if (check()) return;
    await wait(120);
  }
  throw new Error(failure);
}

const inserts = {
  equation: "(make 'equation*)",
  section: "(make-section 'section)",
  theorem: "(make 'theorem)",
  fraction: "(make-fraction)",
  root: "(make-sqrt)",
  superscript: "(make-script #t #t)",
  subscript: "(make-script #f #t)",
  bold: "(make-with \"font-series\" \"bold\")",
  italic: "(make-with \"font-shape\" \"italic\")",
  undo: "(undo 0)",
  redo: "(redo 0)",
};
const suffixes = { texmacs: "tm", latex: "tex", pdf: "pdf" };

let running;
let priorUrl;

export function warmAssets() {
  if (navigator.connection?.saveData || /(^|-)2g$/u.test(navigator.connection?.effectiveType ?? "")) return;
  // These match the URLs requested by the pinned upstream boot loader.
  const prefetch = href => {
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = href;
    document.head.append(link);
  };
  prefetch("/texmacs.js");
  prefetch("/texmacs.wasm.gz");
  fetch("/texmacs-files.json").then(response => response.json()).then(manifest => {
    for (const pack of manifest.packages) if (pack.boot) prefetch("/" + pack.gz);
  }).catch(() => {});
}

function boot(host) {
  if (running) return running;
  const iframe = document.createElement("iframe");
  iframe.title = "TeXmacs manuscript editor";
  iframe.tabIndex = -1;
  const query = new URLSearchParams({ bars: "top", tessera: "1" });
  if (new URLSearchParams(location.search).get("gpu") === "0") query.set("gpu", "0");
  iframe.src = "/texmacs.html?" + query;
  host.replaceChildren(iframe);

  running = (async () => {
    const signal = new AbortController().signal;
    const engine = () => iframe.contentWindow;
    await until(() => typeof engine()?.tmProgress?.running === "function", signal, "The editor could not load.");
    let started = false;
    engine().tmProgress.running(() => { started = true; });
    await until(() => started, signal, "The editor did not finish starting. Try opening the manuscript again.");
    const runtime = engine();
    runtime.FS.mkdirTree("/tmp/tessera");
    return { runtime, iframe };
  })().catch(error => {
    iframe.remove();
    running = undefined;
    priorUrl = undefined;
    throw error;
  });
  return running;
}

export async function mountEditor(host, draft, signal) {
  const { runtime, iframe } = await boot(host);
  signal.throwIfAborted();
  const call = code => {
    const result = runtime.TeXmacs.scheme(code);
    if (result.startsWith("(error ")) throw new Error("TeXmacs could not complete this action.");
    return result;
  };
  const current = () => call("(url->string (current-buffer-url))");
  const path = "/tmp/tessera/" + crypto.randomUUID() + "." + draft.format;
  const url = `(string->url ${JSON.stringify(path)})`;
  const previous = priorUrl;
  priorUrl = { url, path };
  runtime.FS.writeFile(path, draft.bytes);
  runtime.TeXmacs.later(`(load-buffer ${url} :strict)`);
  await until(() => current() === path, signal, "TeXmacs could not open this manuscript.", 16000);
  if (previous) {
    call(`(if (buffer-exists? ${previous.url}) (cpp-buffer-close ${previous.url}))`);
    runtime.FS.unlink(previous.path);
  }

  function exportFile(format) {
    const suffix = suffixes[format];
    if (!suffix) throw new Error("Unknown export format.");
    const file = "/tmp/tessera/export-" + crypto.randomUUID() + "." + suffix;
    const target = `(string->url ${JSON.stringify(file)})`;
    if (call(`(buffer-export ${url} ${target} "${format}")`) !== "#f") {
      throw new Error("TeXmacs could not export this manuscript.");
    }
    const bytes = runtime.FS.readFile(file);
    runtime.FS.unlink(file);
    return bytes;
  }

  function setTools(visible) {
    const value = visible ? "#t" : "#f";
    call(`(begin (show-header ${value}) (show-footer ${value})
      (show-icon-bar 0 ${value}) (show-icon-bar 1 ${value}) (show-icon-bar 2 ${value}))`);
    runtime.document.documentElement.toggleAttribute("data-tessera-tools", visible);
    runtime.dispatchEvent(new runtime.Event("resize"));
  }
  function requireManuscript() {
    if (current() !== path) throw new Error("Use More → Native TeXmacs menus to select your manuscript.");
  }
  function rename(title) {
    call(`(buffer-set-title ${url} ${JSON.stringify(title)})`);
  }
  rename(draft.title);
  setTools(false);

  return {
    setTools,
    room() {
      call(installRoom);
      call(`(tessera-start ${url})`);
      return {
        take() {
          const value = call("(tessera-take)");
          return value === "#f" ? null : value;
        },
        pending: () => call("(null? tessera-pending)") === "#f",
        accept: patch => call(`(tessera-accept ${JSON.stringify(patch)})`),
        restore: patch => call(`(tessera-restore ${JSON.stringify(patch)})`),
        receive: patch => call(`(tessera-receive ${JSON.stringify(patch)})`) === "#t",
        stop: () => call("(tessera-stop)"),
      };
    },
    rename,
    insert(kind) {
      requireManuscript();
      if (!Object.hasOwn(inserts, kind)) throw new Error("Unknown structure.");
      runtime.TeXmacs.later(inserts[kind]);
      iframe.focus();
    },
    active: () => current() === path,
    dirty: () => call(`(and (buffer-exists? ${url}) (buffer-modified? ${url}))`) === "#t",
    context() {
      if (current() !== path) return "";
      return call(`(string-join (map (lambda (node) (symbol->string (tree-label node)))
        (list-filter (reverse (upward-context-trees (cursor-tree)))
          (lambda (node) (not (in? (tree-label node) '(document concat)))))) " › ")`);
    },
    capture() {
      const bytes = exportFile("texmacs");
      call(`(buffer-pretend-saved ${url})`);
      return bytes;
    },
    exportFile,
    source: () => call('(get-init "preamble")') === "true",
    toggleSource() {
      requireManuscript();
      call("(toggle-source-mode)");
      return this.source();
    },
  };
}
