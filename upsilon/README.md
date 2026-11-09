# Upsilon source changes

Tessera uses Upsilon for document editing, typesetting, and the full native
command menus. The Vue widget backend lays out those menus and toolbars using
Clay. The editor iframe's CSS can style its HTML side panel, but the rendered
widgets use the native theme and widget layout.

The first patch adds a Tessera palette directly to Vue. It styles the
native menus, palettes, dialogs, and page surround through both browser
renderers. The second adds an embedded build profile for Tessera's frontend.

| Kept in the embedded profile | Removed or bypassed |
| --- | --- |
| Native document canvas, selection, caret, IME, clipboard, and undo | Upsilon's standalone browser tab strip and drag-and-drop handlers |
| Styles, fonts, LaTeX conversion, PDF export, and the native patch API | Upsilon's IndexedDB home and its cross-tab lock, backup reminders, and unload prompt |
| The Scheme runtime and the browser APIs Tessera uses to load buffers and edit | AI, Python, R, TikZ, and Asymptote session plug-ins, their browser worker and wallet glue, and the font sample PDFs |
| Native dialogs used by the editor and clipboard | Public site pages, screenshots, and external computational runtime builds |

The full Upsilon web target retains its own storage, tabs, and plug-ins.
Tessera's frontend owns document persistence. Native preferences in the
embedded runtime are transient. The build still includes the C++ editor,
typesetter, and renderer. This pass reduces the browser distribution and
startup work. Measure the first-edit path before cutting more from the
binary or changing how the editor renders.

## Apply and build

Use the Upsilon source revision
[`f531d91ea039b67fc405c9eb771b9e54cdfad9b7`](https://github.com/mgubi/texmacs/tree/f531d91ea039b67fc405c9eb771b9e54cdfad9b7).
This is the source baseline for the patch, separate from the older WASM
binary listed in [PORT.md](../docs/PORT.md).

From the Upsilon checkout, with `TESSERA_REPO` pointing to this repository:

```sh
git apply --check "$TESSERA_REPO"/upsilon/000*.patch
git apply "$TESSERA_REPO"/upsilon/000*.patch
cd src
mkdir -p build-wasm
sh misc/wasm/build-mupdf.sh 1.28.5
sh misc/thorvg/build-thorvg.sh build-wasm/thorvg wasm
make -C build-wasm -f ../misc/wasm/Makefile -j4 tessera-web
```

Use Emscripten 6.0.10 and the build prerequisites in the pinned upstream
workflow. The assets land in `src/build-wasm/out-tessera/web`. Before
replacing Tessera's shipped assets, verify inline text and fraction editing,
keyboard navigation, IME and clipboard, LaTeX import/export, PDF export,
and two-browser synchronization. Measure the bytes loaded before the
first editable keystroke. Update the deployed source offer with the matching
commit, patches, and build instructions.

The patch changes GPL-3.0-or-later Upsilon source. The browser build also links
MuPDF, whose AGPL terms apply to the combination as specified in GPLv3 §13
and AGPLv3 §13.
