/**
 * Contract and behaviour tests for the browser half of rtl-bidi-plugin.
 *
 * No dependency and no browser: the ModuleLoader spec is captured from
 * `lib/client.js`, the factory runs against a tiny stub of the platform module
 * table, and a hand-written DOM stub lets the composer engine be exercised
 * directly.
 *
 * v0.4 composer engine: the chat box is a Lexical contenteditable and every
 * typed line is its own <p>. The engine resolves the direction PER LINE
 * (`applyLineDirections`), so a draft can start an Arabic line in RTL and an
 * English line in LTR, while an empty line inherits the direction of the line
 * above it (and the editor surface carries the draft-level direction).
 *
 * Filter: node --test test/client.test.js --test-name-pattern="composer"
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");
const pkg = JSON.parse(read("package.json"));

/**
 * Load `lib/client.js` in a fresh context and return the ModuleLoader spec.
 * @returns {{ id: string, factory: Function }} the captured spec.
 */
function loadSpec() {
  const source = read("lib/client.js");
  const captured = { spec: null };
  const window = {
    __ModuleLoader__: {
      load(candidate) {
        captured.spec = candidate;
      },
    },
  };
  runInNewContext(source, { window });
  return captured.spec;
}

/* ------------------------------------------------------------------------ */
/* Minimal DOM                                                              */
/* ------------------------------------------------------------------------ */

const idem = () => {};

class StubText {
  constructor(value) {
    this.value = value;
    this.parentElement = null;
  }

  get nodeType() {
    return 3;
  }

  get nodeValue() {
    return this.value;
  }

  set nodeValue(next) {
    this.value = next;
  }
}

class StubElement {
  constructor(tagName, attrs = {}) {
    this.tagName = tagName.toUpperCase();
    this.childNodes = [];
    this.attrs = new Map(Object.entries(attrs));
    this.parentElement = null;
  }

  get nodeType() {
    return 1;
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  hasAttribute(name) {
    return this.attrs.has(name);
  }

  get value() {
    if (this.tagName !== "TEXTAREA" && this.tagName !== "INPUT") return undefined;
    return this.childNodes.map((node) => node.nodeValue ?? "").join("");
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.childNodes.push(node);
    }
    return this;
  }

