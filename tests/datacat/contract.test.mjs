import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../modules/providers/datacat/datacat-contract.js', import.meta.url), 'utf8');
const c = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const id = '11111111-2222-3333-4444-555555555555';

test('source and UUID identity normalize without promoting numeric database ids', () => {
    for (const alias of ['direct', 'private_vault', 'privatevault', 'vault', 'upload']) assert.equal(c.normalizeDatacatSourceKind(alias), 'direct_upload');
    assert.equal(c.getDatacatSourceKind({ stats: { direct_upload: true } }), 'direct_upload');
    assert.equal(c.getDatacatSourceKind({ stats: JSON.stringify({ direct_upload: true }) }), 'direct_upload');
    assert.equal(c.getDatacatSourceKind({ primary_content_source_kind: 'janitor', stats: JSON.stringify({ direct_upload: true }) }), 'direct_upload');
    assert.equal(c.getDatacatSourceKind({ sourceKind: 'future-source' }, null), null);
    assert.equal(c.getDatacatSourceKind({ intercepted_chat_data: JSON.stringify({ direct_upload: {} }) }), 'direct_upload');
    assert.equal(c.getDatacatSourceKind({ interceptedChatData: JSON.stringify({ direct_upload: {} }) }), 'direct_upload');
    assert.equal(c.getDatacatSourceKind({ chara_card_v2_json: JSON.stringify({ data: { extensions: { datacat: { source: 'direct_upload' } } } }) }), 'direct_upload');
    assert.equal(c.getDatacatSourceKind({ primary_content_source_kind: 'janitor_core' }), 'janitor');
    assert.equal(c.getDatacatCharacterId({ id: 471, characterId: id }), id);
    assert.equal(c.getDatacatCharacterId({ id: 471 }), '');
    assert.equal(c.getDatacatCharacterId({ chara_card_v2_json: JSON.stringify({ data: { extensions: { datacat: { id } } } }) }), id);
    assert.equal(c.getDatacatCharacterId({ charaCardV2Json: JSON.stringify({ data: { extensions: { datacat: { id } } } }) }), id);
});

test('source-aware deep links round trip and reject other origins', () => {
    for (const sourceKind of ['janitor', 'saucepan', 'direct_upload']) assert.deepEqual(c.parseDatacatUrl(c.buildDatacatUrl(id, sourceKind)), { id, sourceKind });
    assert.deepEqual(c.parseDatacatUrl(`https://datacat.run/characters/${id}`), { id, sourceKind: null });
    assert.equal(c.parseDatacatUrl(`https://evil.example/characters/${id}`), null);
});

test('collection route modes do not override explicit sources or invent native identity', () => {
    for (const path of [`/vault/${id}`, `/characters/vault/${id}`, `/characters/mine/${id}`]) {
        assert.deepEqual(c.parseDatacatUrl(`https://datacat.run${path}`), { id, sourceKind: null });
    }
    for (const path of [`/vault/janitor/${id}`, `/characters/vault/janitor/${id}`]) {
        assert.deepEqual(c.parseDatacatUrl(`https://datacat.run${path}`), { id, sourceKind: 'janitor' });
    }
    assert.deepEqual(c.parseDatacatUrl(`https://datacat.run/characters/recent/direct/${id}_a-character-name`), { id, sourceKind: 'direct_upload' });
    assert.deepEqual(c.parseDatacatUrl(`https://datacat.run/characters/vault/janitor/${id}?sourceKind=saucepan`), { id, sourceKind: 'saucepan' });
});

test('native avatars resolve DataCat media URLs and preserve Janitor filename convention', () => {
    assert.equal(c.normalizeDatacatCharacter({ characterId: id, sourceKind: 'direct', avatarDisplayUrl: '/api/media/one' }).avatar, 'https://datacat.run/api/media/one');
    assert.equal(c.normalizeDatacatCharacter({ characterId: id, avatar: 'image.webp' }).avatar, 'https://ella.janitorai.com/bot-avatars/image.webp');
    assert.equal(c.normalizeDatacatCharacter({ characterId: id, stats: { direct_upload: true }, media_assets: [{ role: 'avatar', mediaViewUrl: '/assets/one.webp' }] }).avatar, 'https://datacat.run/assets/one.webp');
    assert.equal(c.normalizeDatacatAvatar('javascript:alert(1)'), null);
});

