/**
 * Contract and behaviour tests for the browser half of rtl-bidi-plugin.
 *
 * No dependency and no browser: the ModuleLoader spec is captured from
 * `lib/client.js`, the factory runs against a tiny stub of the platform module
 * table, and a hand-written DOM stub lets the composer engine be exercised
 * directly (this is the exact path that broke in v0.2 — a `unicode-bidi:
 * plaintext` rule cannot fix a paragraph whose only content is an <br>).
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

const BUTTON = "BUTTON";
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
      if (test === "TEXTAREA") return this.tagName === "TEXTAREA";
      if (test === "INPUT") return this.tagName === "INPUT";
      if (test === "[contenteditable=\"true\"]") return this.getAttribute("contenteditable") === "true";
      if (test === "[contenteditable=\"\"]") return this.getAttribute("contenteditable") === "";
      if (test === "[data-composer-input]") return this.hasAttribute("data-composer-input");
      if (test === "[data-composer-placeholder]") return this.hasAttribute("data-composer-placeholder");
      if (test === "[data-lexical-decorator]") return this.hasAttribute("data-lexical-decorator");
      if (test === "[data-dsh-rtl-bidi]") return this.hasAttribute("data-dsh-rtl-bidi");
      if (/^[a-z][a-z0-9]*$/i.test(test)) return this.tagName === test.toUpperCase();
      // Unknown selector in the stub: never match (keeps the stub honest).
      return false;
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
 * @returns {{ body: StubElement, root: StubElement, placeholder: StubElement }} the stub tree.
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

function firstCss() {
  return cssFor().split("\n");
}

const helpers = (() => {
  // Pull the pure helpers out of the factory source so they can be exercised
  // without a browser; the factory body is inert until apply() is called.
  const source = read("lib/client.js");
  const fns = ["isRtlCodePoint", "firstStrongDirection", "composerText", "applyComposerDirection"];
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
  const prelude = `
    var STRONG = /[\\p{L}\\u0591-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFF\\u{10800}-\\u{10FFF}\\u{1E800}-\\u{1EFFF}]/u;
    var composerState = new WeakMap();
    var composerOriginals = [];
    var COMPOSER_MARKER = "data-dsh-rtl-bidi-dir";
    var COMPOSER = "[data-composer-input], textarea, [contenteditable=\\"true\\"], [contenteditable=\\"\\"]";
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
    document: {
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
    },
    exports: {},
  };
  runInNewContext(`${prelude}\n${body}\nexports.f = { firstStrongDirection, applyComposerDirection, composerText };`, sandbox);
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

test("composer: an empty composer gets no direction until there is text", () => {
  const { root } = buildComposer();
  helpers.applyComposerDirection(root);
  assert.equal(root.getAttribute("dir"), null);
});

test("composer: Arabic sets rtl before the first painted character", () => {
  const { root, paragraph } = buildComposer();
  paragraph.childNodes = [new StubText("م")];
  helpers.applyComposerDirection(root);
  assert.equal(root.getAttribute("dir"), "rtl");
});

test("composer: the direction does not flip back while the next line is empty (Enter)", () => {
  const { root, paragraph } = buildComposer();
  paragraph.childNodes = [new StubText("مرحبا")];
  helpers.applyComposerDirection(root);
  assert.equal(root.getAttribute("dir"), "rtl");
  // Enter: Lexical appends a new empty paragraph and leaves an empty one behind.
  paragraph.childNodes = [new StubText("\n")];
  const next = new StubElement("p").append(new StubText("\n"));
  root.append(next);
  helpers.applyComposerDirection(root);
  assert.equal(root.getAttribute("dir"), "rtl", "caret keeps its right-hand side");
  // First character of the new line: already on the right, no wait for a third event.
  next.childNodes[0] = new StubText("م");
  helpers.applyComposerDirection(root);
  assert.equal(root.getAttribute("dir"), "rtl");
});

test("composer: English text switches the composer to ltr and back", () => {
  const { root, paragraph } = buildComposer();
  paragraph.childNodes = [new StubText("مرحبا")];
  helpers.applyComposerDirection(root);
  assert.equal(root.getAttribute("dir"), "rtl");
  paragraph.childNodes = [new StubText("hello")];
  helpers.applyComposerDirection(root);
  assert.equal(root.getAttribute("dir"), "ltr");
  paragraph.childNodes = [new StubText("سلام")];
  helpers.applyComposerDirection(root);
  assert.equal(root.getAttribute("dir"), "rtl");
});

test("composer: chips and the placeholder never decide the direction", () => {
  const { root, paragraph, placeholder } = buildComposer();
  const decorator = new StubElement("span", { "data-lexical-decorator": "true" }).append(
    new StubText("path/to/file.ts"),
  );
  root.append(decorator);
  paragraph.childNodes = [new StubText("\n")];
  assert.equal(helpers.composerText(root), "\n", "decorator text is skipped");
  helpers.applyComposerDirection(root);
  assert.equal(root.getAttribute("dir"), null, "LTR chrome does not force ltr");
  void placeholder;
  paragraph.childNodes = [new StubText("مرحبا")];
  helpers.applyComposerDirection(root);
  assert.equal(root.getAttribute("dir"), "rtl", "first typed strong text wins");
});

test("composer: a host-owned dir attribute is never overridden", () => {
  const { root, paragraph } = buildComposer();
  root.setAttribute("dir", "bogus");
  paragraph.childNodes = [new StubText("مرحبا")];
  helpers.applyComposerDirection(root);
  assert.equal(root.getAttribute("dir"), "bogus");
});

test("composer CSS: lines inherit the composer direction instead of plaintext-only", () => {
  const css = cssFor();
  const surface = /\[data-composer-input\][^{]*\{([^}]*)\}/.exec(css);
  assert.ok(surface, "composer surface rule present");
  assert.match(surface[1], /direction: start !important/);
  assert.match(surface[1], /unicode-bidi: plaintext !important/);
  const lines = /\[data-composer-input\] p, \[data-composer-input\] li \{([^}]*)\}/.exec(css);
  assert.ok(lines, "composer paragraph rule present");
  assert.match(lines[1], /direction: inherit !important/);
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
  paragraph.childNodes = [new StubText("مرحبا")];
  const harness = installOn(body);
  mountOverlay(harness);
  assert.equal(root.getAttribute("dir"), "rtl", "the composer got its direction on mount");
  const tagged = body.querySelectorAll("p").filter((el) => el.getAttribute("dir") === "auto");
  assert.ok(tagged.length >= 1, "assistant prose paragraph got dir=auto");
  assert.equal(root.getAttribute("dir"), "rtl", "composer keeps its computed direction");
  assert.ok(root.hasAttribute("data-dsh-rtl-bidi-dir"), "composer direction is marked for cleanup");
});

test("unmount removes only what the plugin added", () => {
  const { body, root, paragraph } = buildComposer();
  paragraph.childNodes = [new StubText("مرحبا")];
  const harness = installOn(body);
  const cleanup = mountOverlay(harness);
  assert.equal(root.getAttribute("dir"), "rtl");
  cleanup();
  assert.equal(root.getAttribute("dir"), null, "composer dir restored");
  assert.equal(root.hasAttribute("data-dsh-rtl-bidi-dir"), false);
  assert.equal(
    body.querySelectorAll("p").filter((el) => el.hasAttribute("data-dsh-rtl-bidi")).length,
    0,
    "block markers removed",
  );
});