  appendChild(node) {
    return this.append(node);
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      node.parentElement = null;
    }
    return node;
  }

  remove() {
    if (this.parentElement !== null) this.parentElement.removeChild(this);
  }

  closest(selector) {
    const wanted = selector.split(",").map((part) => part.trim());
    let node = this;
    while (node !== null && node !== undefined) {
      if (wanted.some((part) => node.matches(part))) return node;
      node = node.parentElement;
    }
    return null;
  }

  matches(selector) {
    return selector.split(",").some((part) => {
      const test = part.trim();
      if (test === "") return false;
      if (test === "TEXTAREA") return this.tagName === "TEXTAREA";
      if (test === "INPUT") return this.tagName === "INPUT";
      if (test === "*") return true;
      if (test === "[contenteditable=\"true\"]") return this.getAttribute("contenteditable") === "true";
      if (test === "[contenteditable=\"\"]") return this.getAttribute("contenteditable") === "";
      if (test === "[data-composer-input]") return this.hasAttribute("data-composer-input");
      if (test === "[data-composer-placeholder]") return this.hasAttribute("data-composer-placeholder");
      if (test === "[data-lexical-decorator]") return this.hasAttribute("data-lexical-decorator");
      if (test === "[data-dsh-rtl-bidi]") return this.hasAttribute("data-dsh-rtl-bidi");
      if (test === "[data-dsh-rtl-bidi-line]") return this.hasAttribute("data-dsh-rtl-bidi-line");
      if (test === "[dir]") return this.hasAttribute("dir");
      const valued = /^\[([a-z-]+)(?:=(["'])(.*?)\2)?\]$/i.exec(test);
      if (valued !== null) {
        const [, name, , value] = valued;
        if (!this.hasAttribute(name)) return false;
        return value === undefined || this.getAttribute(name) === value;
      }
      // "tag[dir]" and "tag:not([dir])" — an optional attribute condition on a
      // plain tag selector. Anything else is unknown and never matches.
      const compound = /^([a-z][a-z0-9]*)(?:\[([a-z-]+)\]|:not\(\[([a-z-]+)\]\))?$/i.exec(test);
      if (compound === null) return false;
      const [, tag, present, absent] = compound;
      if (this.tagName !== tag.toUpperCase()) return false;
      if (present !== undefined && !this.hasAttribute(present)) return false;
      if (absent !== undefined && this.hasAttribute(absent)) return false;
      return true;
    });
  }

  descendants() {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1) {
          out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }

  querySelectorAll(selector) {
    return this.descendants().filter((node) => node.matches(selector));
  }
}

/**
 * Build a body the way DSH renders it: an assistant message paragraph, the
 * composer shell, and the Lexical root with a caret paragraph.
 * @returns {{ body: StubElement, root: StubElement, placeholder: StubElement, paragraph: StubElement, grow: StubElement }} the stub tree.
 */
function buildComposer() {
  const body = new StubElement("body");
  const message = new StubElement("div");
  message.append(new StubElement("p").append(new StubText("A mixed sentence")));
  const root = new StubElement("div", {
    contenteditable: "true",
    role: "textbox",
    "aria-multiline": "true",
    "data-composer-input": "true",
  });
  const paragraph = new StubElement("p").append(new StubText("\n"));
  // Lexical always keeps at least one paragraph in the editor root.
  root.append(paragraph);
  const placeholder = new StubElement("div", { "data-composer-placeholder": "true" });
  const lineBreak = new StubElement("br");
  placeholder.append(lineBreak);
  const grow = new StubElement("div");
  grow.append(root, placeholder);
  const shell = new StubElement("div");
  shell.append(new StubElement("div"), grow);
  body.append(message, shell);
  return { body, root, placeholder, paragraph, grow };
}

/**
 * Replace a line's text nodes, keeping its parent link (the engine does not
 * care which branch is linked, only that `parentElement` resolves).
 * @param {StubElement} line - line element to rewrite.
 * @param {string} text - the new line text.
 * @returns {StubElement} the same line, for chaining.
 */
function setLine(line, text) {
  line.childNodes = [new StubText(text)];
  line.childNodes[0].parentElement = line;
  return line;
}

/**
 * Append a new Lexical paragraph to the composer and return it.
 * @param {StubElement} root - composer root.
 * @param {string} text - initial text of the line ("" is an empty line).
 * @returns {StubElement} the new line.
 */
function addLine(root, text) {
  const line = new StubElement("p");
  line.append(new StubText(text === "" ? "\n" : text));
  root.append(line);
  return line;
}

/**
 * Install the plugin against the stub DOM and return its handles.
 * @param {StubElement} body - document body the plugin scans.
 * @returns {{ document: object, spec: { id: string, factory: Function } }} install handles.
 */
function installOn(body) {
  const captured = { spec: null };
  const document = {
    body,
    head: new StubElement("head"),
    documentElement: new StubElement("html"),
    getElementById: (id) => document.head.childNodes.find((node) => node.id === id && node.getAttribute("id") === id) || null,
    createElement: (tagName) => new StubElement(tagName),
    createTreeWalker(re) {
      const nodes = [];
      // Every text node under the composer, in document order.
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) nodes.push(child);
          else if (child.nodeType === 1) walk(child);
        }
      };
      walk(re);
      let index = 0;
      return { nextNode: () => (index < nodes.length ? nodes[index++] : null) };
    },
    addEventListener: idem,
    removeEventListener: idem,
    querySelectorAll: (selector) => body.querySelectorAll(selector),
  };
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(candidate) {
          captured.spec = candidate;
        },
      },
    },
    document,
    requestAnimationFrame: undefined,
    setTimeout: () => 0,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
  };
  runInNewContext(read("lib/client.js"), sandbox);
  assert.notEqual(captured.spec, null, "factory captured by the ModuleLoader stub");
  /** The plugin module as the client runner would see it. */
  return { document, spec: captured.spec };
}

