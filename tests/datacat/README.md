# Datacat compatibility validation

Run the focused tests from the repository root:

```sh
node --test tests/datacat/*.test.mjs
```

These use Node's built-in test runner, with no build system or package installation. The implementation was validated with Node 26.2.0. External APIs, browser verification, and SillyTavern writes are mocked in the automated tests; no credentials are required.

Coverage includes current helper routes and visibility fields, explicit export parameters, source and UUID normalization, source-qualified links, native media, nested pagination metadata, clamped and duplicate pages, retrieval correlation and terminal failures, structured errors, authoritative exports, definition persistence, cancellation, and the companion message/PNG contract. Browser and provider tests exercise the actual source modules with their external dependencies replaced.

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

The repository update does not install the extension or helper into a running SillyTavern instance. For deployment, update cl-helper to 1.13.0 and restart SillyTavern. Install or update the optional Datacat Export Companion to 1.0.1 for exports that require browser verification. Setup and troubleshooting instructions are in the root README.
