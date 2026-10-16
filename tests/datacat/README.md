# Datacat compatibility validation

Run the focused tests from the repository root:

```sh
node --test tests/datacat/*.test.mjs
```

These use Node's built-in test runner, with no build system or package installation. The implementation was validated with Node 26.2.0. External APIs, browser verification, and SillyTavern writes are mocked in the automated tests; no credentials are required.

Coverage includes current helper routes and visibility fields, explicit export parameters, source and UUID normalization, source-qualified links, native media, nested pagination metadata, clamped and duplicate pages, retrieval correlation and terminal failures, structured errors, authoritative exports, definition persistence, cancellation, and the companion message/PNG contract. Browser and provider tests exercise the actual source modules with their external dependencies replaced.

## 7.3.5 reliability fixes — 2026-10-16

The whole-extension suite passes **388 tests**; all **76 non-vendor production JavaScript files** pass syntax checks. DataCat requires helper **1.13.2**, the optional Janitor bridge is **1.3.2**, and the separate export companion remains **1.0.2**.

Regression coverage now includes:

- In-place replacement of an explicitly selected duplicate, frozen export selection, mandatory verified original-PNG/card/index snapshots, stale/pending-edit checks, same-merge DataCat cleanup, exact readback, and reconciliation of lost acknowledgements without retry. Existing avatar identity, name, artwork, chats, favorites, settings, unrelated namespaces, linked World Info, playlists, and name preferences are preserved.
- Lorebook replacement removes obsolete object keys in the main merge. A root empty `null` book or owned null namespace can be prepared only after its verified backup, with strict readback. Unsafe nested null-to-object conversions stop before mutation with a repair message. A failed main write after empty-null preparation can leave that empty marker absent; populated data and protected state remain intact and the snapshot preserves the exact original PNG.
- Mandatory snapshots share `maxAutoBackups` retention and deduplication, including repeated failed first replacements before a UID reaches the card. Zero retains the existing unlimited setting.
- Bounded Following pages, fair continuation, request budgets, source-qualified identities, cache-only local sorts/filters/scrolling, incomplete/error states and targeted retries, cache age, refresh/unfollow/navigation cancellation, and scroll/focus preservation.
- Consumer-aware bootstrap/features/Meili/Saucepan token sharing, session epochs, transport/body/queue deadlines, actual helper disconnect propagation, at least one second between upstream starts, three active slots through body consumption, shared cooldowns, numeric/date Retry-After, correlated hard-deadline polling, and no automatic submission retries.
- Canvas fallback without OffscreenCanvas/createImageBitmap, failed encoding cleanup, modal focus/inert ownership, visible-opener restoration, trusted mobile input focus, Escape/Back dismissal, and 44-pixel DataCat touch targets.

Final-source real-server replacement checks passed **12 desktop Chromium scenarios** and **four mobile WebKit lorebook edge scenarios**, with zero uncaught page errors. The earlier eight replacement workflows also passed in mobile WebKit. Failures are injected at network/storage boundaries; snapshots and persistence themselves use real local files.

The final browser matrix passed **27/27 checks**, with **zero uncaught page errors**: desktop Chromium at 1440×1000; mobile Chromium at 320×568, 390×844 and 844×390; and Windows WebKit at 390×844 and 844×390. Twelve missing/valid-artwork imports persisted and survived reloads across those six profiles with OffscreenCanvas forced unavailable. Mobile tag/export keyboard boundaries, Escape/Back/manual close, visible focus restoration, and 44-pixel targets passed. Serial iframe exports used the actual bundled companion with a synthetic native export service; the harness waits for the new iframe document and uses touch input on mobile. Earlier mouse/readiness harness failures remain in separate artifacts and were not fixed by changing production behavior.

For a 10,000-card creator, initial Following uses **two requests**, rather than the reproduced 200-page drain, and displays the first 50 cards while its second response is pending. Excluded results stop at **12 requests per explicit action**; scrolling and local sorts/filters do not admit another batch. The realistic 107,884-tag/six-group fixture initially mounts **286 rows**. Tag timing records have three repetitions per query; Chromium mobile uses four-times CPU throttling. Those timings are observations, not a matched before/after benchmark.

The final source-hash audit matched all **115 production files** against the independent runtime and matched the installed test helper to the bundled helper. An independent static review found no unresolved actionable issues. Generated reports, screenshots, runtime data and logs remain outside this repository.

All external DataCat responses in this implementation's browser validation are fixtures. No live extraction jobs, verified exports, or service load tests are submitted. Chromium mobile emulation and Windows WebKit do not establish physical Android/iOS behavior. The extension can abort browser requests to SillyTavern's generic proxy, but upstream cancellation inside that core proxy is outside its control; the DataCat/Saucepan helper routes and updated Janitor bridge do propagate it.

