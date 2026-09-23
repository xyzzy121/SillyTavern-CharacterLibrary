import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../modules/providers/datacat/', import.meta.url);
const contract = await readFile(new URL('datacat-contract.js', root), 'utf8');
const contractUrl = `data:text/javascript;base64,${Buffer.from(contract).toString('base64')}`;
let source = await readFile(new URL('datacat-api.js', root), 'utf8');
source = source.replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export \* from .*;\r?\n/gm, '');
const names = ['DatacatError', 'classifyDatacatError', 'normalizeDatacatCharacter', 'normalizeDatacatPage', 'normalizeDatacatSourceKind', 'getDatacatSourceKind', 'getDatacatCharacterId', 'normalizeDatacatAvatar', 'normalizeDefinitionSource', 'normalizeRetrievalStatus'];
source = `import {${names.join(',')}} from '${contractUrl}';
const CoreAPI = { isUrlSafeForDownload: () => ({ok:true}) };
const CL_HELPER_PLUGIN_BASE = '/plugins/cl-helper';
const slugify = x => x, stripHtml = x => x, JANNY_TAG_MAP = {};
const readJsonClassified = r => r.json(), classifyErrorPage = () => null;
const meiliMultiSearch = () => {}, isJanitorBridgeAvailable = () => false, janitorBridgeFetch = () => {};
${source}`;
const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const id = '11111111-2222-3333-4444-555555555555';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('detail retries only actual missing endpoints and keeps source identity', async () => {
    const paths = [];
    api.setApiRequest(async path => { paths.push(path); return paths.length < 3 ? json({}, 404) : json({ character: { characterId: id, primary_content_source_kind: 'direct' } }); });
    assert.equal((await api.fetchDatacatCharacter(id, 'direct')).primary_content_source_kind, 'direct_upload');
    assert.equal(paths.length, 3);
    assert.match(paths[2], /recent-public\//);
});

test('gated download keeps classification and never bootstraps a new anonymous token', async () => {
    const paths = [];
    api.setApiRequest(async path => { paths.push(path); return json({ error: 'CHARACTER_DOWNLOAD_TURNSTILE_REQUIRED', message: 'Verify in DataCat' }, 403); });
    await assert.rejects(api.fetchDatacatDownload(id, 'direct', { definitionSource: 'reimagination', variantId: 'v1' }), error => error.code === 'verification_required' && error.message === 'Verify in DataCat');
    assert.equal(paths.length, 1);
    const url = new URL(paths[0], 'https://example.test');
    assert.equal(url.searchParams.get('downloadFormat'), 'json');
    assert.equal(url.searchParams.get('definitionSource'), 'reimagination');
    assert.equal(url.searchParams.get('variant'), 'v1');
});

test('structured policy and verification errors remain actionable even with HTTP404', async () => {
    for (const [upstream, code] of [['CREATOR_REDIRECT_REQUIRED', 'creator_restricted'], ['CHARACTER_DOWNLOAD_TURNSTILE_REQUIRED', 'verification_required']]) {
        const paths = [];
        api.setApiRequest(async path => { paths.push(path); return json({ error: upstream }, 404); });
        await assert.rejects(api.fetchDatacatCharacter(id, 'janitor'), error => error.code === code);
        assert.equal(paths.length, 1, 'restricted detail does not retry another source or public route');
        await assert.rejects(api.fetchDatacatDownload(id, 'janitor'), error => error.code === code);
    }
    api.setApiRequest(async () => new Response('Not Found', { status: 404 }));
    assert.equal(await api.fetchDatacatCharacter(id, 'janitor'), null);
    assert.equal(await api.fetchDatacatDownload(id, 'janitor'), null);
});

test('canonical downloads preserve selected empty fields, metadata and all extension namespaces', () => {
    const download = { spec: 'chara_card_v2', data: { name: 'Name', description: '', personality: 'separate personality', scenario: '', first_mes: '', creator: 'https://creator.example', character_book: { entries: [] }, depth_prompt: { depth: 4 }, extensions: { other: { key: 2 }, datacat: { linkedAt: 'yesterday' } } } };
    const result = api.buildV2FromDownload(download, { personality: 'old body', first_message: 'old greeting' }, { id, sourceKind: 'direct', definitionSource: 'reimagination' });
    assert.equal(result.data.description, '');
    assert.equal(result.data.first_mes, '');
    assert.equal(result.data.personality, 'separate personality');
    assert.equal(result.data.creator, 'https://creator.example');
    assert.deepEqual(result.data.character_book, { entries: [] });
    assert.equal(result.data.extensions.datacat.id, id);
    assert.equal(result.data.extensions.datacat.definitionSource, 'reimagination');
    assert.equal(result.data.extensions.datacat.linkedAt, 'yesterday');
    assert.deepEqual(result.data.extensions.other, { key: 2 });
    assert.deepEqual(result.data.depth_prompt, { depth: 4 });
});

test('malformed exports never become synthetic empty cards', async () => {
    for (const data of [{}, [], null, { name: 123 }]) {
        api.setApiRequest(async () => json({ data }));
        await assert.rejects(api.fetchDatacatDownload(id), error => error.code === 'invalid_response');
        assert.throws(() => api.buildV2FromDownload({ data }, null, { id }), error => error.code === 'invalid_response');
    }
});

test('browse sorts, native creators and clamped pages follow current API', async () => {
    const paths = [];
    api.setApiRequest(async path => { paths.push(path); return json({ characters: [{ characterId: id }], hasMore: true }); });
    const page = await api.fetchRecentPublic({ sortBy: 'messages_per_chat', limit: 80, offset: 80 });
    assert.equal(page.nextOffset, 81);
    assert.equal(page.hasMore, true);
    await api.fetchDatacatCreatorCharacters(id, { sourceKind: 'direct', sortBy: 'newest' });
    assert.match(paths[0], /[?&]sort=messages_per_chat/);
    assert.match(paths[1], /profiles\/users\/.+\/bots\?.*sort=latest/);
    await api.fetchDatacatCreatorCharacters(`saucepan:${id}`, { sortBy: 'newest' });
    assert.match(paths[2], /saucepan%3A/);
    assert.match(paths[2], /sortBy=creation_date/);
});

test('original artwork uses native media aliases and original variants during import', () => {
    const native = { characterId: id, sourceKind: 'direct_upload', avatar: 'stale-avatar.webp',
        intercepted_chat_data: JSON.stringify({ direct_upload: { media_assets: [
            { role: 'avatar', media_view_url: '/media/direct_upload/card.webp', original_url: '/media/direct_upload/original.png' },
        ] } }) };
    assert.equal(api.resolveDatacatAvatarUrl(native), 'https://datacat.run/media/direct_upload/card.webp');
    assert.equal(api.resolveDatacatAvatarUrl(native, { preferOriginal: true }), 'https://datacat.run/media/direct_upload/original.png');
    assert.equal(api.resolveDatacatAvatarUrl({ imageVariantUrls: { card: '/media/card.webp', original: '/media/original.png' } }, { preferOriginal: true }), 'https://datacat.run/media/original.png');
    assert.equal(api.resolveDatacatAvatarUrl({ charaCardV2Json: JSON.stringify({ data: { avatar: 'https://example.test/original.png' } }) }, { preferOriginal: true }), 'https://example.test/original.png');
});
