import assert from "node:assert/strict";
import test from "node:test";
import { commandKeys, installShortcuts } from "../web/app/shortcuts.js";

function editor() {
  const runtime = new EventTarget();
  runtime.document = { body: {} };
  const controller = new AbortController();
  const commands = [];
  const keys = [];
  let hint;
  installShortcuts(runtime, {
    command: kind => commands.push(kind),
    replay: key => keys.push(key),
    hint: value => { hint = value; },
    active: () => true,
    signal: controller.signal,
  });
  return {
    commands,
    keys,
    controller,
    hint: () => hint,
    press(key, options = {}) {
      const event = new Event("keydown", { cancelable: true });
      Object.defineProperties(event, {
        target: { value: runtime.document.body },
        key: { value: key },
      });
      Object.assign(event, options);
      return !runtime.dispatchEvent(event);
    },
  };
}

test("F2 dispatches the toolbar commands without capturing ordinary typing", () => {
  const { commands, press, hint } = editor();
  assert.equal(press("f"), false);
  for (const [command, key] of Object.entries(commandKeys)) {
    assert.equal(press("F2"), true);
    assert.match(hint(), /Shortcut/);
    assert.equal(press(key), true);
    assert.equal(commands.at(-1), command);
    assert.equal(hint(), "");
  }
  assert.equal(commands.length, Object.keys(commandKeys).length);
  assert.equal(press("F2", { isComposing: true }), false);
});

test("native replay composes reserved shortcuts and cancels when requested", () => {
  const { press, keys, controller, hint } = editor();
  for (const key of ["F2", "0", "1", "Enter", "f"]) assert.equal(press(key), true);
  for (const key of ["F2", "0", "2", "4", "Enter", "w"]) assert.equal(press(key), true);
  assert.deepEqual(keys, ["A-f", "C-W"]);
  for (const key of ["F2", "0", "1", "Enter"]) press(key);
  assert.equal(press("Escape", { shiftKey: true }), true);
  assert.equal(press("f"), false);
  press("F2");
  controller.abort();
  assert.equal(hint(), "");
  assert.equal(press("f"), false);
});
