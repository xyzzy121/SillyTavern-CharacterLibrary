import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../modules/providers/datacat/', import.meta.url);
const contractText = await readFile(new URL('datacat-contract.js', root), 'utf8');
const contractUrl = `data:text/javascript;base64,${Buffer.from(contractText).toString('base64')}`;
const contract = await import(contractUrl);
const id = '11111111-2222-3333-4444-555555555555';
const otherId = '11111111-2222-3333-4444-666666666666';
const rawExport = definition => ({ spec: 'chara_card_v2', data: {
    name: 'Test character', description: definition, first_mes: 'Hello',
    alternate_greetings: ['Another greeting'], extensions: { custom: { retained: true } },
} });

async function acquisition(overrides = {}) {
    const calls = [];
    const mocks = {
        fetchDatacatCharacter: async () => { calls.push('detail'); return { character_id: id, name: 'Listing', primary_content_source_kind: 'janitor' }; },
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
    const prefix = `import {DatacatError,getDatacatCharacterId,getDatacatSourceKind,normalizeDatacatSourceKind,normalizeDefinitionSource} from '${contractUrl}';\nconst {${Object.keys(mocks).join(',')}} = globalThis.${key};\n`;
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
