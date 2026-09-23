import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../modules/providers/datacat/', import.meta.url);
const contractSource = await readFile(new URL('datacat-contract.js', root), 'utf8');
const contractUrl = `data:text/javascript;base64,${Buffer.from(contractSource).toString('base64')}`;
const id = '11111111-2222-3333-4444-555555555555';
const exportCard = (sourceKind = 'janitor', definitionSource = 'source') => ({
    card: { spec: 'chara_card_v2', data: { name: 'Character', description: definitionSource, extensions: { datacat: { id, sourceKind, definitionSource }, custom: { keep: true } } } },
    imageBuffer: new ArrayBuffer(8), definitionSource, sourceKind, variantId: '',
    character: { name: 'Listing', character_id: id },
});

async function loadProvider(overrides = {}) {
    const calls = [];
    const api = { apiRequest() {}, getSetting: () => null };
    const mocks = {
        CoreAPI: api, datacatBrowseView: {}, initJanitorBridge() {}, setApiRequest() {}, setSavedTokenGetter() {},
        acquireDatacatExport: async (_id, options) => { calls.push(['acquire', _id, options]); return exportCard(options.sourceKind || 'janitor', options.definitionSource || 'source'); },
        closeDatacatExportPanel() { calls.push(['close']); },
        checkDcPluginAvailable: async () => true, validateDcSession: async () => ({ valid: true }),
        submitExtraction: async () => { calls.push(['retrieve']); return { success: true, collected: true, characterId: id }; },
        fetchDatacatCharacter: async () => ({ characterId: id, primary_content_source_kind: 'direct_upload' }),
        assignGalleryId() {}, resolveDatacatAvatarUrl: () => null, slugify: name => name,
        importFromPng: async options => { calls.push(['import', options]); return { success: true }; },
        ...overrides,
    };
    const key = `__datacatProviderTest_${crypto.randomUUID().replaceAll('-', '')}`;
    globalThis[key] = mocks;
    const code = await readFile(new URL('datacat-provider.js', root), 'utf8');
    const body = code.slice(code.indexOf('let api = null;'), code.indexOf('const datacatProvider ='));
    const prefix = `import {getDatacatCharacterId,getDatacatSourceKind,normalizeDatacatSourceKind,normalizeDefinitionSource,parseDatacatUrl,buildDatacatUrl,matchRetrievalStatus,isRetrievalShortcut} from '${contractUrl}';\nclass ProviderBase { init(){} getListingName(row) { return row?.name || ''; } }\nconst {${Object.keys(mocks).join(',')}} = globalThis.${key};\n`;
    const module = await import(`data:text/javascript;base64,${Buffer.from(prefix + body + '\nexport { DatacatProvider };').toString('base64')}`);
    delete globalThis[key];
    const provider = new module.DatacatProvider();
    await provider.init(api);
    return { provider, calls };
}

test('old links default to Source and retain canonical UUID/source metadata', async () => {
    const { provider } = await loadProvider();
    const char = { data: { extensions: { datacat: { id, sourceKind: 'janitor_core' } } } };
    const link = provider.getLinkInfo(char);
    assert.equal(link.id, id);
    assert.equal(link.sourceKind, 'janitor');
    assert.equal(link.definitionSource, 'source');
    assert.equal(provider.getLinkInfo({ data: { extensions: { datacat: { id: 412 } } } }), null);
});

test('relinking preserves creator metadata, definition and unrelated namespaces', async () => {
    const { provider } = await loadProvider();
    const char = { data: { extensions: { other: 42, datacat: { id, creatorName: 'Creator', linkedAt: 'yesterday', definitionSource: 'reimagination', variantId: 'variant1', custom: true } } } };
    provider.setLinkInfo(char, { id, sourceKind: 'direct' });
    assert.equal(char.data.extensions.other, 42);
    assert.equal(char.data.extensions.datacat.creatorName, 'Creator');
    assert.equal(char.data.extensions.datacat.definitionSource, 'reimagination');
    assert.equal(char.data.extensions.datacat.variantId, 'variant1');
    assert.equal(char.data.extensions.datacat.custom, true);
    assert.equal(char.data.extensions.datacat.linkedAt, 'yesterday');
});

test('single updates opt into interaction while default batch behavior remains noninteractive', async () => {
    const { provider, calls } = await loadProvider();
    const link = { id, sourceKind: 'janitor', definitionSource: 'reimagination', variantId: 'core' };
    await provider.fetchRemoteCard(link);
    await provider.fetchRemoteCard(link, { interactive: true });
    assert.equal(calls[0][2].interactive, false);
    assert.equal(calls[1][2].interactive, true);
    assert.equal(calls[1][2].definitionSource, 'reimagination');
    assert.equal(calls[1][2].variantId, 'core');
});

test('only an actual missing export is classified as removed', async () => {
    for (const code of ['verification_required', 'creator_restricted', 'service_unavailable']) {
        const { provider } = await loadProvider({ acquireDatacatExport: async () => { throw Object.assign(new Error(code), { code }); } });
        await assert.rejects(provider.fetchRemoteCard({ id }), { code });
    }
    const { provider } = await loadProvider({ acquireDatacatExport: async () => { throw Object.assign(new Error('missing'), { code: 'not_found', status: 404 }); } });
    assert.equal(await provider.fetchRemoteCard({ id }), null);
});

