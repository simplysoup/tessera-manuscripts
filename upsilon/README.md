# Upsilon source changes

Tessera uses Upsilon for document editing, typesetting, and the full native
command menus. The Vue widget backend lays out those menus and toolbars using
Clay. The editor iframe's CSS can style its HTML side panel, but the rendered
widgets use the native theme and widget layout.

The first patch adds a Tessera palette directly to Vue. It styles the same
native menus, palettes, dialogs, and page surround through both browser
renderers. The regular browser page and desktop builds keep their existing
theme. An explicit upstream theme override still takes precedence. Menu
organization and widget accessibility are separate work.

## Apply and build

Use the Upsilon source revision
[`f531d91ea039b67fc405c9eb771b9e54cdfad9b7`](https://github.com/mgubi/texmacs/tree/f531d91ea039b67fc405c9eb771b9e54cdfad9b7).
This is the source baseline for the patch, separate from the older WASM
binary listed in [PORT.md](../docs/PORT.md).

From the Upsilon checkout, with `TESSERA_REPO` pointing to this repository:

```sh
git apply --check "$TESSERA_REPO/upsilon/0001-theme-native-vue-widgets.patch"
git apply "$TESSERA_REPO/upsilon/0001-theme-native-vue-widgets.patch"
cd src
mkdir -p build-wasm
sh misc/wasm/build-mupdf.sh 1.28.5
sh misc/thorvg/build-thorvg.sh build-wasm/thorvg wasm
make -C build-wasm -f ../misc/wasm/Makefile -j4 web node
```

Use Emscripten 6.0.10 and the build prerequisites in the pinned upstream
workflow. Before replacing Tessera's binaries, compare the native menu in
the Tessera iframe and standalone page. Check selection and caret visibility,
menu interaction, document rendering, and PDF export. Update the deployed
source offer with the matching commit, this patch, and the build instructions.

The patch changes GPL-3.0-or-later Upsilon source. The browser build also links
MuPDF, whose AGPL terms apply to the combination as specified in GPLv3 §13
and AGPLv3 §13.
