# AGENTS.md

Instructions for any AI agent (or human maintainer) working on **dsh-rtl-bidi-plugin**.

This repository is a **DeepSeek Harness (DSH) client plugin**, not a standalone web app. It fixes mixed Arabic/English text direction in the DSH Web UI. Read this file before changing code. It documents the hard contracts, how the project was built, how to verify changes in a live DSH instance, the mistakes that already happened, and a backlog of ideas.

---

## 1. TL;DR

| Item | Value |
|---|---|
| Manifest | `package.json` → `dsh.bundle.patch` + `dsh.client` |
| Loader row | `cordis.patch.yml` → `- insert: [{ id: rtl-bidi, name: rtl-bidi-plugin }]` |
| Host half | `lib/index.js` — no-op `export function apply() {}` |
| Client half | `lib/client.js` — `window.__ModuleLoader__.load({ id, factory })` |
| Browser module id | **must equal** the package `name` (`rtl-bidi-plugin`) |
| Runtime extension point | `shell.overlay` slot (frame-wide), `id: rtl-bidi`, component renders `null` |
| Effect | inject `<style id="dsh-rtl-bidi-css">`, set `dir="auto"` on text blocks, observe DOM |
| Dependencies | none (React comes from the platform module table) |
| Build step | none for this package (browser file is authored in ModuleLoader format) |
| License | MIT |

If you change only one thing, keep this invariant: **the Loader row must be inserted, and the client module id must equal the package name.**

---

## 2. What the project does

The DSH Web UI is LTR by default. A paragraph mixing Arabic and English therefore uses an LTR paragraph base direction, which scrambles word order and punctuation around the language boundary. The plugin gives each text block its own base direction:

- Arabic-first block → RTL, right-aligned;
- English-first block → LTR, left-aligned;
- code, terminal output, KaTeX math → forced LTR and isolated (correct even inside Arabic prose);
- composer (textarea/contenteditable) → direction follows the first strong character while typing.

It works for any Mixed-direction script, not only Arabic/English, because it relies on the Unicode Bidirectional Algorithm (UBA) paragraph rules P2/P3.

**It is presentation-only.** No session data, no request content, no model behavior, no `app.asar` changes.

---

## 3. Repository layout

```
.
├── package.json          # name, version, dsh.bundle.patch, dsh.client, files, exports
├── cordis.patch.yml      # Loader patch layer: insert the rtl-bidi row
├── lib/
│   ├── index.js          # Host half (no-op apply)
│   └── client.js         # Browser half: styles + dir=auto + MutationObserver + slot entry
├── locale/en.json        # Plugin Manager title/description (meta.title, meta.description)
├── icon.svg              # Plugin icon (original artwork, MIT)
├── README.md             # User-facing docs (Arabic + English overview)
├── AGENTS.md             # This file
└── LICENSE               # MIT
```

There is no build tool, no `node_modules`, no bundler. The browser artifact is hand-authored in the format `@deepseek-ai/dsh-client-modules` serves.

---

## 4. Hard contracts (do not break)

1. **Patch dialect**: `cordis.patch.yml` in a bundle is a *patch layer*. New rows must be appended through `insert:`:
   ```yaml
   - insert:
       - id: rtl-bidi
         name: 'rtl-bidi-plugin'
   ```
   A bare row (`- id: ...`) is an **override** targeting an existing row. If no such row exists it is warned about and **silently skipped** — the plugin then never mounts and nothing changes. This exact mistake shipped in an earlier version; see §6.
2. **Browser module id**: in `lib/client.js`, `window.__ModuleLoader__.load({ id: ... })` must equal the resolved manifest package `name`. DSH identifies the browser module by package name; a mismatch means the bundle loads but is never matched to its Loader entry.
3. **`dsh.client` declaration** in `package.json`:
   ```json
   "dsh": { "client": { "platform": "web", "immediately": true, "inject": [] } }
   ```
   `platform` must be `web`. `immediately: true` loads the module at startup rather than on demand.
