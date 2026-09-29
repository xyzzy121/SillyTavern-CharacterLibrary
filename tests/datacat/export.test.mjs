import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../modules/providers/datacat/', import.meta.url);
const contractText = await readFile(new URL('datacat-contract.js', root), 'utf8');
const contractUrl = `data:text/javascript;base64,${Buffer.from(contractText).toString('base64')}`;
const contract = await import(contractUrl);
// Compose the acquisition path with the production card/lorebook builders. Only
// the external modules and request boundary are stubbed, as in api.test.mjs.
let apiSource = await readFile(new URL('datacat-api.js', root), 'utf8');
apiSource = apiSource.replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export \* from .*;\r?\n/gm, '');
const apiNames = ['DatacatError', 'classifyDatacatError', 'normalizeDatacatCharacter', 'normalizeDatacatPage', 'normalizeDatacatSourceKind', 'getDatacatSourceKind', 'getDatacatCharacterId', 'normalizeDatacatAvatar', 'normalizeDefinitionSource', 'normalizeRetrievalStatus'];
const apiPrefix = `import {${apiNames.join(',')}} from '${contractUrl}';
const CoreAPI = { isUrlSafeForDownload: () => ({ok:true}) };
const CL_HELPER_PLUGIN_BASE = '/plugins/cl-helper';
const slugify = x => x, stripHtml = x => x, JANNY_TAG_MAP = {};
const readJsonClassified = r => r.json(), classifyErrorPage = () => null;
const meiliMultiSearch = () => {}, isJanitorBridgeAvailable = () => false, janitorBridgeFetch = () => {};
`;
const productionApi = await import(`data:text/javascript;base64,${Buffer.from(apiPrefix + apiSource).toString('base64')}`);
const id = '11111111-2222-3333-4444-555555555555';
const otherId = '11111111-2222-3333-4444-666666666666';
const rawExport = definition => ({ spec: 'chara_card_v2', data: {
    name: 'Test character', description: definition, first_mes: 'Hello',
    alternate_greetings: ['Another greeting'], extensions: { custom: { retained: true } },
} });

async function acquisition(overrides = {}) {
    const calls = [];
    const mocks = {
        fetchDatacatCharacter: async () => { calls.push('detail'); return { character_id: id, name: 'Listing', primary_content_source_kind: 'janitor', content_variants: [{ id: 'janitor_core', content: { datacat_reimagination: { outputText: 'Reimagined definition' } } }] }; },
        fetchDatacatDownload: async (_id, _source, options) => { calls.push(['download', options]); return rawExport(options.definitionSource); },
        buildV2FromDownload: download => { calls.push('build'); return structuredClone(download); },
        hydrateDatacatScripts: async () => { calls.push('scripts'); }, hasUnfetchedLorebook: () => false,
        requestDatacatBrowserExport: async options => { calls.push(['browser', options]); return { card: rawExport(options.definitionSource), imageBuffer: new ArrayBuffer(8), definitionSource: options.definitionSource }; },
        ...overrides,
    };
    const key = `__datacatExportTest_${crypto.randomUUID().replaceAll('-', '')}`;
    globalThis[key] = mocks;
    let source = await readFile(new URL('datacat-export.js', root), 'utf8');
    source = source.replace(/^import[\s\S]*?;\r?\n/gm, '');
    const prefix = `import {DatacatError,getDatacatCharacterId,getDatacatSourceKind,normalizeDatacatSourceKind,normalizeDefinitionSource,getDatacatDefinitionOptions} from '${contractUrl}';\nconst {${Object.keys(mocks).join(',')}} = globalThis.${key};\n`;
    const module = await import(`data:text/javascript;base64,${Buffer.from(prefix + source).toString('base64')}`);
    delete globalThis[key];
    return { acquire: module.acquireDatacatExport, calls };
}

