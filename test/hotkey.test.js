import test from "node:test";
import assert from "node:assert/strict";
import { parseHotkey } from "../lib/hotkey.js";

test("parseHotkey maps ctrl+alt+d to Win32 modifiers and a virtual key", () => {
  assert.deepEqual(parseHotkey("ctrl+alt+d"), { modifiers: 0x0002 | 0x0001, virtualKey: 0x44, normalized: "ctrl+alt+d" });
});

test("parseHotkey supports function keys, digits and win", () => {
  assert.equal(parseHotkey("ctrl+shift+f9").virtualKey, 0x78);
  assert.equal(parseHotkey("ctrl+shift+f9").modifiers, 0x0002 | 0x0004);
  assert.equal(parseHotkey("win+space").virtualKey, 0x20);
  assert.equal(parseHotkey("ctrl+0").virtualKey, 0x30);
});

test("parseHotkey rejects incomplete or unsupported combinations", () => {
  assert.equal(parseHotkey(""), null);
  assert.equal(parseHotkey("d"), null);
  assert.equal(parseHotkey("ctrl"), null);
  assert.equal(parseHotkey("ctrl+alt"), null);
  assert.equal(parseHotkey("ctrl+alt+nosuchkey"), null);
});
