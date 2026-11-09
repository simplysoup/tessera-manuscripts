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

The third patch gives the embedded editor a green, font-sized caret and
draws clickable guides for empty arguments of the fraction at the caret.
The guides are editor overlays and leave document layout and export intact.
Tessera owns the F2 command prefix, with direct toolbar bindings and a
native key entry mode for chords that the browser reserves.

The fourth patch styles the native menu bar for Tessera and gives the
embedded File menu printing and additional native file formats.
Tessera owns manuscript navigation, saving, sharing, and standard export.

The fifth patch restores the native quick actions, mode tools, and
structure controls as part of the editor. The quick actions omit the file
controls provided by Tessera. Each toolbar can be toggled in View → Toolbars.

The sixth patch aligns the native menu, toolbar surface, icon targets, and
paper surround with the Tessera workspace frame. The embedded editor
selects the Upsilon Lucide icon set by default.

The seventh patch removes the rounded outer frame, loads Lucide toolbar icons
with the initial resources, and persists only TeXmacs' disposable font and
file cache between embedded editor frames. Manuscripts and editor preferences
remain in Tessera's own storage.

The eighth keeps native right-click menus open after the mouse button is
released. The ninth maps Tab and Shift+Tab to forward and backward table-cell
navigation, including matrix cells.

The full Upsilon web target retains its own storage, tabs, and plug-ins.
Tessera's frontend owns document persistence. Native preferences in the
embedded runtime are transient. The build still includes the C++ editor,
typesetter, and renderer. The cache speeds up later editor launches after the
first font database is built; first launch still builds it once.

## Apply and build

Use the Upsilon source revision
[`f531d91ea039b67fc405c9eb771b9e54cdfad9b7`](https://github.com/mgubi/texmacs/tree/f531d91ea039b67fc405c9eb771b9e54cdfad9b7).
This is the source baseline for the browser engine described in
[PORT.md](../docs/PORT.md).

From the Upsilon checkout, with `TESSERA_REPO` pointing to this repository:

```sh
for patch in "$TESSERA_REPO"/upsilon/000*.patch; do
  git apply --check "$patch" && git apply "$patch" || exit 1
done
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
