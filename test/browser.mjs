import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { startServer } from "./server.test.mjs";

const server = await startServer();
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: JSON.parse(process.env.CHROMIUM_ARGS ?? "[]"),
  });
  const page = await browser.newPage({ viewport: { width: 1370, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const scheme = code => page.evaluate(code => TeXmacs.scheme(code), code);
  const tree = () => scheme("(tree->stree (buffer-tree))");
  async function waitForBuffer(name) {
    await page.waitForFunction(name => {
      try {
        return runtimeInitialized && TeXmacs.scheme("(url->string (current-buffer-url))").endsWith("/" + name);
      } catch { return false; }
    }, name, { timeout: 90000, polling: 300 });
  }

  await page.goto(server.url + "/?gpu=0&open=examples/nested-derivation.tm");
  await waitForBuffer("nested-derivation.tm");
  const initial = await tree();
  assert.match(initial, /\(theorem \(document \(concat .*\(math \(frac \(concat "x" \(rsup "2"\)/u);
  assert.match(initial, /\(matrix \(tformat \(table \(row \(cell "1"\) \(cell \(frac/u);

  const observer = await readFile(new URL("./native-observer.scm", import.meta.url), "utf8");
  const installed = await scheme(observer + "\n(define workbench-before (workbench-observe))\n#t");
  assert.equal(installed, "#t");
  await page.screenshot({ path: "/tmp/tm2/test-native.png" });
  await page.mouse.click(594, 178);
  const cursor = await scheme("(cursor-path)");
  assert.match(cursor, /^\(1 [1-9]\d*\)$/u);
  await page.keyboard.type("DIRECT");
  await page.waitForFunction(() => TeXmacs.scheme("(tree->stree (buffer-tree))").includes("DIRECT"));
  assert.match(await tree(), /"Click in .*DIRECT.*document itself\."/u);
  assert.equal(await scheme("(workbench-replay! workbench-before)"), "#t");
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() => !TeXmacs.scheme("(tree->stree (buffer-tree))").includes("DIRECT"));

  await page.mouse.click(860, 266);
  assert.match(await scheme("(tree->stree (focus-tree))"), /^\((?:rsup|frac) /u);
  const nestedCursor = await scheme("(cursor-path)");
  assert.ok(nestedCursor.split(" ").length > 8);
  const beforeSource = await tree();
  await page.evaluate(() => TeXmacs.later("(toggle-source-mode)"));
  await page.waitForFunction(() => TeXmacs.scheme('(get-init "preamble")') === "true");
  assert.equal(await tree(), beforeSource);
  if (process.env.TM_TEST_SHOTS) {
    await page.screenshot({ path: process.env.TM_TEST_SHOTS + "/source.png" });
  }
  await page.evaluate(() => TeXmacs.later("(toggle-source-mode)"));
  await page.waitForFunction(() => TeXmacs.scheme('(get-init "preamble")') !== "true");

  assert.equal(await scheme('(buffer-export (current-buffer-url) (string->url "/tmp/workbench.tex") "latex")'), "#f");
  const latex = await page.evaluate(() => FS.readFile("/tmp/workbench.tex", { encoding: "utf8" }));
  assert.match(latex, /\\frac\{/u);
  assert.match(latex, /\\begin\{(?:pmatrix|array)\}/u);
  await scheme('(buffer-export (current-buffer-url) (string->url "/tmp/workbench.pdf") "pdf")');
  const pdf = await page.evaluate(() => Array.from(FS.readFile("/tmp/workbench.pdf").slice(0, 5)));
  assert.deepEqual(pdf, [37, 80, 68, 70, 45]);

  await page.goto(server.url + "/?gpu=0&open=examples/nested-import.tex");
  await waitForBuffer("nested-import.tex");
  const imported = await tree();
  assert.match(imported, /\(section "An imported equation"\)/u);
  assert.match(imported, /\(frac /u);
  assert.match(imported, /\(table /u);
  assert.deepEqual(errors, []);
  console.log("Native WASM smoke passed: pointer editing, undo, nested focus, editable source mode, patch replay, LaTeX import/export, PDF.");
} finally {
  await browser?.close();
  server.close();
}