/* ------------------------------------------------------------------------ */
/* Contract                                                                 */
/* ------------------------------------------------------------------------ */

test("browser module id equals the package name", () => {
  const spec = loadSpec();
  assert.equal(spec.id, pkg.name);
  assert.equal(typeof spec.factory, "function");
});

test("factory returns the slot registration contract", () => {
  const spec = loadSpec();
  const React = { useEffect: (fn) => { fn(); return undefined; } };
  const mod = spec.factory((name) => {
    if (name === "react") return React;
    throw new Error(`unexpected module ${name}`);
  });
  assert.deepEqual([...mod.inject], ["slots"]);
  assert.equal(typeof mod.apply, "function");
});

test("patch row is inserted, never a bare override", () => {
  const patch = read("cordis.patch.yml");
  const lines = patch.split("\n").filter((line) => line.trim().startsWith("-") && !line.trim().startsWith("#"));
  const rows = lines.filter((line) => !/^\s{4,}-\s/.test(line));
  assert.ok(rows.length > 0, "patch file has at least one row");
  for (const row of rows) {
    assert.ok(row.trim().startsWith("- insert:"), `row is an insert: ${row}`);
  }
  const entries = lines.filter((line) => /^\s+-\s+id:/.test(line));
  assert.deepEqual(entries.map((line) => line.trim()), ["- id: rtl-bidi"]);
  assert.match(patch, /name: '?rtl-bidi-plugin'?/);
});

test("browser half never flips layout containers", () => {
  const source = read("lib/client.js");
  // `dir` is only ever assigned through setAttribute("dir", …) on text blocks
  // and the composer; there is no `documentElement.dir` or body-level RTL.
  assert.doesNotMatch(source, /documentElement\.(dir|setAttribute\("dir")/);
  assert.doesNotMatch(source, /\bdir\s*=\s*"rtl"/);
});

test("code and math stay LTR isolated", () => {
  const css = cssFor();
  const rule = /pre, code, kbd, samp, var[^{]*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "code rule present");
  assert.match(rule[1], /direction: ltr !important/);
  assert.match(rule[1], /unicode-bidi: isolate !important/);
});

/* ------------------------------------------------------------------------ */
/* Behaviour through the DOM stub                                           */
/* ------------------------------------------------------------------------ */

/**
 * Return the injected stylesheet as one CSS string.
 * @returns {string} the CSS text the plugin inserts into <head>.
 */
const cssFor = () => {
  const match = /var CSS = \[([\s\S]*?)\]\.join\("\\n"\);/.exec(read("lib/client.js"));
  const literal = `[${match[1]}]`;
  return runInNewContext(literal, {}).join("\n");
};

/** Split the stylesheet into `{ selector, body }` rules. */
function cssRules() {
  return [...cssFor().matchAll(/([^{}]+)\{([^}]*)\}/g)].map((match) => ({
    selector: match[1].trim().replace(/\s+/g, " "),
    body: match[2],
  }));
}

/**
 * Find the rule whose selector mentions every one of the given fragments.
 * @param {string[]} fragments - selector substrings that must all be present.
 * @returns {{ selector: string, body: string }|undefined} the matching rule.
 */
function findRule(...fragments) {
  return cssRules().find((rule) => fragments.every((fragment) => rule.selector.includes(fragment)));
}

/**
 * A document for the extracted helper functions. `document` is resolved at
 * call time, so tests can point it at a different composer root.
 */
const helperDocument = {
  createTreeWalker(re) {
    const flat = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) flat.push(child);
        else if (child.nodeType === 1) walk(child);
      }
    };
    walk(re);
    let index = 0;
    return { nextNode: () => (index < flat.length ? flat[index++] : null) };
  },
};