test('native URL import preserves its source hint and reuses a validated selected export', async () => {
    const { provider, calls } = await loadProvider();
    const exported = exportCard('direct_upload');
    const result = await provider.importCharacter(id, null, { sourceUrl: `https://datacat.run/characters/recent/direct/${id}`, acquiredExport: exported });
    assert.equal(result.success, true);
    assert.equal(calls.some(call => call[0] === 'acquire'), false);
    const imported = calls.find(call => call[0] === 'import')[1].characterCard;
    assert.equal(imported.data.extensions.datacat.sourceKind, 'direct_upload');
    assert.equal(imported.data.extensions.datacat.definitionSource, 'source');
    assert.equal(exported.card.data.extensions.datacat.linkedAt, undefined);
});

test('a cached export with the wrong definition is reacquired before upload', async () => {
    const { provider, calls } = await loadProvider();
    const result = await provider.importCharacter(id, null, { acquiredExport: exportCard(), definitionSource: 'reimagination' });
    assert.equal(result.success, true);
    assert.equal(calls[0][0], 'acquire');
    assert.equal(calls.find(call => call[0] === 'import')[1].characterCard.data.description, 'reimagination');
});

test('cancelled imports cannot upload the cached export', async () => {
    const { provider, calls } = await loadProvider();
    const controller = new AbortController();
    controller.abort();
    const result = await provider.importCharacter(id, null, { acquiredExport: exportCard(), signal: controller.signal });
    assert.equal(result.success, false);
    assert.equal(result.cancelled, true);
    assert.equal(calls.some(call => call[0] === 'import'), false);
});

test('closing the browser panel propagates the batch-stop marker without uploading', async () => {
    const { provider, calls } = await loadProvider({ acquireDatacatExport: async () => {
        throw Object.assign(new DOMException('Panel closed', 'AbortError'), { panelClosed: true });
    } });
    const result = await provider.importCharacter(id);
    assert.equal(result.cancelled, true);
    assert.equal(result.panelClosed, true);
    assert.equal(calls.some(call => call[0] === 'import'), false);
});

test('cancelling during session validation prevents a retrieval submission', async () => {
    const controller = new AbortController();
    const { provider, calls } = await loadProvider({
        CoreAPI: { getSetting: name => name === 'datacatReextractOnUpdate' },
        validateDcSession: async () => { controller.abort(); return { valid: true }; },
    });
    const statuses = [];
    await provider.refreshRemoteData({ id, sourceKind: 'janitor' }, { signal: controller.signal, onStatus: text => statuses.push(text) });
    assert.equal(calls.some(call => call[0] === 'retrieve'), false);
    assert.equal(statuses.some(text => text.includes('Submitting')), false);
});

test('preview metadata failure retains the linked source, definition and variant', async () => {
    const { provider } = await loadProvider({ fetchDatacatCharacter: async () => { throw new Error('temporary outage'); } });
    const link = { id, sourceKind: 'saucepan', definitionSource: 'reimagination', variantId: 'saucepan_core' };
    const preview = await provider.buildPreviewObject({ name: 'Local card', data: { extensions: { datacat: link } } }, link);
    assert.equal(preview.id, id);
    assert.equal(preview.primary_content_source_kind, 'saucepan');
    assert.equal(preview.definitionSource, 'reimagination');
    assert.equal(preview.variantId, 'saucepan_core');
});

test('manual URL metadata lookup forwards the source hint', async () => {
    const requests = [];
    const { provider } = await loadProvider({ fetchDatacatCharacter: async (...args) => {
        requests.push(args);
        return { character_id: id, sourceKind: 'direct_upload', name: 'Native card' };
    } });
    await provider.fetchMetadata(id, { sourceUrl: `https://datacat.run/characters/recent/direct/${id}` });
    assert.equal(requests[0][0], id);
    assert.equal(requests[0][1], 'direct_upload');
});

test('manual URL linking retains a known UUID and source when metadata is missing', async () => {
    const { provider } = await loadProvider();
    const char = { data: { extensions: { custom: { retained: true } } } };
    provider.setLinkInfo(char, { id: null, fullPath: id, sourceUrl: `https://datacat.run/characters/recent/direct/${id}` });
    assert.equal(provider.getLinkInfo(char)?.id, id);
    assert.equal(provider.getLinkInfo(char)?.sourceKind, 'direct_upload');
    assert.deepEqual(char.data.extensions.custom, { retained: true });
});

test('invalid replacement links cannot erase a valid link', async () => {
    const { provider } = await loadProvider();
    const char = { data: { extensions: { datacat: { id, definitionSource: 'reimagination' } } } };
    assert.throws(() => provider.setLinkInfo(char, { id: 456, fullPath: 'not-a-uuid' }), /valid.*ID/i);
    assert.equal(provider.getLinkInfo(char)?.id, id);
    assert.equal(provider.getLinkInfo(char)?.definitionSource, 'reimagination');
});