test('pagination uses server metadata and returned length even without totals', () => {
    const page = c.normalizeDatacatPage({ list: [{ characterId: id }], hasMore: true }, { offset: 80, limit: 80, listKey: 'list' });
    assert.equal(page.nextOffset, 81);
    assert.equal(page.hasMore, true);
    assert.equal(page.total, null);
    assert.equal(c.normalizeDatacatPage({ characters: [], hasMore: true }).hasMore, false);
    assert.throws(() => c.normalizeDatacatPage({ ok: true }), /invalid character list/);
});

test('fresh paging envelopes preserve explicit end and cursor metadata', () => {
    for (const key of ['paging', 'pagination']) {
        const page = c.normalizeDatacatPage({ characters: [{ characterId: id }], [key]: { hasMore: false, nextOffset: 91, total: 100 } }, { offset: 80 });
        assert.equal(page.nextOffset, 91);
        assert.equal(page.hasMore, false);
        assert.equal(page.total, 100);
    }
});

test('verification, restrictions, and outages remain distinct from missing content', () => {
    assert.equal(c.classifyDatacatError(403, { error: 'CHARACTER_DOWNLOAD_TURNSTILE_REQUIRED' }).code, 'verification_required');
    const restricted = c.classifyDatacatError(403, { error: 'CREATOR_REDIRECT_REQUIRED', redirectUrl: 'https://datacat.run/creator' });
    assert.equal(restricted.code, 'creator_restricted');
    assert.equal(restricted.redirectUrl, 'https://datacat.run/creator');
    assert.equal(c.classifyDatacatError(403, {}).code, 'forbidden');
    assert.equal(c.classifyDatacatError(429, {}).code, 'rate_limited');
    assert.equal(c.classifyDatacatError(429, { error: 'CHARACTER_DOWNLOAD_TURNSTILE_RATE_LIMITED' }).code, 'rate_limited');
    assert.equal(c.classifyDatacatError(503, { error: 'TURNSTILE_UNAVAILABLE' }).code, 'service_unavailable');
    assert.equal(c.classifyDatacatError(404, {}).code, 'not_found');
});

test('retrieval correlation rejects stale history and matches current terminal jobs', () => {
    const now = Date.now();
    const old = { characterId: id, status: 'complete', completedAt: new Date(now - 5000).toISOString() };
    assert.equal(c.matchRetrievalStatus({ history: [old] }, { characterId: id, submittedAt: now }), null);
    assert.equal(c.matchRetrievalStatus({ history: [{ ...old, requestId: 'old' }] }, { requestId: 'new', characterId: id, submittedAt: now - 6000 }), null);
    const payload = { latestTerminalJob: { requestId: 'new', characterId: id, status: 'failed', error: 'No source data' } };
    assert.equal(c.matchRetrievalStatus(payload, { requestId: 'new', characterId: id, submittedAt: now }).success, false);
    assert.equal(c.isRetrievalShortcut({ alreadyExists: true }), true);
    assert.equal(c.isRetrievalShortcut({ skippedExtraction: true, collected: true, characterId: id }), true);
    assert.equal(c.matchRetrievalStatus({ taskHistory: [{ id: 'request-task', characterId: id, lifecycle: 'terminal', status: 'finished' }] }, { requestId: 'request-task' }).requestId, 'request-task');
    assert.equal(c.matchRetrievalStatus({ job: { requestId: 'job1', lifecycle: 'terminal', status: 'done', terminalStatus: 'failed', errorMessage: 'Source unavailable', targetType: 'character', targetId: id } }, { requestId: 'job1' }).success, false);
});

test('retrieval timeouts are failures and active history never completes a request', () => {
    for (const status of ['timeout', 'timed_out', 'timed-out', 'timedout', 'expired']) {
        const result = c.matchRetrievalStatus({ job: { requestId: 'new', status, characterId: id } }, { requestId: 'new' });
        assert.equal(result?.success, false);
    }
    for (const status of ['queued', 'running', 'pending', 'processing', 'in_progress']) {
        assert.equal(c.matchRetrievalStatus({ history: [{ requestId: 'new', status, characterId: id }] }, { requestId: 'new' }), null);
    }
    assert.equal(c.matchRetrievalStatus({ taskHistory: [{ requestId: 'new', lifecycle: 'running', status: 'working', characterId: id }] }, { requestId: 'new' }), null);
});