const helpers = (() => {
  // Pull the pure helpers out of the factory source so they can be exercised
  // without a browser; the factory body is inert until apply() is called.
  const source = read("lib/client.js");
  const fns = [
    "isRtlCodePoint",
    "firstStrongDirection",
    "composerText",
    "applyDraftDirection",
    "firstLineDirection",
    "applyLineDirections",
    "lineText",
    "applyComposerDirection",
  ];
  const body = fns
    .map((name) => {
      const start = source.indexOf(`function ${name}(`);
      assert.ok(start > 0, `${name} exists`);
      // Brace matching from the first `{` after the signature.
      let depth = 0;
      let i = source.indexOf("{", start);
      for (; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      return source.slice(start, i + 1);
    })
    .join("\n");
  // Exact copies of the factory-level declarations the helpers close over.
  const prelude = `
    var STRONG = /[\\p{L}\\u0591-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFF\\u{10800}-\\u{10FFF}\\u{1E800}-\\u{1EFFF}]/u;
    var composerState = new WeakMap();
    var composerOriginals = [];
    var COMPOSER_MARKER = "data-dsh-rtl-bidi-dir";
    var LINE_MARKER = "data-dsh-rtl-bidi-line";
    var COMPOSER = "[data-composer-input], textarea, [contenteditable=\\"true\\"], [contenteditable=\\"\\"]";
    var LINES = "p, li, h1, h2, h3, h4, h5, h6, blockquote, div[dir]";
    function isComposer(el) {
      if (el.hasAttribute("data-composer-input") || el.tagName === "TEXTAREA" || el.tagName === "INPUT") return true;
      return el.isContentEditable === true || el.getAttribute("contenteditable") !== null;
    }
    function isChromeNode(node) {
      var el = node && node.nodeType === 1 ? node : node && node.parentElement;
      if (!el || !el.closest) return false;
      return el.closest("[data-composer-placeholder], [data-lexical-decorator]") !== null;
    }
  `;
  const sandbox = {
    document: helperDocument,
    exports: {},
  };
  runInNewContext(
    `${prelude}\n${body}\nexports.f = {
      isRtlCodePoint,
      firstStrongDirection,
      composerText,
      applyDraftDirection,
      firstLineDirection,
      applyLineDirections,
      lineText,
      applyComposerDirection,
    };`,
    sandbox,
  );
  assert.equal(typeof sandbox.exports.f.firstStrongDirection, "function", "helpers extracted");
  assert.equal(sandbox.exports.f.firstStrongDirection("مرحبا"), "rtl", "extracted helper works");
  return sandbox.exports.f;
})();

test("first strong character decides the direction (UBA P2/P3)", () => {
  assert.equal(helpers.firstStrongDirection("مرحبا hello"), "rtl");
  assert.equal(helpers.firstStrongDirection("hello مرحبا"), "ltr");
  assert.equal(helpers.firstStrongDirection("123 مرحبا"), "rtl", "digits are neutral");
  assert.equal(helpers.firstStrongDirection('"hello" مرحبا'), "ltr");
  assert.equal(helpers.firstStrongDirection("«مرحبا»"), "rtl");
  assert.equal(helpers.firstStrongDirection("שלום world"), "rtl", "Hebrew counts");
  assert.equal(helpers.firstStrongDirection("🚀 مرحبا"), "rtl", "emoji is neutral");
  assert.equal(helpers.firstStrongDirection(""), null);
  assert.equal(helpers.firstStrongDirection("123 456 …"), null, "neutral text has no direction");
});

/* ------------------------------------------------------------------------ */
/* Composer: per-line direction engine                                      */
/* ------------------------------------------------------------------------ */

test("composer: a line with Arabic gets dir=rtl", () => {
  const { root, paragraph } = buildComposer();
  setLine(paragraph, "مرحبا");
  helpers.applyComposerDirection(root);
  assert.equal(paragraph.getAttribute("dir"), "rtl", "the Arabic line is rtl");
  assert.ok(paragraph.hasAttribute("data-dsh-rtl-bidi-line"), "line is marked for cleanup");
  assert.equal(root.getAttribute("dir"), "rtl", "the surface follows the first line");
});

test("composer: a new empty line after an Arabic line inherits rtl", () => {
  const { root, paragraph } = buildComposer();
  setLine(paragraph, "مرحبا");
  helpers.applyComposerDirection(root);
  assert.equal(paragraph.getAttribute("dir"), "rtl");

  // Enter: Lexical leaves the caret on a fresh, still empty paragraph.
  const next = addLine(root, "");
  helpers.applyComposerDirection(root);
  assert.equal(next.getAttribute("dir"), "rtl", "the empty line inherits the direction above it");
  assert.equal(root.getAttribute("dir"), "rtl", "the surface stays rtl so the caret does not jump");
  assert.equal(paragraph.getAttribute("dir"), "rtl", "the first line keeps its own direction");
});

test("composer: each line keeps its own direction (Arabic line, then English line)", () => {
  // The whole point of v0.4: a draft can start a line in either language.
  const { root, paragraph } = buildComposer();
  setLine(paragraph, "مرحبا");
  const second = addLine(root, "hello");
  helpers.applyComposerDirection(root);
  assert.equal(paragraph.getAttribute("dir"), "rtl", "Arabic line is rtl");
  assert.equal(second.getAttribute("dir"), "ltr", "English line is ltr");
  assert.equal(root.getAttribute("dir"), "rtl", "the surface keeps the draft's first line direction");

  // And back again: a third Arabic line is rtl next to an English one.
  const third = addLine(root, "وداعاً");
  helpers.applyComposerDirection(root);
  assert.deepEqual(
    [paragraph, second, third].map((line) => line.getAttribute("dir")),
    ["rtl", "ltr", "rtl"],
    "lines switch direction independently",
  );
});

test("composer: a line starting with English then containing Arabic is ltr", () => {
  const { root, paragraph } = buildComposer();
  setLine(paragraph, "hello مرحبا");
  helpers.applyComposerDirection(root);
  assert.equal(paragraph.getAttribute("dir"), "ltr", "the first strong character decides the line");
  assert.equal(root.getAttribute("dir"), "ltr");

  // Typing the Arabic word character by character must not flip the line.
  for (const text of ["h", "hel", "hello ", "hello م", "hello مرحبا"]) {
    setLine(paragraph, text);
    helpers.applyComposerDirection(root);
    assert.equal(paragraph.getAttribute("dir"), "ltr", `still ltr at "${text}"`);
  }
});

test("composer: an empty draft gets no direction anywhere", () => {
  const { root, paragraph } = buildComposer();
  setLine(paragraph, "");
  helpers.applyComposerDirection(root);
  assert.equal(root.getAttribute("dir"), null, "surface has no dir");
  assert.equal(paragraph.hasAttribute("dir"), false, "line has no dir");
  assert.equal(paragraph.hasAttribute("data-dsh-rtl-bidi-line"), false, "line is not marked");
  assert.equal(root.hasAttribute("data-dsh-rtl-bidi-dir"), false, "surface is not marked");
});

test("composer: clearing the draft forgets the old direction", () => {
  // A stale rtl/ltr must not leak into the next, unrelated draft.
  const { root, paragraph } = buildComposer();
  setLine(paragraph, "hello");
  helpers.applyComposerDirection(root);
  assert.equal(paragraph.getAttribute("dir"), "ltr");

  setLine(paragraph, "");
  helpers.applyComposerDirection(root);
  assert.equal(paragraph.hasAttribute("dir"), false, "cleared line has no direction");
  assert.equal(root.hasAttribute("dir"), false, "surface forgot the stale direction");
});


test("composer: chips and placeholder content never decide a line's direction", () => {
  const { root, paragraph } = buildComposer();
  // A chip (Lexical decorator) holding LTR path text sits inside the line
  // before any typed character; it is chrome and must not make the line LTR.
  const chip = new StubElement("span", { "data-lexical-decorator": "true" });
  chip.append(new StubText("path/to/file.ts"));
  chip.parentElement = paragraph;
  paragraph.append(chip);
  helpers.applyComposerDirection(root);
  // Only Lexical's own newline remains once the chip is skipped.
  assert.equal(helpers.lineText(paragraph), "\n", "decorator text is skipped per line");
  assert.equal(paragraph.hasAttribute("dir"), false, "an LTR chip alone does not make the line ltr");
  assert.equal(root.getAttribute("dir"), null, "nor the surface");

  // The user types Arabic next to the chip: the typed text decides.
  const typed = new StubText("مرحبا");
  typed.parentElement = paragraph;
  paragraph.childNodes = [typed, chip];
  helpers.applyComposerDirection(root);
  assert.equal(paragraph.getAttribute("dir"), "rtl", "the typed Arabic decides the line");
  assert.equal(root.getAttribute("dir"), "rtl");

  // Arabic chip text must not decide either: typed English wins.
  const arabicChip = new StubElement("span", { "data-lexical-decorator": "true" });
  arabicChip.append(new StubText("ملف"));
  arabicChip.parentElement = paragraph;
  paragraph.childNodes = [arabicChip, typed];
  typed.value = "hello";
  helpers.applyComposerDirection(root);
  assert.equal(paragraph.getAttribute("dir"), "ltr", "typed English decides, not the Arabic chip");
});

test("composer: a host-owned dir on the surface is never overridden", () => {
  const { root, paragraph } = buildComposer();
  root.setAttribute("dir", "bogus");
  setLine(paragraph, "مرحبا");
  helpers.applyComposerDirection(root);
  assert.equal(root.getAttribute("dir"), "bogus", "the host keeps its attribute");
  assert.equal(root.hasAttribute("data-dsh-rtl-bidi-dir"), false, "and is not marked for cleanup");
  // A foreign surface dir is not a usable inheritance source for neutral
  // lines; each decisive line still resolves from its own text.
  const empty = addLine(root, "");
  const english = addLine(root, "hello");
  helpers.applyComposerDirection(root);
  assert.equal(root.getAttribute("dir"), "bogus", "still untouched after a full pass");
  assert.equal(empty.getAttribute("dir"), "rtl", "a neutral line inherits the decisive line above it, not 'bogus'");
  assert.equal(english.getAttribute("dir"), "ltr", "a decisive line resolves on its own");
});

test("composer CSS: surface normalises bidi, lines resolve per line", () => {
  const surface = findRule("[data-composer-input]");
  assert.ok(surface, "composer surface rule present");
  assert.match(surface.body, /unicode-bidi: normal !important/);
  assert.doesNotMatch(surface.body, /plaintext/, "plaintext would re-resolve each line and drop to LTR");
  assert.match(surface.body, /direction: start !important/);

  const lines = findRule("[data-composer-input] p");
  assert.ok(lines !== undefined, "composer line rule present");
  assert.match(lines.body, /direction: revert !important/, "the line's own [dir] decides");
  assert.match(lines.body, /unicode-bidi: normal !important/);

  const fallback = findRule("[data-composer-input] p:not([dir])");
  assert.ok(fallback, "unresolved lines inherit the surface direction");
  assert.match(fallback.body, /direction: inherit !important/);
  // Never plaintext on composer lines: it re-resolves each line from the
  // line's own content, which is exactly the failure being fixed.
  for (const rule of [surface, lines, fallback]) {
    assert.doesNotMatch(rule.body, /unicode-bidi: plaintext/);
  }
});

test("composer: Lexical's dir=auto on a paragraph is replaced by the resolved direction", () => {
  const { root, paragraph } = buildComposer();
  // Lexical's reconciler stamps dir="auto" on every paragraph it renders.
  paragraph.setAttribute("dir", "auto");
  setLine(paragraph, "مرحبا");
  helpers.applyComposerDirection(root);
  assert.equal(paragraph.getAttribute("dir"), "rtl", "auto is replaced by the resolved line direction");
  assert.equal(root.getAttribute("dir"), "rtl");

  // A new line that Lexical has already stamped: still resolved, not left as auto.
  const second = addLine(root, "hello");
  second.setAttribute("dir", "auto");
  helpers.applyComposerDirection(root);
  assert.equal(second.getAttribute("dir"), "ltr", "auto on the second line is replaced too");
  assert.equal(root.getAttribute("dir"), "rtl", "the surface is not re-stamped by a later line");

  // An empty line carrying auto takes the direction of the line directly above
  // it (the English line), as a word processor chains paragraph directions.
  const third = addLine(root, "");
  third.setAttribute("dir", "auto");
  helpers.applyComposerDirection(root);
  assert.equal(third.getAttribute("dir"), "ltr", "empty line inherits the line above, not a global LTR fallback");
  assert.notEqual(third.getAttribute("dir"), "auto", "auto never survives");
  assert.equal(root.getAttribute("dir"), "rtl", "the surface still tracks the first decisive line");

  // With no decisive line at all the surface has no direction, so a lone
  // empty auto line is neutral, not silently LTR.
  const lonely = buildComposer();
  lonely.paragraph.setAttribute("dir", "auto");
  setLine(lonely.paragraph, "");
  helpers.applyComposerDirection(lonely.root);
  assert.equal(lonely.root.getAttribute("dir"), null, "no direction without a decisive character");
  assert.equal(lonely.paragraph.hasAttribute("dir"), false, "auto removed from a neutral line");
});

/**
 * Mount the plugin the way the slot runtime does: apply() registers the
 * overlay component, and the component's effect runs on mount.
 * @param {{ spec: { factory: Function } }} harness - value returned by installOn.
 * @returns {() => void} the disposer the effect returned.
 */
function mountOverlay(harness) {
  const hooks = { cleanup: null };
  const React = {
    useEffect(effect) {
      hooks.cleanup = effect();
    },
  };
  const mod = harness.spec.factory(() => React);
  let Mounted = null;
  mod.apply({
    slots: {
      inject: (name, fn) => fn(),
      register: (_entry, Component) => {
        Mounted = Component;
        return null;
      },
    },
  });
  assert.equal(typeof Mounted, "function", "overlay component registered");
  assert.equal(Mounted(), null, "overlay renders nothing");
  assert.equal(typeof hooks.cleanup, "function", "effect returned a disposer");
  return hooks.cleanup;
}

test("installed effect tags blocks and leaves the composer to the engine", () => {
  const { body, root, paragraph } = buildComposer();
  setLine(paragraph, "مرحبا");
  const harness = installOn(body);
  mountOverlay(harness);
  assert.equal(root.getAttribute("dir"), "rtl", "the composer got its direction on mount");
  assert.equal(paragraph.getAttribute("dir"), "rtl", "and each line was resolved on mount");
  const tagged = body.querySelectorAll("p").filter((el) => el.getAttribute("dir") === "auto");
  assert.ok(tagged.length >= 1, "assistant prose paragraph got dir=auto");
  assert.equal(root.getAttribute("dir"), "rtl", "composer keeps its computed direction");
  assert.ok(root.hasAttribute("data-dsh-rtl-bidi-dir"), "composer direction is marked for cleanup");
});

test("unmount removes only what the plugin added", () => {
  const { body, root, paragraph } = buildComposer();
  setLine(paragraph, "مرحبا");
  const second = addLine(root, "hello");
  const harness = installOn(body);
  const cleanup = mountOverlay(harness);
  assert.equal(root.getAttribute("dir"), "rtl");
  assert.equal(second.getAttribute("dir"), "ltr");
  cleanup();
  assert.equal(root.getAttribute("dir"), null, "composer dir restored");
  assert.equal(root.hasAttribute("data-dsh-rtl-bidi-dir"), false);
  assert.equal(second.hasAttribute("data-dsh-rtl-bidi-line"), false, "line marker removed");
  assert.equal(second.hasAttribute("dir"), false, "line dir removed");
  assert.equal(
    body.querySelectorAll("p").filter((el) => el.hasAttribute("data-dsh-rtl-bidi")).length,
    0,
    "block markers removed",
  );
});
