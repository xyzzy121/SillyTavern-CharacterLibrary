# CharacterLibrary regression validation

## Running the automated suite

From the repository root, using Node's built-in test runner:

```sh
node --test tests/**/*.test.mjs
```

The suite requires no frontend build system, npm installation, credentials, or running SillyTavern server. It executes production functions and modules with controlled network, DOM, and persistence boundaries. Tests cover failure cases as well as successful operations.

Final 7.3.3 result: **265 tests passed**, including **133 Datacat tests** and **132 tests for other extension behavior**. The focused Datacat audit added 34 regressions to the 7.3.2 suite. Current live-service and browser results are in the [Datacat validation record](datacat/README.md). All **73 non-vendor JavaScript files** and the optional integration harness passed syntax checks; `git diff --check` passed.

## 7.3.2 integration record — 2026-09-28

Testing used a fresh clone of the official SillyTavern `release` branch: **1.19.0**, commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`, Node **26.2.0**, and Chromium. The temporary instance listened only on localhost, loaded this repository's production extension and bundled cl-helper **1.13.0**, and contained synthetic cards, chats, worlds, images, and settings. Existing SillyTavern installations were not modified.

Desktop runs used 1440×1000 or 1280×900 viewports. Mobile runs used Chromium emulation at 390×844; these do not substitute for physical-device or userscript-manager testing. The successful runs produced no uncaught JavaScript page errors. Expected missing optional cache files, deliberately rejected external requests, and injected HTTP failures were recorded separately.

| Area | Validation and result |
| --- | --- |
| Library startup | Real application HTML, module loader, all nine providers, lazy modules, and gallery extractors loaded successfully. |
| Local cards | Real V2 JSON fixture imports, Local PNG import through the UI, search, ascending/descending sorting, favorite persistence, edit lock, diff confirmation, edits, reload, and confirmed deletion passed. Unknown extensions, alternate greetings, and embedded lore survived ordinary edits. |
| Save races | A delayed real snapshot upload allowed closing one card and opening another before save completion. Only the original card was changed. Unit regressions also cover hydration, later edits, structured-field Cancel baselines, and failed avatar uploads retaining the selected image for retry. |
| Mobile library | Search overlay, detail editing/save, and browser Back passed. |
| Launcher and settings | The actual installed launcher opened a new tab with a live opener and CSRF token. A settings change persisted through ST's live context to disk and was restored. Embedded mode, full viewport, and Back to Chat passed. Standalone settings used their localStorage fallback. |
| Character Creator | Desktop Create Character, PNG import, opening the created card, Import from Library, Save As, and mobile create/open passed. Failed Save As retry is covered by regression fixtures. |
| Lorebooks | Real create, entry/keyword edit, save, duplicate, rename, JSON export, V2 embedded-book import, delete, and mobile navigation passed. Fixtures cover failed pre-rename save, concurrent edits, switched books, and out-of-order loads. |
| Tags | Real multi-select batch tagging persisted to cards. Regression fixtures cover prototype-named tags such as `constructor` and `__proto__`. |
| Playlists | Real creation, membership, reload, an injected upload failure, and recovery passed. Fixtures cover corrupt/failed reads, mutation failures, queued writes, and preserving confirmed state. |
| Versions | Manual snapshot persistence, Restore, and Undo passed against actual cards. Fixtures cover storage failures, concurrent snapshots, and switching cards during restore. |
| Chats | Real chat lorebook binding retained metadata and messages. Fixtures reject concurrent changes to any message/header and chats becoming active before a write. |
| Gallery and helper | Image upload, gallery viewing, and cl-helper JPEG thumbnail generation passed. Fixtures cover stale gallery responses and background queue startup/persistence failures. |
| Bundles | Real ZIP export and import as copy restored the card, chat, and gallery image. Fixtures reject incorrect ZIP entry sizes/CRCs. |
| Provider links and updates | Real manual Chub URL linking, selective field update, service-error display, and unlinking passed using fixture responses only at the external provider boundary; ST persistence was real. All nine providers have URL/link contracts, and update failure/conversion tests cover provider-specific behavior. See [provider coverage](providers/README.md). |
| Datacat | Existing tests remained passing. Full-app Source/Reimagination preview/import and the companion panel were rerun on desktop/mobile with upstream fixtures, including an insecure HTTP origin, Reload, cancellation, Escape, and mobile Back. See [Datacat coverage and live limits](datacat/README.md). |
| Custom CSS | A disabled snippet persisted through the real Files API. An injected upload failure retained the prior state and showed an error. Fixtures cover serialized changes, edits during save, failed/corrupt initial reads, blocked writes, and retry. |
| AI features | Offline tests cover the shared request/response client: supported formats, profiles/proxies, authentication, custom endpoint query strings, fallback, rate limits, truncation, cancellation, and Unicode. No paid model calls were made. |

Features requiring external accounts were not represented as live successes. Authenticated provider browsing/downloads, human verification, remote gallery and version-history services, every image-host extractor, and actual LLM generation still require account-specific smoke tests. Tags Manager rename/merge/undo, every advanced filter/preset combination, large-library performance, and physical mobile behavior were not exhaustively tested. This record describes the tested workflows, not a claim that every possible input or configuration is verified.

The temporary SillyTavern server, checkout, dependency cache, and synthetic server data were removed after testing. Test reports and screenshots are kept separately from the deleted instance.

## Optional real-server smoke harness

`integration/core-smoke.cjs` runs the core import/search/sort/edit/favorite/reload checks against a real server. It intentionally creates synthetic cards and snapshots: use a disposable instance with the extension installed, then delete that instance after testing.

The harness requires an existing Playwright installation and Chromium, independently of the Node unit suite. Set:

- `CL_TEST_BASE_URL`: the disposable server origin, for example `http://127.0.0.1:18888`.
- `CL_PLAYWRIGHT_MODULE`: optional path to an existing Playwright module; otherwise normal `require('playwright')` resolution is used.
- `CL_BROWSER_PATH`: optional Chromium executable path; otherwise Playwright's configured Chromium is used.
- `CL_TEST_OUTPUT`: optional directory for the JSON report and screenshots; defaults to a temporary directory.

Then run:

```sh
node tests/integration/core-smoke.cjs
```
