# Datacat compatibility validation

Run the focused tests from the repository root:

```sh
node --test tests/datacat/*.test.mjs
```

These use Node's built-in test runner, with no build system or package installation. The implementation was validated with Node 26.2.0. External APIs, browser verification, and SillyTavern writes are mocked in the automated tests; no credentials are required.

Coverage includes current helper routes and visibility fields, explicit export parameters, source and UUID normalization, source-qualified links, native media, nested pagination metadata, clamped and duplicate pages, retrieval correlation and terminal failures, structured errors, authoritative exports, definition persistence, cancellation, and the companion message/PNG contract. Browser and provider tests exercise the actual source modules with their external dependencies replaced.

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

The repository update does not install the extension or helper into a running SillyTavern instance. For deployment, update cl-helper to 1.13.1 and restart SillyTavern. Install or update the optional Datacat Export Companion to 1.0.1 for exports that require browser verification. Setup and troubleshooting instructions are in the root README.