test('source is explicit by default and complete metadata precedes export', async () => {
    const { acquire, calls } = await acquisition();
    const result = await acquire(id, { character: { character_id: id, name: 'Listing only' } });
    assert.equal(calls[0], 'detail');
    assert.equal(calls[1][0], 'download');
    assert.equal(calls[1][1].definitionSource, 'source');
    assert.equal(result.card.data.description, 'source');
    assert.deepEqual(result.card.data.alternate_greetings, ['Another greeting']);
    assert.equal(result.card.data.extensions.custom.retained, true);
    assert.equal(result.card.data.extensions.datacat.id, id);
});

test('the chosen definition and variant survive browser verification', async () => {
    const denied = new contract.DatacatError('Verify', { code: 'verification_required', status: 403 });
    const { acquire, calls } = await acquisition({ fetchDatacatDownload: async () => { throw denied; } });
    const result = await acquire(id, { interactive: true, definitionSource: 'reimagination', variantId: 'janitor_core' });
    const request = calls.find(call => Array.isArray(call) && call[0] === 'browser')[1];
    assert.equal(request.definitionSource, 'reimagination');
    assert.equal(request.variantId, 'janitor_core');
    assert.equal(result.card.data.description, 'reimagination');
    assert.equal(result.card.data.extensions.datacat.definitionSource, 'reimagination');
    assert.equal(result.card.data.extensions.datacat.variantId, 'janitor_core');
    assert.equal(calls.includes('scripts'), false);
});

test('batch checks never launch a browser or build fallback content after verification denial', async () => {
    const { acquire, calls } = await acquisition({ fetchDatacatDownload: async () => { throw new contract.DatacatError('Verify', { code: 'verification_required' }); } });
    await assert.rejects(acquire(id), { code: 'verification_required' });
    assert.deepEqual(calls, ['detail']);
});

test('creator restrictions and outages are not replaced with metadata cards', async () => {
    for (const code of ['creator_restricted', 'forbidden', 'service_unavailable', 'not_found']) {
        const { acquire, calls } = await acquisition({ fetchDatacatDownload: async () => { throw new contract.DatacatError(code, { code }); } });
        await assert.rejects(acquire(id, { interactive: true }), { code });
        assert.deepEqual(calls, ['detail']);
    }
});

test('metadata failure preserves a valid export and known UUID', async () => {
    const { acquire } = await acquisition({ fetchDatacatCharacter: async () => { throw new Error('metadata outage'); } });
    const result = await acquire(id, { sourceKind: 'direct_upload' });
    assert.equal(result.card.data.extensions.datacat.id, id);
    assert.equal(result.card.data.extensions.datacat.sourceKind, 'direct_upload');
    assert.equal(result.card._lorebookUnavailable, true);
});

test('an explicit empty lorebook remains authoritative even during a metadata outage', async () => {
    const { acquire, calls } = await acquisition({
        fetchDatacatCharacter: async () => { throw new Error('metadata outage'); },
        fetchDatacatDownload: async () => {
            const card = rawExport('Source');
            card.data.character_book = null;
            return card;
        },
    });
    const result = await acquire(id);
    assert.equal(result.card.data.character_book, null);
    assert.equal(result.card._lorebookUnavailable, undefined);
    assert.equal(calls.includes('scripts'), false);
});

test('partly hydrated lorebooks cannot propose removal of the unavailable entries', async () => {
    const { acquire } = await acquisition({
        hasUnfetchedLorebook: () => true,
        buildV2FromDownload: download => ({ ...structuredClone(download), data: {
            ...download.data, character_book: { entries: [{ content: 'Available entry' }] },
        } }),
    });
    const result = await acquire(id);
    assert.equal(result.card.data.character_book.entries.length, 1);
    assert.equal(result.card._lorebookUnavailable, true);
});

test('an export for another character is refused before normalization', async () => {
    const { acquire, calls } = await acquisition({ fetchDatacatDownload: async () => ({ ...rawExport('Source'), data: { name: 'Wrong', extensions: { datacat: { id: otherId } } } }) });
    await assert.rejects(acquire(id), { code: 'invalid_response' });
    assert.equal(calls.includes('build'), false);
});

