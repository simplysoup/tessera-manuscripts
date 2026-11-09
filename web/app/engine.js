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
};
const suffixes = { texmacs: "tm", latex: "tex", pdf: "pdf" };

export async function mountEditor(host, draft, signal) {
  const iframe = document.createElement("iframe");
  iframe.title = "TeXmacs manuscript editor";
  const query = new URLSearchParams({ bars: "top" });
  if (new URLSearchParams(location.search).get("gpu") === "0") query.set("gpu", "0");
  iframe.src = "/texmacs.html?" + query;
  host.replaceChildren(iframe);

  const engine = () => iframe.contentWindow;
  await until(() => typeof engine()?.tmProgress?.running === "function", signal, "The editor could not load.");
  let started = false;
  engine().tmProgress.running(() => { started = true; });
  await until(() => started, signal, "TeXmacs did not finish starting. Try opening the manuscript again.");
  const runtime = engine();
  const call = code => {
    const result = runtime.TeXmacs.scheme(code);
    if (result.startsWith("(error ")) throw new Error("TeXmacs could not complete this action.");
    return result;
  };
  const current = () => call("(url->string (current-buffer-url))");
  runtime.FS.mkdirTree("/tmp/tessera");
  const path = "/tmp/tessera/" + draft.id + "." + draft.format;
  const url = `(string->url ${JSON.stringify(path)})`;
  runtime.FS.writeFile(path, draft.bytes);
  call('(set-preference "interactive footer" "on")');
  runtime.TeXmacs.later(`(load-buffer-in-new-window ${url})`);
  await until(() => current() === path, signal, "TeXmacs could not open this manuscript.", 16000);

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
    call(`(begin (show-icon-bar 0 ${value}) (show-icon-bar 1 ${value}) (show-icon-bar 2 ${value}))`);
    runtime.document.getElementById("tm-frame").style.display = visible ? "" : "none";
    runtime.dispatchEvent(new runtime.Event("resize"));
  }
  function requireManuscript() {
    if (current() !== path) throw new Error("Select your manuscript in Tools first.");
  }
  function rename(title) {
    call(`(buffer-set-title ${url} ${JSON.stringify(title)})`);
  }
  rename(draft.title);
  setTools(false);

  return {
    setTools,
    rename,
    insert(kind) {
      requireManuscript();
      if (!Object.hasOwn(inserts, kind)) throw new Error("Unknown structure.");
      runtime.TeXmacs.later(inserts[kind]);
      iframe.focus();
    },
    active: () => current() === path,
    dirty: () => call(`(buffer-modified? ${url})`) === "#t",
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
