// Paste this in the DevTools console (F12) of the DeepSeek Harness window while
// the composer shows the bug (Arabic line, then an English line). It prints one
// compact table and copies a summary to the clipboard. Nothing is modified.
(function bidiDiagnose() {
  var root = document.querySelector("[data-composer-input]");
  if (!root) return console.warn("No composer found. Click into the chat box first.");
  var cs = getComputedStyle(root);
  var rows = [
    "SURFACE  dir-attr=" + root.getAttribute("dir") +
      "  computed=" + cs.direction +
      "  unicode-bidi=" + cs.unicodeBidi +
      "  tag=" + root.tagName + "." + (root.className || "").slice(0, 40),
  ];
  var box = root.getBoundingClientRect();
  var lines = root.querySelectorAll("p, li, div, blockquote");
  for (var i = 0; i < lines.length && i < 12; i++) {
    var el = lines[i];
    var s = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    // Which side does the text actually hug? Compare the box edges.
    var edge = Math.abs(r.right - box.right) < 3 ? "RIGHT" : Math.abs(r.left - box.left) < 3 ? "LEFT" : "?";
    rows.push(
      "line" + (i + 1) +
        "  txt=" + JSON.stringify((el.textContent || "").slice(0, 24)) +
        "  dir-attr=" + el.getAttribute("dir") +
        "  computed=" + s.direction +
        "  ub=" + s.unicodeBidi +
        "  text-align=" + s.textAlign +
        "  hugs=" + edge,
    );
  }
  var sheets = [];
  for (var k = 0; k < document.styleSheets.length; k++) {
    var sheet = document.styleSheets[k];
    if (sheet.ownerNode && sheet.ownerNode.id) sheets.push(sheet.ownerNode.id);
  }
  rows.push("STYLE SHEETS: " + sheets.join(", "));
  rows.push("html dir=" + document.documentElement.getAttribute("dir") + "  plugin css present=" + (document.getElementById("dsh-rtl-bidi-css") !== null));
  var out = rows.join("\n");
  console.log(out);
  try { copy(out); console.log("(copied to clipboard)"); } catch (e) {}
  return out;
})();