test('cancelling while a verified export is pending cannot produce an importable result', async () => {
    const controller = new AbortController();
    const { acquire, calls } = await acquisition({
        fetchDatacatDownload: async () => { throw new contract.DatacatError('Verify', { code: 'verification_required' }); },
        requestDatacatBrowserExport: async () => { controller.abort(); return { card: rawExport('Source'), definitionSource: 'source' }; },
    });
    await assert.rejects(acquire(id, { interactive: true, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls.includes('build'), false);
});

test('a browser export with a different selected definition is refused', async () => {
    const { acquire } = await acquisition({
        fetchDatacatDownload: async () => { throw new contract.DatacatError('Verify', { code: 'verification_required' }); },
        requestDatacatBrowserExport: async () => ({ card: rawExport('Wrong'), definitionSource: 'reimagination' }),
    });
    await assert.rejects(acquire(id, { interactive: true }), { code: 'invalid_response' });
});

test('an unavailable selected definition cannot be silently exported as Source', async () => {
    for (const [definitionSource, character] of [
        ['reimagination', { character_id: id, content_variants: [], primary_content_source_kind: 'janitor' }],
        ['source', { character_id: id, has_source_definition: false }],
    ]) {
        const { acquire, calls } = await acquisition({ fetchDatacatCharacter: async () => character });
        await assert.rejects(acquire(id, { definitionSource }), { code: 'selection_unavailable' });
        assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'download'), false);
    }
});

test('a missing saved variant cannot silently use the current default variant', async () => {
    const character = { character_id: id, content_variants: [{ id: 'current', content: { datacat_reimagination: { outputText: 'New version' } } }] };
    const { acquire, calls } = await acquisition({ fetchDatacatCharacter: async () => character });
    await assert.rejects(acquire(id, { definitionSource: 'reimagination', variantId: 'removed' }), { code: 'selection_unavailable' });
    assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'download'), false);
});

test('top-level Reimagination can be exported for its existing source variant', async () => {
    const character = { character_id: id, datacat_reimagination: { outputText: 'Reimagined definition' }, content_variants: [{ id: 'janitor_core', content: { personality: 'Source definition' } }] };
    const { acquire } = await acquisition({ fetchDatacatCharacter: async () => character });
    const result = await acquire(id, { definitionSource: 'reimagination', variantId: 'janitor_core' });
    assert.equal(result.card.data.extensions.datacat.variantId, 'janitor_core');
    assert.equal(result.card.data.extensions.datacat.definitionSource, 'reimagination');
});

test('stale full metadata from another character is rejected before it can enrich an export', async () => {
    const { acquire, calls } = await acquisition();
    await assert.rejects(acquire(id, { character: { _fullCharacter: { character_id: otherId, personality: 'Wrong card', creator_name: 'Wrong creator' } } }), { code: 'invalid_response' });
    assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'download'), false);
});

test('metadata for a different source cannot be attached to an explicitly selected source', async () => {
    const { acquire, calls } = await acquisition({ fetchDatacatCharacter: async () => ({ character_id: id, primary_content_source_kind: 'saucepan' }) });
    await assert.rejects(acquire(id, { sourceKind: 'janitor' }), { code: 'invalid_response' });
    assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'download'), false);
});

test('explicit direct-export definition and variant mismatches cannot be relabelled as the requested selection', async () => {
    for (const [requested, returned] of [
        [{ definitionSource: 'source' }, { definitionSource: 'reimagination' }],
        [{ definitionSource: 'reimagination' }, { definitionSource: 'source' }],
        [{ definitionSource: 'reimagination', variantId: 'janitor_core' }, { definitionSource: 'reimagination', variantId: 'different-version' }],
        [{ definitionSource: 'reimagination', variantId: 'janitor_core' }, { definitionSource: 'reimagination', variantId: '' }],
    ]) {
        const { acquire, calls } = await acquisition({ fetchDatacatDownload: async () => {
            const card = rawExport('Different selected content');
            card.data.extensions.datacat = { id, ...returned };
            return card;
        } });
        await assert.rejects(acquire(id, requested), { code: 'invalid_response' });
        assert.equal(calls.includes('build'), false);
        assert.equal(calls.includes('scripts'), false);
    }
});