## 7.3.4 second audit — 2026-09-28

Added **31 regressions**: **164 Datacat tests** and **296 tests across the extension** pass. All 73 non-vendor JavaScript files pass syntax checks, and the diff passes whitespace checks. Helper remains **1.13.1**; companion is **1.0.2**.

Confirmed fixes cover:

- Malformed lorebook content remains unavailable for destructive comparisons; merged books receive unique entry IDs; cancelled hydration stops immediately.
- Full metadata is fetched instead of inferred from partial feed fields. Reimagination availability belongs to the selected variant. Nonprimary Source exports cannot inherit the primary definition's book, and Source stubs cannot suppress Reimagination book comparison.
- Relinking a different UUID resets the previous target's source, definition, variant, creator, listing name, avatar and timestamp. Same-target and unrelated metadata remain preserved.
- Detail responses require the requested UUID, list rows require a UUID, and Fresh responses require their requested windows. Invalid rows still count toward server pagination offsets.
- Retrieval failures override stale success/lifecycle flags. Idle or unrecognized history requires explicit completion evidence, and records for another character cannot complete a request.
- Search survives Recent/Meili/Hampter changes, Clear resets all queries, NSFW changes restart server-filtered results, and text search exits a creator catalog. Following refresh/unfollow/deactivation invalidates old requests.
- Cancelled avatar scans cannot affect newer scans. Avatar restore validates the reviewed image digest immediately before writing and isolates late upload UI updates. The companion rejects oversized native buffers before allocating a duplicate.

The production API and helper handlers passed another live read-only probe: anonymous session initialization, recent pagination, Fresh windows, source-qualified detail, verification denial, and retrieval status. No session tokens were persisted or retrieval jobs submitted.

Desktop/mobile browser fixtures passed the full application imports and definition previews, with real sort/search/clear/NSFW controls producing the expected Meili/Hampter requests. Companion fixtures passed both definitions, serial reuse, cancellation, Reload, Escape/Back and oversized-buffer rejection on localhost and an insecure HTTP LAN-style origin. There were no browser JavaScript exceptions. Local fixture servers and browsers stopped after testing; no temporary SillyTavern clone was needed for this pass.

These tests do **not** verify successful human challenges, authenticated live exports, physical mobile userscript installation, or the remote effects of retrieval. API/card-builder composition tests cover variant-specific and malformed lorebook preservation; browser upstream responses use controlled fixtures.

## 7.3.3 focused audit — 2026-09-28

The audit checked the published Datacat frontend, current native export module, and official SillyTavern bridge. The companion's explicit `buildPngPayload(..., { definitionSource })` call remains current; the official bridge still omits the choice. This release bundles helper **1.13.1**, requires it for Datacat, and leaves the companion at **1.0.1**.

New regressions cover current route aliases; slow creator/search responses; stale Saucepan creator caches; overlapping and failed Meili/Hampter pagination; retrieval submission aliases and terminal outcomes; idle status placeholders; malformed helper responses; cancellation during requests; strict missing-card classification; confirmed-session-only retries; unavailable or mismatched exported definitions/variants; metadata identity; selected artwork; and rejection of numeric file-link IDs.

| Check | Result |
| --- | --- |
| Node tests | 133 Datacat tests passed; the whole extension suite passed 265 tests. |
| Live recent, next page, Fresh windows, tags, features, detail, creator profile and catalog | Passed with an ephemeral anonymous session. A separate integration probe ran the production API module through the production helper route handlers, including automatic session initialization. No tokens were saved. |
| Live native owner profile and bots endpoint | Passed with an empty sampled catalog; this does not verify a native-card import. |
| Live missing UUID, authentication, download denial, status projection and legacy status | Passed. Missing details return `not_found`; gated downloads remain `verification_required` even for a nonexistent UUID. No retrieval jobs were submitted. |
| Current native export call and definition parameters | Confirmed against the published frontend. A bounded Fresh sample had no Reimagination records, so a successful live comparison of both definitions remains unverified. |
| Full application at desktop 1280×900 and mobile 390×844 | Passed with local API fixtures and production HTML/modules: all nine providers initialized, both definition previews, actual import controls, V2 PNG upload, selection/link preservation, and preview cancellation before replacement. Desktop scenarios also covered overlapping creator lookups, cancelled retrieval submissions without polling, and a late URL lookup superseded by a search. No page errors. |
| Browser companion at desktop/mobile sizes and insecure HTTP LAN-style origin | Passed: trusted export clicks, both definitions, PNG delivery, serial reuse, Reload, parent/iframe Escape, mobile Back, native cancellation and creator restrictions. Simulated Datacat responses; no page errors. |