test('page state advances through clamped results and stops nonadvancing cursors', () => {
    assert.deepEqual(c.getDatacatPageState({}, 80, 24), { nextOffset: 104, hasMore: true });
    assert.deepEqual(c.getDatacatPageState({ nextOffset: 80, hasMore: true }, 80, 24), { nextOffset: 104, hasMore: false });
    assert.deepEqual(c.getDatacatPageState({ nextOffset: 104, hasMore: true }, 80, 24), { nextOffset: 104, hasMore: true });
    assert.deepEqual(c.getDatacatPageState({}, 80, 0), { nextOffset: 80, hasMore: false });
});

test('definition choice defaults to Source and recognizes published reimagination flags', () => {
    assert.equal(c.normalizeDefinitionSource(undefined), 'source');
    assert.equal(c.normalizeDefinitionSource('reimagination'), 'reimagination');
    assert.equal(c.getDatacatDefinitionOptions({ hasDatacatReimagination: true }).reimagination, true);
    assert.equal(c.getDatacatDefinitionOptions({}).source, true);
    assert.equal(c.getDatacatDefinitionOptions({ sourceDefinitionAvailable: false }).source, false);
    assert.equal(c.getDatacatDefinitionOptions({ sourceKind: 'direct_upload', hasDatacatReimagination: true }).reimagination, false);
});

test('Reimagination attached to an ordinary source variant remains selectable', () => {
    const character = { content_variants: [
        { id: 'janitor_core', sourceKind: 'janitor_core', sourceLabel: 'Original', content: { datacat_reimagination: { output_text: 'Reimagined definition' } } },
        { id: 'jannyai', sourceKind: 'jannyai', sourceLabel: 'Recovery', hasDatacatReimagination: true },
        { id: 'unavailable', sourceKind: 'janitor_core', isRecoveryPlaceholder: true, hasDatacatReimagination: true },
    ] };
    const options = c.getDatacatDefinitionOptions(character);
    assert.equal(options.reimagination, true);
    assert.deepEqual(options.variants.map(variant => [variant.id, variant.name]), [['janitor_core', 'Original'], ['jannyai', 'Recovery']]);
    assert.equal(c.getDatacatDefinitionOptions({ recoveryBadgeText: 'REIMAGINED' }).reimagination, true);
    assert.equal(c.getDatacatDefinitionOptions({ datacatReimagination: { interpretation: 'Definition' } }).reimagination, true);
});

test('native artwork resolves current nested media assets before stale source artwork', () => {
    const artwork = { role: 'avatar', media_view_url: '/media/direct_upload/image.webp', original_url: '/media/direct_upload/original.png' };
    for (const fields of [
        { directUploadMediaAssets: [artwork] },
        { direct_upload_media_assets: [artwork] },
        { intercepted_chat_data: JSON.stringify({ direct_upload: { mediaAssets: [artwork] } }) },
        { interceptedChatData: { directUpload: { media_assets: [artwork] } } },
    ]) {
        const normalized = c.normalizeDatacatCharacter({ characterId: id, sourceKind: 'direct_upload', avatar: 'old-janitor.webp', ...fields });
        assert.equal(normalized.avatar, 'https://datacat.run/media/direct_upload/image.webp');
        assert.equal(normalized.media_assets[0].original_url, artwork.original_url);
    }
    assert.equal(c.normalizeDatacatCharacter({ characterId: id, imageDisplayUrl: '/media/card.webp' }).avatar, 'https://datacat.run/media/card.webp');
});

test('abandoned retrievals are failures even when the terminal job omits an error', () => {
    const result = c.matchRetrievalStatus({ latestTerminalJob: { requestId: 'abandoned-request', lifecycle: 'terminal', terminalStatus: 'abandoned' } }, { requestId: 'abandoned-request' });
    assert.equal(result.success, false);
    assert.equal(c.matchRetrievalStatus({ history: [{ requestId: 'abandoned-request', status: 'abandoned' }] }, { requestId: 'abandoned-request' }).success, false);
});