4. **Client factory shape**: return an object `{ inject: ["slots"], apply(ctx) { ... } }` from the factory. Do not use `module.exports` inside the factory in a second style; match the template shape in §5.
5. **Own side effects through a slot, not module scope**: register a component in `shell.overlay` and run DOM work inside `React.useEffect`. Return the disposer so unmount removes the stylesheet, observer and injected attributes.
6. **Never set `dir` on layout containers**: setting RTL on a flex/grid wrapper flips row order (avatars, buttons, icon positions). Put `dir` only on text-bearing blocks (`p`, `li`, headings, table cells, …). For prose wrappers use `unicode-bidi: plaintext` (CSS) without the attribute.
7. **Code and math are always LTR isolated**: keep the `pre, code, kbd, samp, var, .katex, [class*="shiki"], [class*="codeBlock"]` rule with `direction: ltr !important; unicode-bidi: isolate !important`.
8. **No hand-editing the DSH profile**: install/update only through the `plugin_manager` tool (`install_bundle`, `remove_bundle`, `set_bundle`). Do not write `$DSH_HOME/profiles/*/package.json` or `cordis.patch.yml` directly, do not run pnpm in the profile directory, and never modify `app.asar`.
9. **Unique names**: package name, Loader row id (`rtl-bidi`) and slot occupant id (`rtl-bidi`) are unique in the profile. Do not reuse shipped ids (`shell.overlay` occupants like `context-menu`, `shortcuts`, …).
10. **Version triple**: bump `package.json.version`, `dsh.bundle.version` and the README badge together. The browser module id stays `rtl-bidi-plugin` regardless of version (never encode the version in the id).

---

## 5. The client contract (full shape)

Reference implementation of `lib/client.js` skeleton — keep the structure when extending:

```js
window.__ModuleLoader__.load({
  id: "rtl-bidi-plugin", // === package.json name
  factory(require) {
    const React = require("react"); // platform module table

    // 1. CSS: per-block bidi, code isolation, composer
    // 2. mark(el): setAttribute("dir","auto") unless el has dir or is inside EXCLUDE
    // 3. scan(root): querySelectorAll(BLOCKS + INPUTS) -> mark
    // 4. install(): insert <style>, scan(body), start MutationObserver; return cleanup
    function BidiDirection() {
      React.useEffect(() => install(), []);
      return null;
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("shell.overlay", () =>
          ctx.slots.register(
            { name: "shell.overlay", id: "rtl-bidi", order: 100 },
            BidiDirection,
          ),
        );
      },
    };
  },
});
```

Data flow at runtime:

1. DSH boots the client and its Loader entries.
2. `@deepseek-ai/dsh-client-modules` scans enabled entries, resolves this package's `./client` export, and serves the bundle under `/plugins`.
3. The browser materializes the module: `__ModuleLoader__.load` registers the factory.
4. The client runner applies the module: `apply(ctx)` runs and registers the overlay entry.
5. `BidiDirection` mounts, `useEffect` runs `install()`:
   - injects the stylesheet once (id `dsh-rtl-bidi-css`);
   - scans the document and tags text blocks with `dir="auto"` + `data-dsh-rtl-bidi="1"`;
   - starts a `MutationObserver` so React-rendered/streamed nodes are tagged as they appear.
6. On unmount: observer disconnected, stylesheet removed, injected attributes removed (only the marked ones).
7. Edits to `lib/client.js` are picked up by HMR after the Loader entry restarts (disable/enable the bundle) or after a DSH restart.

---

## 6. How this project was built (history and lessons)

This section exists so no agent repeats the dead ends.

### Attempt 1 — patching renderer CSS inside `app.asar`
A previous version tried to inject `unicode-bidi`/`direction` rules into the Electron renderer stylesheet inside the packed `app.asar`. It failed because:
- the edited file owned Electron *window chrome* (welcome/update screens), not the chat UI;
- the CSS value used was invalid (`direction: auto` is not a CSS value);
- repacking the archive risked breaking native modules that are deliberately stored outside it (`node-pty`, `koffi`, `sherpa-onnx`, `sharp`). Repacking was reverted and is **not** the supported approach.

### Attempt 2 — installing a client plugin with the wrong patch syntax
The plugin was authored with a bare row in `cordis.patch.yml`:
```yaml
- id: rtl-bidi
  name: rtl-bidi-plugin
```
The Loader treated it as an override of a non-existing row and skipped it. Nothing was served to the browser, so users saw no change even after restarting. Symptoms to recognize: `list_bundles` reports the bundle with `rows: []` and `overrides: ["rtl-bidi"]`; `Config.listConfigs { name: "rtl-bidi-plugin" }` returns zero entries.

### The working solution
- `insert:` patch row → Host row mounts.
- Client half registers an invisible `shell.overlay` component owning the effect.
- Verified live: Host entry `include:rtl-bidi` active, and the Client Slot tree shows occupant `rtl-bidi` (`active: true`) in `shell.overlay`.
- Installed through the official `plugin_manager` path (`remove_bundle` then `install_bundle` when replacing a manually installed copy), applied live via HMR.

