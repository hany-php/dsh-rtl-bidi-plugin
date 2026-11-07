window.__ModuleLoader__.load({
  id: "rtl-bidi-plugin",
  factory(require) {
    var React = require("react");

    // ---------------------------------------------------------------------
    // Presentation override: every text block gets its own base direction
    // (Unicode UBA P2/P3), exactly the behaviour a bilingual editor shows.
    // Chrome layout, icons, tables and code never flip.
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
      "textarea, input[type=\"text\"], input[type=\"search\"], [contenteditable=\"true\"], [contenteditable=\"\"] {",
      "  unicode-bidi: plaintext !important;",
      "  text-align: start !important;",
      "}",
      "[dir=\"rtl\"] { line-height: 1.7; letter-spacing: 0; }",
    ].join("\n");

    var STYLE_ID = "dsh-rtl-bidi-css";
    var MARKER = "data-dsh-rtl-bidi";
    var INPUTS =
      'textarea, [contenteditable="true"], [contenteditable=""], input[type="text"], input[type="search"]';
    var BLOCKS =
      "p, li, ul, ol, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, figcaption, summary, td, th";
    var EXCLUDE =
      'pre, code, kbd, samp, .katex, [class*="shiki"], [class*="codeBlock"], [class*="_codeBlock"]';

    function mark(el) {
      if (!el || el.nodeType !== 1) return;
      if (el.closest && el.closest(EXCLUDE)) return;
      if (el.hasAttribute("dir")) return;
      el.setAttribute("dir", "auto");
      el.setAttribute(MARKER, "1");
    }

    function scan(root) {
      if (!root) return;
      if (root.nodeType === 1 && root.matches && root.matches(BLOCKS + ", " + INPUTS)) {
        mark(root);
      }
      if (!root.querySelectorAll) return;

      var nodes = root.querySelectorAll(BLOCKS + ", " + INPUTS);
      for (var i = 0; i < nodes.length; i++) mark(nodes[i]);
    }

    var scheduled = false;
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      var run = function () {
        scheduled = false;
        if (document.body) scan(document.body);
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

      var observer = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var added = records[i].addedNodes;
          for (var k = 0; k < added.length; k++) {
            if (added[k].nodeType === 1) {
              schedule();
              break;
            }
          }
        }
      });
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
      });

      return function cleanup() {
        observer.disconnect();
        var style = document.getElementById(STYLE_ID);
        if (insertedStyle && style && style.parentNode) style.parentNode.removeChild(style);
        var marked = document.querySelectorAll("[" + MARKER + "]");
        for (var i = 0; i < marked.length; i++) {
          marked[i].removeAttribute("dir");
          marked[i].removeAttribute(MARKER);
        }
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
