/**
 * jsdomSetup.js — SHARED jsdom bootstrap for the React test files.
 *
 * MUST BE IMPORTED FIRST — before react/react-dom (ESM import order):
 *   import { dom } from "./jsdomSetup.js";   // ← first import
 *   import React, { act } from "react";       // ← evaluates AFTER globals exist
 *
 * WHY: react-dom computes `canUseDOM` and `isInputEventSupported` ONCE at
 * module evaluation. When the test file created the JSDOM in its own body,
 * ESM hoisting meant react-dom evaluated BEFORE the globals existed →
 * `canUseDOM` was false → React permanently fell back to its IE8-style
 * input-event polyfill, which ignores native "input" events entirely
 * (onChange never fired for any controlled input; only clicks worked).
 * Setting the globals in a side-effect module that is imported FIRST fixes
 * the evaluation order so react-dom sees a real DOM from the start.
 *
 * The module exports the JSDOM instance (`dom`) so tests can build events
 * with `new dom.window.Event(...)` exactly as before.
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});

function setGlobal(name, value) {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  } catch {
    globalThis[name] = value;
  }
}
setGlobal("window", dom.window);
setGlobal("document", dom.window.document);
setGlobal("navigator", dom.window.navigator);
setGlobal("Event", dom.window.Event);
setGlobal("CustomEvent", dom.window.CustomEvent);
setGlobal("HTMLElement", dom.window.HTMLElement);
setGlobal("Node", dom.window.Node);
setGlobal("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

export { dom };