### Lessons
- DSH patch layers only **append** through `insert:`; bare rows only override.
- The browser module id must equal the package name.
- Prefer the official install path; never hand-edit the profile.
- Verify through inspection (`Config`, `Slots`, bundle `rows`), not just through process state or logs.
- Do not patch `app.asar`; use the plugin system.

---

## 7. Build, validate, install, verify

There is **no build step**. Validation recipes:

### 7.1 Syntax and contract

```bash
node --check lib/client.js
node --check lib/index.js   # for ESM use --input-type=module --check or an .mjs copy
```

Contract check without a DOM (run from a scratch script; do not commit browser emulation):

```js
// pseudo-steps
// 1. create sandbox with window.__ModuleLoader__.load capturing the spec
// 2. vm.runInContext(file content)
// 3. assert spec.id === require("./package.json").name
// 4. const mod = spec.factory(() => ({}));   // React unused at factory time
// 5. assert typeof mod.apply === "function" && Array.isArray(mod.inject)
```

### 7.2 Install / update (inside a DSH agent session)

```text
plugin_manager({ action: "install_bundle", target: "<absolute path to this repo>" })
plugin_manager({ action: "set_bundle",  target: "rtl-bidi-plugin", enabled: false })
plugin_manager({ action: "set_bundle",  target: "rtl-bidi-plugin", enabled: true })
```

`install_bundle` refuses with `already-installed` if the package is present. To replace an installed copy: `remove_bundle` first, then `install_bundle`. Read the result fields: `application` must be `"applied"`, and `warnings` must be empty. `failed` or `restart-required` means the change is not live.

### 7.3 Verify live (required before claiming success)

1. **Host row exists**:
   ```text
   cordis_inspect_query(host, Config, listConfigs, { name: "rtl-bidi-plugin" })
   → include:rtl-bidi / rtl-bidi-plugin
   ```
2. **Bundle rows non-empty**:
   ```text
   plugin_manager list_bundles → entry "rtl-bidi-plugin"
   → rows: [{ rowId: "rtl-bidi", moduleName: "rtl-bidi-plugin" }], overrides: []
   ```
3. **Client half executed in the live page**:
   ```text
   cordis_inspect_query(client, Slots, listSubTree, { root: "shell.overlay" })
   → occupants contains { id: "rtl-bidi", active: true }
   ```
4. **Visual behavior** (ask the human, or observe directly when browser control exists): mixed Arabic/English paragraph renders in the correct order in chat and composer; code block stays LTR. Without browser control, state clearly that visual verification remains with the user.

> Do not claim visual success from installation alone. Installation + slot registration prove the mechanism is running; only the rendered page proves the result.

---

## 8. Debugging playbook

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| No visual change after restart | patch row not inserted | `list_bundles` → `rows: []` / `overrides: ["rtl-bidi"]` | rewrite `cordis.patch.yml` with `insert:`; reinstall |
| Row active, no occupant in `shell.overlay` | client bundle not served or module id mismatch | `Config.listConfigs { name }` shows row; client `Slots` has no `rtl-bidi`; check `id` in `lib/client.js` vs `package.json` name | fix id, fix `exports["./client"]`, restart/disable-enable |
| Occupant present but no effect | effect threw before styling, or selectors do not match | browser console (if available); inspect element styles; confirm `<style id="dsh-rtl-bidi-css">` exists | fix `install()`, re-enable |
| Arabic still left-aligned | element already has a `dir` attribute (mark() skips those), or tag not covered | inspect the element: does it have `dir`? which tag? | extend `BLOCKS`; strip conflicting host `dir` if appropriate |
| Code flipped RTL | code CSS rule lost or overridden | computed style of `pre`/`code` | restore the LTR-isolate rule |
| Old bundle still runs after edit | HMR kept the loaded generation | occupant still active but behavior old | `set_bundle` false → true, or restart DSH |
| Install fails `already-installed` | same version already installed | `list_bundles` | `remove_bundle` then `install_bundle` |
| Duplicate style/observer after hot reload | module-level side effects | count `<style id="dsh-rtl-bidi-css">` nodes | keep all side effects inside `useEffect`, make `install()` idempotent |

---

## 9. Modification guide

### Add a covered element type
1. Add the tag to `BLOCKS` in `lib/client.js`.
2. Add it to the first CSS rule as well.
3. Verify it does not live inside a layout wrapper where RTL would flip visuals.
4. Test Arabic-first and English-first content.

