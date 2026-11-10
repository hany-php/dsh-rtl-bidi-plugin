window.__ModuleLoader__.load({
  id: "rtl-bidi-plugin",
  factory(require) {
    var React = require("react");

    // ---------------------------------------------------------------------
    // Presentation override: every text block gets its own base direction
    // (Unicode UBA P2/P3), exactly the behaviour a bilingual editor shows.
    // Chrome layout, icons, tables and code never flip.
    //
    // Composer note (v0.3.x): the chat box is a Lexical contenteditable. Every
    // typed line is its own <p>, and Lexical stamps dir="auto" on that <p> on
    // each render. A fresh line is `<p><br></p>` — no strong character — so
    // dir="auto" resolves it to LTR and the caret starts on the left while the
    // *next* line (already holding Arabic) looks right. The composer therefore
    // gets an explicit dir from the first strong character of the whole draft,
    // and every line element has its dir attribute stripped so it inherits
    // that direction (see applyComposerDirection / clearLineDirections).
    // ---------------------------------------------------------------------
    var CSS = [
      "p, li, ul, ol, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, figcaption, summary, td, th, caption, label {",
      "  unicode-bidi: plaintext !important;",
      "  text-align: start !important;",
      "}",
      // Markdown/prose wrappers: let the browser resolve the paragraph level
      // without inheriting a base direction into nested layout boxes.
      '[class*="markdown"], [class*="_markdown_"], [class*="prose"], [class*="messageText"], [class*="messageBody"], [class*="_bubble_"] {',
      "  unicode-bidi: plaintext !important;",
      "}",
      "pre, code, kbd, samp, var, .katex, .katex *, [class*=\"shiki\"], [class*=\"codeBlock\"], [class*=\"_codeBlock\"] {",
      "  direction: ltr !important;",
      "  unicode-bidi: isolate !important;",
      "  text-align: left !important;",
      "}",
      // Composer surface. `normal` lets the explicit dir attribute decide the
      // base direction; `plaintext` would re-resolve it from the content and
      // would drop back to LTR whenever the draft opens with neutral text.
      "textarea, input[type=\"text\"], input[type=\"search\"], [contenteditable=\"true\"], [contenteditable=\"\"], [data-composer-input] {",
      "  unicode-bidi: normal !important;",
      "  text-align: start !important;",
      "  direction: start !important;",
      "}",
      // Each typed line (a Lexical paragraph) follows the composer direction.
      // Lexical stamps dir="auto" on every paragraph it renders (its DOM
      // reconciler writes the attribute for each ElementNode), and an empty
      // line is `<p><br></p>` with no strong character — so dir="auto" resolves
      // it to LTR and the caret starts on the left. `plaintext` deliberately
      // is NOT used here: it would re-resolve every line on its own content
      // and reproduce the bug. `normal` + inherited direction keeps every line
      // on the composer's base direction and overrides the [dir] attribute.
      '[data-composer-input] p, [data-composer-input] li, [data-composer-input] p[dir], [data-composer-input] li[dir] {',
      "  unicode-bidi: normal !important;",
      "  text-align: start !important;",
      "  direction: inherit !important;",
      "}",
      "[dir=\"rtl\"] { line-height: 1.7; letter-spacing: 0; }",
    ].join("\n");

    // Characters the browser can classify as strong (Unicode UBA P2). Everything
    // outside them — digits, spaces, punctuation, emoji, chips/mentions — is
    // direction-neutral, so the *first* strong character decides the direction.
    // The class is intentionally broad for scripts whose blocks are not
    // enumerated here; a wrong guess only costs a missing direction hint.
    // RTL blocks counted by isRtlCodePoint(): Hebrew, Arabic, Syriac, Thaana,
    // NKo, Samaritan, Mandaic, Arabic/Hebrew presentation forms, and the
    // historic RTL blocks in planes 1 and 2.
    var STRONG = /[\p{L}\u0591-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

    var STYLE_ID = "dsh-rtl-bidi-css";
    var MARKER = "data-dsh-rtl-bidi";
    var COMPOSER_MARKER = "data-dsh-rtl-bidi-dir";
    var COMPOSER = "[data-composer-input], textarea, [contenteditable=\"true\"], [contenteditable=\"\"]";
    // Line elements Lexical creates inside the composer root.
    var LINES = "p, li, h1, h2, h3, h4, h5, h6, blockquote, div[dir]";
    var BLOCKS =
      "p, li, ul, ol, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, figcaption, summary, td, th";
    var EXCLUDE =
      'pre, code, kbd, samp, .katex, [class*="shiki"], [class*="codeBlock"], [class*="_codeBlock"]';

    /**
     * Whether a code point belongs to a right-to-left script.
     * @param {number} cp - Unicode code point.
     * @returns {boolean} true for Hebrew/Arabic/Thaana/… , false otherwise.
     */
    function isRtlCodePoint(cp) {
      if ((cp >= 0x0591 && cp <= 0x08ff) || (cp >= 0xfb1d && cp <= 0xfdff)) return true;
      if (cp >= 0xfe70 && cp <= 0xfeff) return true;
      if (cp >= 0x10800 && cp <= 0x10fff) return true;
      if (cp >= 0x1e800 && cp <= 0x1efff) return true;
      return false;
    }

    /**
     * Resolve the base direction of a string from its first strong character,
     * following the same rule the browser applies to `dir="auto"` (UBA P2/P3),
     * but returning the neutral answer `null` when the text has none.
     * @param {string} text - text to classify.
     * @returns {"rtl"|"ltr"|null} resolved direction, or null when text is neutral.
     */
    function firstStrongDirection(text) {
      if (!text) return null;
      var match = STRONG.exec(text);
      if (match === null) return null;
      var cp = match[0].codePointAt(0);
      return isRtlCodePoint(cp) ? "rtl" : "ltr";
    }

    /**
     * Whether an element is one of the composer-style editable surfaces.
     * @param {Element} el - element to test.
     * @returns {boolean} true for the chat composer and any other text box.
     */
    function isComposer(el) {
      if (el.hasAttribute("data-composer-input") || el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        return true;
      }
      // Any contenteditable value ("true", "", "plaintext-only", inherited) —
      // the DOM property resolves inheritance, the attribute does not.
      return el.isContentEditable === true || el.getAttribute("contenteditable") !== null;
    }

    function mark(el) {
      if (!el || el.nodeType !== 1) return;
      // The composer owns its own direction through applyComposerDirection().
      if (isComposer(el)) return;
      if (el.closest && el.closest(EXCLUDE)) return;
      if (el.hasAttribute("dir")) return;
      el.setAttribute("dir", "auto");
      el.setAttribute(MARKER, "1");
    }

    function scan(root) {
      if (!root) return;
      if (root.nodeType === 1 && root.matches && root.matches(BLOCKS)) {
        mark(root);
      }
      if (!root.querySelectorAll) return;

      var nodes = root.querySelectorAll(BLOCKS);
      for (var i = 0; i < nodes.length; i++) mark(nodes[i]);
    }

    // -------------------------------------------------------------------
    // Composer direction
    // -------------------------------------------------------------------

    // Last direction handed to one composer. Kept in a WeakMap rather than on
    // the element so React never sees an attribute it does not manage and can
    // never "heal" it back, and so cleanup can restore the original `dir`.
    var composerState = typeof WeakMap === "function" ? new WeakMap() : null;
    var composerOriginals = [];

    /** Text nodes that never carry user-typed content and must not be measured. */
    function isChromeNode(node) {
      var el = node && node.nodeType === 1 ? node : node && node.parentElement;
      if (!el || !el.closest) return false;
      return el.closest("[data-composer-placeholder], [data-lexical-decorator]") !== null;
    }

    /**
     * Read the text the user actually sees in a composer, in document order.
     * Decorator portals (chips) and the placeholder are skipped.
     * @param {Element} root - composer element.
     * @returns {string} concatenated visible text.
     */
    function composerText(root) {
      if (root.tagName === "TEXTAREA" || root.tagName === "INPUT") return String(root.value || "");
      var text = "";
      var walker = document.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, null);
      var node = walker.nextNode();
      while (node !== null) {
        if (!isChromeNode(node)) text += node.nodeValue;
        node = walker.nextNode();
      }
      return text;
    }

    /**
     * Apply the direction resolved from the composer text.
     *
     * Lexical writes `dir="auto"` onto EVERY paragraph element itself
     * (`_e$2` in its DOM reconciler, called for each ElementNode on render),
     * and an attribute on the paragraph beats anything inherited from the
     * editor surface. On a fresh line that paragraph is `<p><br></p>` — no
     * strong character — so `dir="auto"` resolves to the inherited LTR and the
     * caret lands on the left. That is why a wrapper attribute alone never
     * fixed the first line.
     *
     * So: resolve the direction from the whole draft, put it on the editor
     * surface, and strip the per-paragraph `dir` so each line inherits it.
     * A line that is still empty keeps the previous direction, so Enter does
     * not flip the caret.
     * @param {Element} el - composer element.
     */
    function applyComposerDirection(el) {
      if (!el || el.nodeType !== 1 || !isComposer(el)) return;
      var previous = composerState === null ? null : composerState.get(el);
      var last = previous === undefined ? null : previous;
      var next = firstStrongDirection(composerText(el)) || last;
      var current = el.getAttribute("dir");
      // Never fight the host: an upstream `dir="auto"` is already correct and
      // self-updating. `rtl`/`ltr` of our own making is simply re-evaluated.
      if (current !== null && current !== "auto" && current !== "rtl" && current !== "ltr") return;

      if (next !== null) {
        if (previous === undefined) {
          composerOriginals.push([el, current]);
          if (composerState !== null) composerState.set(el, next);
          el.setAttribute(COMPOSER_MARKER, "1");
        } else if (composerState !== null) {
          composerState.set(el, next);
        }
        if (current !== next) el.setAttribute("dir", next);
      }

      // Every line under the editor must inherit the surface direction.
      clearLineDirections(el.tagName === "TEXTAREA" || el.tagName === "INPUT" ? null : el);
    }

    /**
     * Remove the `dir` attribute Lexical stamps on each line element, so the
     * line inherits the composer direction instead of resolving its own.
     * @param {Element|null} root - composer element (skipped for plain inputs).
     */
    function clearLineDirections(root) {
      if (root === null || !root.querySelectorAll) return;
      var lines = root.querySelectorAll(LINES);
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].hasAttribute("dir")) lines[i].removeAttribute("dir");
      }
    }

    /** Re-apply the composer direction to every live composer. */
    function syncComposers() {
      var nodes = document.querySelectorAll(COMPOSER);
      for (var i = 0; i < nodes.length; i++) applyComposerDirection(nodes[i]);
    }

    /**
     * Find the composer that owns an event target (the target may be a text
     * node, a chip, or a node inside the editor).
     * @param {Event} event - input/selection event.
     * @returns {Element|null} the composer element, if any.
     */
    function composerFromEvent(event) {
      var target = event && event.target;
      if (!target) return null;
      var el = target.nodeType === 1 ? target : target.parentElement;
      if (!el || !el.closest) return null;
      if (isComposer(el)) return el;
      return el.closest(COMPOSER);
    }

    // -------------------------------------------------------------------
    // Document level installation
    // -------------------------------------------------------------------

    var scheduled = false;
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      var run = function () {
        scheduled = false;
        if (document.body) scan(document.body);
        syncComposers();
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
      else setTimeout(run, 16);
    }

    function installStyles() {
      if (document.getElementById(STYLE_ID)) return false;
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      (document.head || document.documentElement).appendChild(style);
      return true;
    }

    function install() {
      var insertedStyle = installStyles();
      if (document.body) scan(document.body);
      syncComposers();

      // Composer events are discrete, so they are handled synchronously: the
      // direction must be on the element before the browser paints the next
      // character or the caret.
      var onComposerEvent = function (event) {
        var el = composerFromEvent(event);
        if (el !== null) applyComposerDirection(el);
      };
      var events = ["input", "keydown", "keyup", "compositionstart", "compositionend", "paste", "cut", "drop"];
      for (var i = 0; i < events.length; i++) {
        document.addEventListener(events[i], onComposerEvent, true);
      }
      document.addEventListener("selectionchange", onComposerEvent, true);

      // React/Lexical rebuild the paragraph nodes while typing and re-stamp
      // dir="auto" on them during their own render. Two passes: immediately
      // (before paint, so no frame shows the wrong side) and once the frame
      // settles for streamed/reconciled subtrees.
      var undoInFlight = false;
      var observer = new MutationObserver(function (records) {
        var touchesComposer = false;
        for (var r = 0; r < records.length; r++) {
          var record = records[r];
          if (record.type === "characterData" || record.addedNodes.length > 0) {
            if (!touchesComposer) {
              var host = (record.target && record.target.closest && record.target.closest(COMPOSER)) || null;
              if (host === null) {
                for (var a = 0; a < record.addedNodes.length; a++) {
                  var added = record.addedNodes[a];
                  if (added.nodeType === 1 && added.closest && added.closest(COMPOSER) !== null) {
                    host = added.closest(COMPOSER);
                    break;
                  }
                }
              }
              if (host !== null) {
                touchesComposer = true;
                applyComposerDirection(host);
              }
            }
            schedule();
          } else if (
            record.type === "attributes" &&
            record.attributeName === "dir" &&
            record.target.closest &&
            record.target.closest("[data-composer-input]") !== null
          ) {
            // Lexical just re-stamped a line: undo it in the same task. The
            // removal below produces another attribute record; `undoInFlight`
            // keeps that echo from recursing.
            if (!undoInFlight) {
              undoInFlight = true;
              try {
                record.target.removeAttribute("dir");
              } finally {
                undoInFlight = false;
              }
            }
          }
        }
      });
      observer.observe(document.body || document.documentElement, {
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["dir"],
        subtree: true,
      });

      return function cleanup() {
        observer.disconnect();
        for (var k = 0; k < events.length; k++) {
          document.removeEventListener(events[k], onComposerEvent, true);
        }
        document.removeEventListener("selectionchange", onComposerEvent, true);
        var style = document.getElementById(STYLE_ID);
        if (insertedStyle && style && style.parentNode) style.parentNode.removeChild(style);
        var marked = document.querySelectorAll("[" + MARKER + "]");
        for (var m = 0; m < marked.length; m++) {
          marked[m].removeAttribute("dir");
          marked[m].removeAttribute(MARKER);
        }
        for (var c = 0; c < composerOriginals.length; c++) {
          var entry = composerOriginals[c];
          if (entry[1] === null) entry[0].removeAttribute("dir");
          else entry[0].setAttribute("dir", entry[1]);
          entry[0].removeAttribute(COMPOSER_MARKER);
        }
        composerOriginals.length = 0;
      };
    }

    /**
     * Renders nothing; owns the document-level bidi effect for as long as the
     * frame-wide overlay entry is mounted.
     */
    function BidiDirection() {
      React.useEffect(function () {
        return install();
      }, []);
      return null;
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("shell.overlay", function () {
          return ctx.slots.register(
            { name: "shell.overlay", id: "rtl-bidi", order: 100 },
            BidiDirection,
          );
        });
      },
    };
  },
});
