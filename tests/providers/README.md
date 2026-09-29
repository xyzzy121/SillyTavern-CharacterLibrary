# Provider and linked-update regressions

Run with Node's built-in test runner, without installing a frontend build system:

```sh
node --test tests/providers/*.test.mjs tests/datacat/*.test.mjs
```

The provider suite added on 2026-09-28 contains 54 tests. Together with the existing 99 Datacat tests, all 153 passed. These tests execute production functions/classes with transport, DOM and persistence boundaries replaced by controlled fixtures. They do not claim to verify a provider's live authenticated service.

Coverage:

- All nine providers: link creation, public URL generation/parsing, hostname matching, unlinking, and preservation of other extension namespaces.
- Chub, CharacterTavern, Pygmalion, JannyAI, Wyvern, Botbooru, Saucepan and JanitorAI: update failures and cancellation are propagated instead of marking a card removed. Datacat's corresponding cases remain in its dedicated suite.
- Chub, Wyvern, Botbooru and Saucepan: real API parsing/classification with HTTP 401/403/429/500/503, genuine 404, disabled SillyTavern proxy, HTML challenge pages, malformed success responses and compatibility for best-effort callers.
- Character conversions: authored definitions, greetings, lorebooks, extension data, provider-specific field mapping, and Wyvern lorebook numeric zeros. Botbooru removes foreign provider link namespaces while keeping unrelated extension fields.
- Incomplete data: CharacterTavern's detail fallback cannot delete unread greetings/lorebooks; inaccessible Chub linked lorebooks remain unknown; missing Botbooru enrichment cannot overwrite local creator/tagline; Pygmalion metadata without a definition cannot produce an empty comparison card.
- Update application: failed listing-name writes remain failures, failed and unselected batch comparisons remain available, and late results from a closed scan cannot change a new scan.
- Link persistence: hydrate before staging, explicit surgical namespace writes, failed link/unlink rollback, and captured targets when a user switches cards during metadata lookup or hydration.

Live login, provider-side writes, human browser verification and all remote gallery/version-history paths require separate integration testing. No remote account credentials or provider-side writes are used by this suite.
