// Drives the real Upsilon WASM patch API. No UI selectors or simulated
// TeXmacs parser are used for collaboration assertions.
const body = "(buffer-get-body (current-buffer-url))";
const snapshot = tree => `(tree->stree ${tree})`;
const readTree = source => `(stree->tree (string->object ${JSON.stringify(source)}))`;
const readPatch = source => `(scheme->patch (string->object ${JSON.stringify(source)}))`;

export async function openEditor(page, url, bars = "left") {
  const options = new URLSearchParams({ gpu: "0", open: "examples/nested-derivation.tm", bars });
  await page.goto(url + "/?" + options);
  await page.waitForFunction(() => {
    try {
      return runtimeInitialized &&
        TeXmacs.scheme("(url->string (current-buffer-url))") === "/tmp/web/nested-derivation.tm";
    } catch {
      return false;
    }
  }, null, { timeout: 90000, polling: 300 });
  return nativeEditor(page);
}

function nativeEditor(page) {
  async function scheme(code) {
    const result = await page.evaluate(code => TeXmacs.scheme(code), code);
    if (result.startsWith("(error ")) throw new Error(result);
    return result;
  }
  async function editCell(row, column, value) {
    // Equation > document > concat > matrix > tformat > table > row > cell.
    // The test only uses the three plain-text cells of nested-derivation.tm.
    const path = `'(3 0 0 1 0 0 ${row} ${column} 0)`;
    return scheme(`(let* ((b ${body})
                         (m (modification-assign ${path} ${JSON.stringify(value)}))
                         (p (patch-pair m (modification-invert m b))))
                     (patch-inplace-apply b p)
                     (object->string (patch->scheme p)))`);
  }
  async function restore(room) {
    let tree = readTree(room.initial);
    for (const entry of room.log) tree = `(patch-apply ${tree} ${readPatch(entry.patch)})`;
    return scheme(`(begin (tree-assign ${body} ${tree}) ${snapshot(body)})`);
  }
  async function rebase(room, operation) {
    // Pull the candidate over each accepted change's inverse and check the
    // co-pull round trip, following Upsilon's Shared Files design.
    const result = await scheme(`(let loop ((doc ${readTree(room.initial)})
                                           (patch ${readPatch(operation.patch)})
                                           (history (list ${room.log.map(entry => readPatch(entry.patch)).join(" ")}))
                                           (skip ${operation.baseRevision}))
      (cond ((null? history)
             (and (= skip 0) (patch-applicable? patch doc)
                  (object->string (patch->scheme patch))))
            ((> skip 0)
             (loop (patch-apply doc (car history)) patch (cdr history) (- skip 1)))
            ((not (patch-applicable? patch doc)) #f)
            (else
             (let* ((prior (car history))
                    (inverse (patch-invert prior doc))
                    (next (patch-apply doc prior)))
               (and (patch-can-pull? patch inverse)
                    (let* ((pulled (patch-pull patch inverse))
                           (back (patch-co-pull patch inverse)))
                      (and (patch-applicable? pulled next)
                           (let ((merged (patch-apply next pulled)))
                             (and (patch-applicable? back merged)
                                  (equal? (tree->stree (patch-apply merged back))
                                          (tree->stree (patch-apply doc patch)))
                                  (loop next pulled (cdr history) 0))))))))))`);
    return result === "#f" ? null : result;
  }

  return { snapshot: () => scheme(snapshot(body)), editCell, restore, rebase };
}