test('legacy exports without selection fields retain explicit requested choice and original-origin metadata', async () => {
    const { acquire } = await acquisition({ fetchDatacatDownload: async () => {
        const card = rawExport('Legacy selected content');
        card.data.extensions.datacat = { id, source: 'saucepan' };
        return card;
    } });
    const result = await acquire(id, { sourceKind: 'janitor', definitionSource: 'reimagination', variantId: 'janitor_core' });
    assert.equal(result.card.data.extensions.datacat.definitionSource, 'reimagination');
    assert.equal(result.card.data.extensions.datacat.variantId, 'janitor_core');
    assert.equal(result.card.data.extensions.datacat.sourceKind, 'janitor');
    assert.equal(result.card.data.extensions.datacat.source, 'saucepan');
});

test('verified PNG selection is bound by the companion even when uploaded-card selection metadata is stale', async () => {
    const { acquire } = await acquisition({
        fetchDatacatDownload: async () => { throw new contract.DatacatError('Verify', { code: 'verification_required' }); },
        requestDatacatBrowserExport: async () => {
            const card = rawExport('Verified selected content');
            card.data.extensions.datacat = { id, definitionSource: 'source', variantId: 'old-uploaded-version' };
            return { card, definitionSource: 'reimagination', imageBuffer: new ArrayBuffer(8) };
        },
    });
    const result = await acquire(id, { interactive: true, definitionSource: 'reimagination', variantId: 'janitor_core' });
    assert.equal(result.card.data.extensions.datacat.definitionSource, 'reimagination');
    assert.equal(result.card.data.extensions.datacat.variantId, 'janitor_core');
});

test('summary fields cannot masquerade as full detail and hide an available definition', async () => {
    const { acquire, calls } = await acquisition();
    const result = await acquire(id, {
        character: { character_id: id, personality: '', scripts: [], content_variants: [] },
        definitionSource: 'reimagination',
    });
    assert.equal(calls[0], 'detail');
    assert.equal(result.card.data.description, 'reimagination');
});

test('a saved variant cannot borrow Reimagination availability from another variant', async () => {
    const { acquire, calls } = await acquisition({ fetchDatacatCharacter: async () => ({
        character_id: id,
        content_variants: [
            { id: 'janitor_core', isPrimary: true, content: { personality: 'Source only' } },
            { id: 'janny_recovery', content: { datacat_reimagination: { outputText: 'Another version' } } },
        ],
    }) });
    await assert.rejects(acquire(id, { definitionSource: 'reimagination', variantId: 'janitor_core' }), { code: 'selection_unavailable' });
    assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'download'), false);
});

test('Source variant enrichment uses only that variant lorebook metadata', async () => {
    const primary = [{ type: 'lorebook', is_public: true, script: '[{"content":"Primary"}]' }];
    const selected = [{ type: 'lorebook', is_public: true, script: '[{"content":"Selected"}]' }];
    const seen = [];
    for (const variantScripts of [selected, undefined]) {
        const { acquire } = await acquisition({
            fetchDatacatCharacter: async () => ({
                character_id: id, scripts: primary,
                content_variants: [
                    { id: 'primary', isPrimary: true, content: {} },
                    { id: 'selected', content: JSON.stringify(variantScripts ? { scripts: variantScripts } : {}) },
                ],
            }),
            hydrateDatacatScripts: async character => { seen.push(['hydrate', character.scripts]); },
            buildV2FromDownload: (download, character) => {
                seen.push(['build', character.scripts]);
                return structuredClone(download);
            },
        });
        const result = await acquire(id, { variantId: 'selected' });
        assert.deepEqual(seen.at(-1), ['build', variantScripts]);
        assert.equal(result.card._lorebookUnavailable, variantScripts ? undefined : true);
    }
    assert.equal(seen.some(([, scripts]) => scripts === primary), false);
});