Human verification, authenticated exports, physical mobile userscript installation, and the remote effects of retrieval/public-feed visibility remain unverified. Browser fixtures exercise production UI and import code but do not establish that a live challenge can be completed. The 7.3.2 disposable-SillyTavern integration record remains in [the full validation report](../README.md).

## 7.3.1 regression pass — 2026-09-23

The follow-up bug test added regression coverage for current nested Reimagination variants, native artwork aliases, abandoned retrieval jobs, pagination resets, encoded Saucepan creator catalogs, cancellation before replacement, late preview results, source-qualified and legacy URL linking, definition preservation after metadata failures, and partial lorebooks. Companion coverage now includes HTTP LAN nonce generation, stale replies after Reload, repeated readiness diagnostics, native verification cancellation, creator restrictions, and canonical V2 card validation.

The complete Node suite passes **99 tests**. Syntax checks pass for all **73 non-vendor JavaScript files**, and `git diff --check` passes.

| Browser regression scenario | Result |
| --- | --- |
| Full application at desktop 1280×900 and mobile 390×844 | Passed using unmodified production HTML/modules and a local HTTP server with API fixtures. All nine providers initialized. The actual Online grid, secure-iframe Source/Reimagination preview, desktop Import and mobile quick-import controls, PNG generation, import POST, preview close, and library refresh ran successfully. The fixture server parsed the uploaded V2 PNG and confirmed the selected definition, variant, greetings, UUID, creator, and link timestamp. No JavaScript page errors occurred. |
| Companion on localhost and an insecure HTTP LAN-style origin | Passed with a simulated cross-origin Datacat frame, including the environment where `crypto.randomUUID` is unavailable. Trusted export clicks, Source/Reimagination, serial panel reuse, Reload, parent/iframe Escape, mobile Back, verification cancellation, and creator restrictions passed without JavaScript page errors. |
| Browse and preview cancellation at desktop and mobile sizes | Passed with simulated upstream responses. Closing or replacing a preview cancels its pending import before replacement; late completion does not close or repaint a newer preview. |

These browser runs used external API fixtures and did not write to a live SillyTavern or Datacat service. They supplement the live-test record below; they do not verify human challenges or physical mobile userscript installation.

## Smoke-test record — 2026-09-23

| Scenario | Result |
| --- | --- |
| Live anonymous session, recent feed, Fresh feed, character detail, feature flags, retrieval status | Passed against Datacat using the changed API module. The ephemeral token remained in memory. |
| Live direct export denial | Passed: the current HTTP 403 `CHARACTER_DOWNLOAD_TURNSTILE_REQUIRED` response remains `verification_required`. No preview-derived substitute was imported. |
| Desktop and mobile preview | Passed in Chromium with simulated upstream responses: Source/Reimagination content and selection, unavailable choices, import readiness after verification denial, and cancellation before duplicate replacement. The mobile harness used a 390px viewport and viewport metadata. |
| Desktop and mobile companion panel | Passed in Chromium with a simulated cross-origin Datacat frame: trusted export click, explicit native definition option, PNG transfer/decoding, request isolation, serial reuse, cancellation, and overlay cleanup. The actual app Escape handler and mobile Back/history handler were exercised: parent Escape and Back close the panel; iframe Escape cancels the current character. |
| Recent/Fresh/creator filters and pagination, native owner catalogs | Automated fixtures passed, including missing totals, nested paging, clamped pages, duplicate rows, sort parameters, and native owner route selection. Full live catalog interaction remains unverified. |
| Legacy linked-card updates and selected definitions | Automated provider/update fixtures passed. Applying an update to a running SillyTavern instance remains unverified. |
| Separate Hampter and Meili browsing | Automated routing/pagination regression checks passed. Live authentication and imports through those services remain unverified. |
| Other providers | Shared update/import behavior is covered by regression checks; full live smoke tests of other providers were not performed. |
| Live verified PNG import, live Source/Reimagination comparison | Blocked: the live browser probe received a Cloudflare page challenge with `X-Frame-Options: SAMEORIGIN`, which prevented embedding. No human challenge was solved. The panel provides an Open Datacat link and Reload guidance. |
| Live retrieval execution and visibility effects | Not performed: no retrieval jobs were submitted during validation. Endpoint, payload, queue/status, cancellation, and timeout handling were checked with fixtures. |
| Physical mobile browser and userscript manager installation | Not performed. Chromium mobile emulation does not verify every mobile browser or userscript manager. |

The repository update does not install the extension or helper into a running SillyTavern instance. For deployment, update cl-helper to 1.13.1 and restart SillyTavern if using an older helper. Install or update the optional Datacat Export Companion to 1.0.2 for exports that require browser verification. Setup and troubleshooting instructions are in the root README.
