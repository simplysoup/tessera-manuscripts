# Native browser port

## Provenance

The shipped browser engine is built from
[TeXmacs Upsilon f531d91](https://github.com/mgubi/texmacs/tree/f531d91ea039b67fc405c9eb771b9e54cdfad9b7)
with Tessera's six patches applied in order. It uses Emscripten 6.0.10
and MuPDF 1.28.5. The [engine asset hashes](ENGINE-SHA256.txt) identify
the bundled files. Upstream license notices are in
[upstream-licenses](upstream-licenses).

Use the pinned [upstream toolchain workflow](https://github.com/mgubi/texmacs/blob/f531d91ea039b67fc405c9eb771b9e54cdfad9b7/.github/workflows/wasm.yml)
and the [embedded build instructions](upsilon/README.md).
Apply the [native theme](upsilon/0001-theme-native-vue-widgets.patch),
[embedded profile](upsilon/0002-embedded-editor-build.patch),
[caret and fraction targets](upsilon/0003-embedded-caret-and-fraction-targets.patch),
[studio menu](upsilon/0004-single-studio-menu.patch),
[contextual editing tools](upsilon/0005-contextual-editing-tools.patch), and
[workspace styling](upsilon/0006-unified-studio-chrome.patch) patches in order.

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

The deployed room adapter uses native positional patches and browser-side
rebasing. A site endpoint journals accepted revisions, and each browser
applies them in place. See [Collaboration](COLLABORATION.md) for the
current behavior and test boundaries.