test('Reimagination export lorebook absence is not obscured by unrelated Source script stubs', async () => {
    const { acquire, calls } = await acquisition({ hasUnfetchedLorebook: () => true });
    const result = await acquire(id, { definitionSource: 'reimagination' });
    assert.equal(result.card._lorebookUnavailable, undefined);
    assert.equal(calls.includes('scripts'), false);
});

test('unknown selected-variant metadata cannot borrow the primary lorebook', async () => {
    let enrichedScripts;
    const { acquire } = await acquisition({
        fetchDatacatCharacter: async () => ({ character_id: id, scripts: [{ type: 'lorebook', is_public: true, script: '[{"content":"Primary"}]' }] }),
        buildV2FromDownload: (download, character) => { enrichedScripts = character.scripts; return structuredClone(download); },
    });
    const result = await acquire(id, { variantId: 'saved-version' });
    assert.equal(enrichedScripts, undefined);
    assert.equal(result.card._lorebookUnavailable, true);
});

test('an explicit selected variant export book stays authoritative even when variant metadata is missing', async () => {
    for (const character_book of [null, { entries: [{ content: 'Selected export book' }] }]) {
        const { acquire, calls } = await acquisition({
            fetchDatacatCharacter: async () => ({ character_id: id, scripts: [{ type: 'lorebook', is_public: true }] }),
            fetchDatacatDownload: async () => ({ ...rawExport('Source'), data: { ...rawExport('Source').data, character_book } }),
        });
        const result = await acquire(id, { variantId: 'saved-version' });
        assert.deepEqual(result.card.data.character_book, character_book);
        assert.equal(result.card._lorebookUnavailable, undefined);
        assert.equal(calls.includes('scripts'), false);
    }
});

test('production acquisition and lorebook builders never compare malformed or partial books as removals', async () => {
    const validScript = { type: 'lorebook', is_public: true, script: '[{"id":0,"content":"Known entry"}]' };
    for (const scripts of [
        [{ type: 'lorebook', is_public: true, script: '{broken' }],
        [validScript, { type: 'lorebook', is_public: true, script: '[null]' }],
    ]) {
        const { acquire } = await acquisition({
            fetchDatacatCharacter: async () => ({ character_id: id, scripts }),
            buildV2FromDownload: productionApi.buildV2FromDownload,
            hydrateDatacatScripts: productionApi.hydrateDatacatScripts,
            hasUnfetchedLorebook: productionApi.hasUnfetchedLorebook,
        });
        const result = await acquire(id);
        assert.equal(result.card._lorebookUnavailable, true);
        assert.equal(result.card.data.character_book?.entries?.length || 0, scripts.length - 1);
    }
});

test('production acquisition composes selected Source and Reimagination books without mixing definitions', async () => {
    const sourceScript = content => [{ type: 'lorebook', is_public: true, script: JSON.stringify([{ id: 0, content }]) }];
    const character = {
        character_id: id, scripts: sourceScript('Primary source book'),
        content_variants: [
            { id: 'primary', isPrimary: true, content: {} },
            { id: 'selected', content: { scripts: sourceScript('Selected source book'), datacat_reimagination: { outputText: 'Reimagined body' } } },
        ],
    };
    for (const definitionSource of ['source', 'reimagination']) {
        const { acquire } = await acquisition({
            fetchDatacatCharacter: async () => character,
            buildV2FromDownload: productionApi.buildV2FromDownload,
            hydrateDatacatScripts: productionApi.hydrateDatacatScripts,
            hasUnfetchedLorebook: productionApi.hasUnfetchedLorebook,
            fetchDatacatDownload: async () => {
                const card = rawExport(definitionSource);
                if (definitionSource === 'reimagination') card.data.character_book = { entries: [{ content: 'Reimagined book' }] };
                return card;
            },
        });
        const result = await acquire(id, { definitionSource, variantId: 'selected' });
        assert.equal(result.card.data.description, definitionSource);
        assert.deepEqual(result.card.data.character_book.entries.map(entry => entry.content), [definitionSource === 'source' ? 'Selected source book' : 'Reimagined book']);
        assert.equal(result.card._lorebookUnavailable, undefined);
    }
});
