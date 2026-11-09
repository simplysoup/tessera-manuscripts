# Native browser port

## Provenance

The included engine files are the prebuilt browser distribution from
[TeXmacs Upsilon](https://mgubi.github.io/texmacs/). The build identity
embedded in `doc/about/welcome/texmacs-vue-build.en.tm` names
[2c6c572a4f98dd8f14967a2f05f035297db9792f](https://github.com/mgubi/texmacs/tree/2c6c572a4f98dd8f14967a2f05f035297db9792f)
from the `wasm_ci` branch, Emscripten 6.0.10, S7 11.9, SDL 3.4.2, and
MuPDF 1.28.5. The included JS and WASM are unmodified. The package
[asset hashes](ENGINE-SHA256.txt) cover the exact files served at release.
Upstream's license notices are in [upstream-licenses](upstream-licenses).

The build recipe is
[.github/workflows/wasm.yml](https://github.com/mgubi/texmacs/blob/2c6c572a4f98dd8f14967a2f05f035297db9792f/.github/workflows/wasm.yml).
For a source build, check out the commit, activate Emscripten 6.0.10,
then run these commands from the upstream repository's `src/` directory:

```sh
mkdir -p build-wasm
sh misc/wasm/build-mupdf.sh 1.28.5
sh misc/thorvg/build-thorvg.sh build-wasm/thorvg wasm
make -C build-wasm -f ../misc/wasm/Makefile -j4 web node
```

The build requires the tools and dependencies in that workflow, including
Node and the browser port's source and asset inputs. The upstream web
output is `build-wasm/out/web`. This Workbench release packages the prebuilt
output and tests that binary. The source rebuild recipe has not been run as
part of this release.

## Source map

The paths below are relative to the upstream repository's `src/` directory.

| Concern | Code path and behavior |
| --- | --- |
| Browser events and composition | `src/Plugins/Vue/vue_gui.cpp` turns browser SDL events into native editor input. `misc/wasm/ime.js` provides a hidden IME input positioned at the native caret, including composition and committed text. |
| Pointer, caret and focus | `src/Edit/Interface/edit_mouse.cpp` resolves pointer positions against native boxes. `edit_cursor.cpp` navigates native tree paths and `edit_repaint.cpp` draws the caret, selections, and context. |
| Tags and nesting | `src/Kernel/Types/tree.hpp` represents atomic strings and arbitrary tagged child lists. `TeXmacs/progs/generic/generic-edit.scm` dispatches structured navigation and insertion on `focus-tree`. Math, source, and table handlers specialize that dispatch. |
| Editable source | `TeXmacs/progs/generic/document-menu.scm` calls `toggle-source-mode`, which changes the `preamble` environment in `generic/document-edit.scm`. The source view typesets the same editable native tree in a different mode. |
| Layout and paint | `src/Edit/Editor/edit_typeset.cpp` prepares styles and produces boxes. Native tree modifications invalidate the typesetter through `src/Edit/Modify/edit_modify.cpp`. The Vue browser GUI renders via the upstream GPU or MuPDF backend. |
| Files and conversion | `misc/wasm/web-pre.js` and `files.js` connect the Emscripten filesystem to IndexedDB and the browser file panel. `TeXmacs/progs/convert/latex/init-latex.scm` registers native import and export. `TeXmacs/progs/texmacs/texmacs/tm-print.scm` connects PDF menu commands to the native PDF renderer. |

The browser build runs the native editor loop and typesetter on the page's
main thread. It retains the original incrementality and editor event
ordering. The Workbench has not moved the editor into a worker or benchmarked
a 60 fps target.

## Collaboration integration point

Native editing emits modifications such as text or child insertion, removal,
split, join, tag reassignment, wrapping and unwrapping. The browser test uses
the actual `tree-observe` binding from `src/Data/Observers/tree_pointer.cpp`
and tests a captured native modification against a copy of the document.
`patch-applicable?` and `patch-inplace-apply` give a receiver a way to
validate and apply native changes without replacing the whole document.

The upstream branch also has a [shared-files design](https://github.com/mgubi/texmacs/blob/f531d91ea039b67fc405c9eb771b9e54cdfad9b7/src/docs/shared-files.md).
It is a desktop host/rebase protocol using loopback sockets. Its use of
body observers, native patch application and separate style/environment
metadata is relevant to a browser bridge. Browser storage's single-writer
coordination is a separate concern.

The observer test is a local round-trip test. A Tree-CRDT binding must
translate positional native modifications against stable replicated
identities, including split/join and wrapper operations. Remote changes
need to apply in place, preserve local cursors, suppress echo and integrate
with native undo authorship. Before enabling live collaboration, tests
need to cover simultaneous edits to independent matrix cells, competing
structural edits, style changes and reconnect. The port currently exposes
no collaborative room mode.