### Exclude an element
Add a selector to `EXCLUDE`. `mark()` uses `el.closest(EXCLUDE)` so descendants are skipped too.

### Change behavior (e.g., always RTL)
Do not hard-code `dir="rtl"` globally — that breaks English. If a real need appears (full RTL UI mode), implement it as an opt-in mode driven by a `Config` schema and applied on `document.documentElement` only when enabled.

### Add plugin configuration
Declare `export const Config` in `lib/index.js` (Host half) and pass the value to the client? Note: client halves cannot read Host config directly in this package. For UI-affecting options, prefer a small settings entry registered from the client (see the DSH settings patterns) or keep the behavior automatic. This is intentionally out of scope for v0.2.

### Localization
`locale/en.json` holds `meta.title` / `meta.description`. Add `locale/<lang>.json` with the same shape for other UI locales. Keep English sentence case.

### Versioning and releases
- Bump `package.json.version` + `dsh.bundle.version`.
- Keep the browser module id fixed (`rtl-bidi-plugin`).
- Update the README badge.
- Note behavior changes in the PR description.

---

## 10. Ideas backlog (not implemented — evaluate before building)

Ordered roughly from low to high effort/risk:

1. **More semantic tags**: `dl`, `dt`, `dd` (already `dd`/`dt` partly), `address`, `details/summary`, `figure/figcaption`, `<abbr>`.
2. **Table niceties**: right-align numeric cells in RTL tables (`td:has(...)` or a numeric heuristic), keep header alignment consistent.
3. **List polish**: bullet/marker placement for mixed lists; `list-style-position` tuning; ordered-list numbering direction.
4. **Composer enhancements**: placeholder direction, selection/scroll behavior when switching direction mid-typing, `dir` on the send button layout.
5. **Config and settings**: a settings row to enable/disable bidi handling for tool outputs, code isolation, or per-panel scopes; `Config` schema on the Host side with `volatile` fields where appropriate.
6. **Full RTL UI mode (opt-in)**: a documented mode that sets `document.documentElement.dir = "rtl"` and overrides theme tokens for line-height/spacing; must keep code LTR and must not break the sidebar. High risk: needs a broad visual audit.
7. **Third-party coverage**: a "wide mode" that also handles text-only `div` blocks heuristically (e.g., `div` with text child and no child elements) — measure false positives first.
8. **Tests**: a tiny contract test (`node --test`) that asserts module id === package name, factory shape, and CSS/selector invariants (no DOM emulation needed for these). A second test can validate the patch YAML shape (top-level `insert`).
9. **CI**: GitHub Action running `node --check`, JSON/YAML parse, and the contract test on push/PR.
10. **Locale packs**: Arabic description for Plugin Manager display where DSH supports the locale; keep `en` fallback.
11. **Performance**: throttle scans with `requestAnimationFrame`; skip subtrees under code blocks early; use a single observer root; measure long transcripts.
12. **Telemetry-free diagnostics**: expose an optional debug mode (via `localStorage` flag) that logs how many blocks were tagged, for field debugging without a devtools session.
13. **Accessibility**: ensure `dir` changes do not interfere with screen-reader language switching; consider `lang` attributes from Markdown where available.
14. **Upstream contribution**: if DSH adds a native bidi option, this plugin should degrade to a no-op or document migration.

---

## 11. Safety rules for agents

- Do not touch `app.asar`, `app.asar.unpacked`, or application binaries.
- Do not modify the DSH profile by hand; use `plugin_manager`.
- Do not add runtime dependencies, CDNs, or network calls.
- Keep the plugin presentation-only; never alter session content, model requests, or tools.
- Do not reuse shipped slot ids or package names; this plugin must not shadow built-in UI.
- Before deleting user files or changing profile state, verify the exact absolute path and obtain explicit permission.
- Report verification limits honestly: installation and slot registration are not a visual guarantee.

---

## 12. Reference

- DSH composition/loader dialect: `insert:` appends; bare rows override; `disabled`, `group`, `isolate`, `!!js` expressions.
- Client modules: a package's `dsh.client` declaration becomes a browser bundle served by the Host; the browser module id is the package name; factories are lazy.
- The frame-wide `shell.overlay` slot is additive: a fresh id adds a cell; reusing a shipped id replaces that cell.
- Plugin metadata: `locale/<lang>.json` `meta.title` / `meta.description` + an exported icon (`./icon`).

---

*Maintained by Hany Hassan. License: MIT. This file is written for AI agents: keep it accurate when you change the plugin; an outdated AGENTS.md is a bug.*
