export const commandKeys = Object.freeze({
  undo: "z", redo: "y", bold: "b", italic: "i", equation: "e", fraction: "f",
  root: "r", superscript: "u", subscript: "d", section: "s", theorem: "t",
});

const commandsByKey = new Map(Object.entries(commandKeys).map(([command, key]) => [key, command]));
const modifierKeys = new Map([["1", "Alt"], ["2", "Ctrl"], ["3", "Meta"], ["4", "Shift"]]);
const nativePrefixes = new Map([["Meta", "M-"], ["Alt", "A-"], ["Ctrl", "C-"], ["Shift", "S-"]]);
const nativeNames = new Map([
  [" ", "space"], ["Enter", "return"], ["Backspace", "backspace"],
  ["Delete", "delete"], ["Tab", "tab"], ["Home", "home"], ["End", "end"],
  ["PageUp", "pageup"], ["PageDown", "pagedown"], ["Escape", "escape"],
  ["ArrowLeft", "left"], ["ArrowRight", "right"], ["ArrowUp", "up"], ["ArrowDown", "down"],
]);

export function installShortcuts(runtime, { command, replay, hint, active, signal }) {
  let mode;
  const modifiers = new Set();
  const options = { capture: true, signal };
  const setMode = (next, message = "") => {
    mode = next;
    hint(message);
  };
  const reset = () => {
    modifiers.clear();
    if (mode) setMode(undefined);
  };

  runtime.addEventListener("keydown", event => {
    if (!mode && event.key !== "F2") return;
    const inCanvas = event.target === runtime.document.body ||
      event.target.matches?.("#canvas, [data-tm-input]");
    if (!inCanvas || event.isComposing || event.keyCode === 229 ||
        event.altKey || event.ctrlKey || event.metaKey || !active()) {
      reset();
      return;
    }
    const consume = () => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    if (event.key === "Escape" && mode && (mode !== "native" || event.shiftKey)) {
      consume();
      reset();
      return;
    }
    if (mode === "modifiers") {
      const modifier = modifierKeys.get(event.key);
      if (modifier) {
        consume();
        if (event.repeat) return;
        if (modifiers.has(modifier)) modifiers.delete(modifier);
        else modifiers.add(modifier);
        hint((Array.from(modifiers).join("+") || "No modifiers") +
          " · Enter to choose the key · Esc to cancel");
      } else if (event.key === "Enter") {
        consume();
        if (!event.repeat) setMode("native", "Press the final key · Shift+Esc to cancel");
      } else {
        reset();
      }
      return;
    }
    if (mode === "native") {
      const key = nativeNames.get(event.key) ??
        (/^(?:F(?:[1-9]|1[0-9]|2[0-4])|[!-~])$/u.test(event.key) ? event.key : undefined);
      if (!key) return;
      consume();
      if (event.repeat) return;
      let nativeKey = key;
      let prefix = "";
      for (const [name, code] of nativePrefixes) {
        if (!modifiers.has(name)) continue;
        if (name === "Shift" && /^[a-z]$/iu.test(key)) nativeKey = key.toUpperCase();
        else prefix += code;
      }
      reset();
      replay(prefix + nativeKey);
      return;
    }
    if (event.key === "F2" && !event.shiftKey) {
      consume();
      if (event.repeat) return;
      if (mode) reset();
      else setMode("commands", "Shortcut · F fraction · E equation · R root · 0 native keys · Esc cancel");
      return;
    }
    if (mode !== "commands") return;
    if (event.key === "0") {
      consume();
      if (!event.repeat) setMode("modifiers", "Native shortcut · 1 Alt · 2 Ctrl · 3 Meta · 4 Shift · Enter to confirm");
      return;
    }
    const kind = commandsByKey.get(event.key.toLowerCase());
    reset();
    if (kind) {
      consume();
      if (!event.repeat) command(kind);
    }
  }, options);
  runtime.addEventListener("blur", reset, options);
  runtime.addEventListener("pointerdown", reset, options);
  signal.addEventListener("abort", reset, { once: true });
}
