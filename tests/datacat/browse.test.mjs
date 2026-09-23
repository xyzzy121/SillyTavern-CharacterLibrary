import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../modules/providers/datacat/', import.meta.url);
const source = (await readFile(new URL('datacat-browse.js', root), 'utf8'))
    .replace(/^import[\s\S]*?;\r?\n/gm, '').replace('export default datacatBrowseView;', '');
const contract = await import(`data:text/javascript;base64,${Buffer.from(await readFile(new URL('datacat-contract.js', root), 'utf8')).toString('base64')}`);
const id = '11111111-2222-3333-4444-555555555555';
const id2 = '11111111-2222-3333-4444-666666666666';
const full = { character_id: id, name: 'Character', primary_content_source_kind: 'janitor', has_datacat_reimagination: true };
const acquired = (definitionSource = 'source', variantId = '') => ({ card: { spec: 'chara_card_v2', data: {
    name: 'Character', description: definitionSource + ' body', first_mes: definitionSource + ' greeting', creator: 'Creator',
    alternate_greetings: [definitionSource + ' alternative'], extensions: { datacat: { id, definitionSource, variantId } },
} }, imageBuffer: null, definitionSource, variantId, character: full });

function harness(overrides = {}) {
    const calls = [];
    const elements = new Map();
    class Element {
        constructor(id = '') { this.id = id; this.style = {}; this.dataset = {}; this.events = {}; this.value = ''; this.innerHTML = ''; this.classList = { add() {}, remove() {}, toggle() {} }; }
        querySelector(selector) { if (!selector.startsWith('#') || !this.innerHTML.includes('id="' + selector.slice(1) + '"')) return null; return elements.get(selector.slice(1)) || make(selector.slice(1)); }
        addEventListener(type, fn) { this.events[type] = fn; }
        before(element) { elements.set(element.id, element); }
        remove() { elements.delete(this.id); }
        insertAdjacentHTML(_, html) { this.innerHTML += html; }
        querySelectorAll() { return []; }
    }
    const make = name => { const element = new Element(name); elements.set(name, element); return element; };
    for (const name of ['datacatGrid', 'datacatCharDefinitionLoading', 'datacatCharDescriptionSection', 'datacatCharDescription', 'datacatCharCreatorNotesSection', 'datacatCharCreatorNotes', 'datacatImportBtn']) make(name);
    const document = { getElementById: name => elements.get(name) || null, createElement: () => new Element(), querySelector: () => null, querySelectorAll: () => [] };
    const noop = () => {};
    const core = new Proxy({
        getSetting: () => false, getProvider: () => ({ importCharacter: async (_id, _character, options) => { calls.push(['import', options]); return { success: true, characterName: 'Character' }; } }),
        checkCharacterForDuplicatesAsync: async () => [{ char: { name: 'Previous' } }],
        showPreImportDuplicateWarning: async () => ({ choice: 'replace' }),
        deleteCharacter: async () => { calls.push(['delete']); return true; },
        getCharacterGalleryId: () => 'gallery', getProviderExcludeTags: () => [],
        escapeHtml: value => String(value), showToast: (...args) => calls.push(['toast', ...args]),
        renderCardHtmlSecure: (text, _name, element) => { element.rendered = text; },
        renderCreatorNotesSecure: (text, _name, element) => { element.rendered = text; },
        ...overrides.core,
    }, { get: (target, name) => target[name] || noop });
    class BrowseView {
        constructor() { this._lookup = { byProviderId: new Set(), byNameAndCreator: new Set() }; }
        static closeAvatarViewer() {}
        isCharPossibleMatch() { return false; }
        updateLoadMoreVisibility() {}
        _setScrollIndicator() {}
    }
    const context = vm.createContext({ ...contract, CoreAPI: core, BrowseView, document, window: {},
        JANNY_TAG_MAP: {}, IMG_PLACEHOLDER: '', BROWSE_PURIFY_CONFIG: {},
        console: { error: noop, warn: noop }, setTimeout, clearTimeout, URL, Date, Set, AbortController,
        formatNumber: String, formatRichText: String, safePurify: String,
        resolveDatacatAvatarUrl: () => null, resolveTagNames: () => [], stripHtml: value => value || '',
        renderBrowseError: (_element, options) => calls.push(['error', options]),
        renderSkeletonGrid: noop, finishBrowseImport: async () => calls.push(['finished']),
        acquireDatacatExport: async (_id, options) => { calls.push(['acquire', options]); return acquired(options.definitionSource, options.variantId); },
        fetchDatacatCharacter: async () => full, fetchSaucepanCompanion: async () => null,
        fetchRecentPublic: async () => ({ characters: [], total: 0 }),
        fetchFreshCharacters: async () => ({ last24h: [], thisWeek: [] }),
        fetchDatacatCreatorCharacters: async () => ({ list: [], total: 0 }),
        fetchHampterCharacters: async () => ({ characters: [], total: 0 }),
        searchMeiliJanny: async () => ({ characters: [], totalPages: 0 }),
        ...overrides.dependencies,
    });
    vm.runInContext(source + `
        globalThis.testApi = {
            preview: fetchAndPopulateDetails, import: importCharacter, selector: renderDatacatDefinitionSelector,
            close: closePreviewModal,
            follow: query => view.followCreator(query),
            creatorReference: parseDatacatCreatorReference, creatorCatalogSource: getCreatorCatalogSource,
            followed: () => datacatFollowedCreators,
            setPreviewToken(value) { datacatDetailFetchToken = value; },
            previewToken: () => datacatDetailFetchToken,
            load: loadCharacters, advance: advanceDatacatPage,
            configure(options = {}) {
                delegatesInitialized = true; datacatViewMode = 'following';
                datacatSortMode = options.sort || 'recent'; datacatBrowseMode = options.creator ? 'creator' : 'recent';
                datacatCreatorId = options.creator || null; datacatCreatorSource = options.source || 'datacat';
                datacatSearchQuery = options.search || '';
                renderGrid = rows => { datacatGridRenderedCount = rows.length; };
            },
            state() { return { offset: datacatCurrentOffset, offset24: datacatFreshOffset24, offsetWeek: datacatFreshOffsetWeek, hasMore: datacatHasMore, ids: datacatCharacters.map(getCharId) }; },
            watchSelection() { openPreviewModal = hit => { globalThis.changedHit = hit; }; },
        };`, context);
    return { api: context.testApi, context, elements, calls };
}

test('preview and import use the same chosen definition and preserve a source variant', async () => {
    const h = harness();
    const hit = { ...full, _fullCharacter: full, definitionSource: 'source', variantId: 'janitor_core:source' };
    await h.api.preview(hit, 0);
    assert.equal(hit.variantId, 'janitor_core:source');
    assert.equal(h.elements.get('datacatCharDescription').rendered, 'source body');
    await h.api.import(hit);
    assert.deepEqual(h.calls.filter(call => ['acquire', 'delete', 'import'].includes(call[0])).map(call => call[0]), ['acquire', 'delete', 'import']);
    assert.equal(h.calls.find(call => call[0] === 'import')[1].acquiredExport.card.data.first_mes, 'source greeting');
    hit.definitionSource = 'reimagination'; delete hit._acquiredExport; delete hit.variantId;
    await h.api.preview(hit, 0);
    assert.equal(h.elements.get('datacatCharDescription').rendered, 'reimagination body');
    assert.equal(h.calls.filter(call => call[0] === 'acquire').at(-1)[1].interactive, false);
});

test('selector disables unavailable reimagination and resets a variant only on user change', () => {
    const h = harness(); const hit = { ...full, definitionSource: 'source', variantId: 'saved' };
    h.api.selector(hit, { ...full, has_datacat_reimagination: false });
    assert.match(h.elements.get('datacatDefinitionSelector').innerHTML, /value="reimagination" disabled/);
    assert.equal(hit.variantId, 'saved');
    h.api.selector(hit, full); h.api.watchSelection();
    const select = h.elements.get('datacatDefinitionSource'); select.value = 'reimagination'; select.events.change();
    assert.equal(h.context.changedHit.definitionSource, 'reimagination');
    assert.equal(h.context.changedHit.variantId, undefined);
});

test('verification and cancellation cannot delete an existing local card', async () => {
    for (const error of [Object.assign(new Error('Verify'), { code: 'verification_required' }), Object.assign(new Error('Cancelled'), { name: 'AbortError' })]) {
        const h = harness({ dependencies: { acquireDatacatExport: async () => { throw error; } } });
        await h.api.import({ ...full, _fullCharacter: full });
        assert.equal(h.calls.some(call => call[0] === 'delete' || call[0] === 'import'), false);
    }
});

test('closing a preview while its export is pending prevents replacement', async () => {
    let resolveExport;
    let exportSignal;
    const h = harness({ dependencies: { acquireDatacatExport: (_id, options) => {
        exportSignal = options.signal;
        return new Promise(resolve => { resolveExport = resolve; });
    } } });
    const importing = h.api.import({ ...full, _fullCharacter: full });
    h.api.close();
    assert.equal(exportSignal.aborted, true);
    // Even if a dependency finishes successfully after cancellation, the local
    // replacement must not start.
    resolveExport(acquired());
    await importing;
    assert.equal(h.calls.some(call => call[0] === 'delete' || call[0] === 'import'), false);
});

test('closing a preview while duplicate confirmation is pending prevents replacement', async () => {
    let resolveConfirmation;
    const h = harness({ core: { showPreImportDuplicateWarning: () => new Promise(resolve => { resolveConfirmation = resolve; }) } });
    const importing = h.api.import({ ...full, _fullCharacter: full, _acquiredExport: acquired() });
    await new Promise(resolve => setTimeout(resolve, 0));
    h.api.close();
    resolveConfirmation({ choice: 'replace' });
    await importing;
    assert.equal(h.calls.some(call => call[0] === 'delete' || call[0] === 'import'), false);
});

test('a replacement already being written finishes without closing or repainting a newer preview', async () => {
    let resolveDelete;
    let completion;
    const h = harness({
        core: { deleteCharacter: () => new Promise(resolve => { resolveDelete = resolve; }) },
        dependencies: { finishBrowseImport: async options => { completion = options; options.closePreview(); } },
    });
    const importing = h.api.import({ ...full, _fullCharacter: full, _acquiredExport: acquired() });
    await new Promise(resolve => setTimeout(resolve, 0));
    h.api.close();
    h.api.setPreviewToken(2);
    h.elements.get('datacatImportBtn').innerHTML = 'New preview import';
    resolveDelete(true);
    await importing;
    assert.equal(h.calls.filter(call => call[0] === 'import').length, 1);
    assert.equal(h.calls.find(call => call[0] === 'import')[1].signal.aborted, false);
    assert.equal(completion.importBtn, null);
    assert.equal(h.api.previewToken(), 2);
    assert.equal(h.elements.get('datacatImportBtn').innerHTML, 'New preview import');
});

test('a late Saucepan detail response cannot overwrite a newer preview', async () => {
    let resolveSaucepan;
    const h = harness({ dependencies: {
        fetchDatacatCharacter: async () => null,
        fetchSaucepanCompanion: () => new Promise(resolve => { resolveSaucepan = resolve; }),
    } });
    const previewing = h.api.preview({ ...full, primary_content_source_kind: 'saucepan' }, 0);
    await new Promise(resolve => setTimeout(resolve, 0));
    h.api.setPreviewToken(1);
    resolveSaucepan({ open_definition: false });
    await previewing;
    assert.equal(h.elements.get('datacatImportBtn').dataset.extractId, undefined);
    assert.equal(h.elements.get('datacatCharDescription').innerHTML, '');
});

test('only missing detail records offer retrieval, and verification leaves import available', async () => {
    for (const [code, extraction] of [['not_found', true], ['creator_restricted', false], ['service_unavailable', false]]) {
        const h = harness({ dependencies: { fetchDatacatCharacter: async () => { throw Object.assign(new Error(code), { code }); } } });
        await h.api.preview({ ...full }, 0);
        assert.equal(!!h.elements.get('datacatImportBtn').dataset.extractId, extraction);
    }
    const h = harness({ dependencies: { acquireDatacatExport: async () => { throw Object.assign(new Error('Verify'), { code: 'verification_required' }); } } });
    await h.api.preview({ ...full, _fullCharacter: full }, 0);
    assert.match(h.elements.get('datacatCharDescription').textContent, /Verification required/);
    assert.equal(h.elements.get('datacatImportBtn').disabled, false);
});

test('Fresh windows use independent offsets and de-duplicate display rows', async () => {
    const requests = [];
    const h = harness({ dependencies: { fetchFreshCharacters: async options => {
        requests.push(options);
        if (options.limitWeek) return { thisWeek: [{ ...full, character_id: id2 }], last24h: [], paginationWeek: { nextOffset: 7, hasMore: false } };
        return options.offset24 === 0
            ? { last24h: [full, full], thisWeek: [], pagination24: { nextOffset: 2, hasMore: true } }
            : { last24h: [{ ...full, character_id: id2 }], thisWeek: [], pagination24: { nextOffset: 3, hasMore: false } };
    } } });
    h.api.configure({ sort: 'fresh_24h' }); await h.api.load(false); await h.api.advance();
    assert.deepEqual(requests.map(options => options.offset24), [0, 2]);
    assert.equal(h.api.state().ids.length, 2);
    assert.equal(h.api.state().offsetWeek, 0);
    h.api.configure({ sort: 'fresh_week' }); await h.api.load(false);
    assert.equal(requests.at(-1).offsetWeek, 0); assert.equal(h.api.state().offsetWeek, 7);
});

test('replacement loads reset Fresh and recent offsets after clearing search or tags', async () => {
    const requests = [];
    const h = harness({ dependencies: {
        fetchFreshCharacters: async options => {
            requests.push(['fresh', options.offset24]);
            return { last24h: [full], pagination24: { nextOffset: options.offset24 + 1, hasMore: true } };
        },
        fetchRecentPublic: async options => {
            requests.push(['recent', options.offset]);
            return { characters: [full], nextOffset: options.offset + 1, hasMore: true };
        },
    } });
    h.api.configure({ sort: 'fresh_24h' });
    await h.api.load(false); await h.api.advance();
    h.api.configure({ sort: 'fresh_24h', search: 'Creator' });
    await h.api.load(false); await h.api.advance();
    h.api.configure({ sort: 'fresh_24h' });
    await h.api.load(false);
    h.api.configure(); await h.api.load(false); await h.api.advance(); await h.api.load(false);
    assert.deepEqual(requests, [['fresh', 0], ['fresh', 1], ['recent', 0], ['recent', 1], ['fresh', 0], ['recent', 0], ['recent', 1], ['recent', 0]]);
});

test('creator and recent pages advance clamped raw rows without requiring totals', async () => {
    const requests = [];
    const fetchPage = async options => {
        requests.push(options);
        return { list: options.offset ? [] : [full, full], characters: options.offset ? [] : [full, full], total: null };
    };
    const h = harness({ dependencies: { fetchDatacatCreatorCharacters: (_creator, options) => fetchPage(options), fetchRecentPublic: fetchPage } });
    h.api.configure({ creator: id, source: 'direct_upload' });
    await h.api.load(false); assert.equal(h.api.state().offset, 2); assert.equal(h.api.state().hasMore, true);
    await h.api.advance(); assert.equal(requests.at(-1).offset, 2); assert.equal(requests[0].sourceKind, 'direct_upload');
    assert.equal(h.api.state().hasMore, false);
});

test('the separate Saucepan creator list paginates raw rows after de-duplication', async () => {
    const h = harness({ dependencies: { fetchSaucepanCompanionsOfUser: async () => ({ characters: [
        ...Array.from({ length: 80 }, () => full), { ...full, character_id: id2 },
    ] }) } });
    h.api.configure({ creator: id, source: 'saucepan' });
    await h.api.load(false); await h.api.advance();
    assert.equal(h.api.state().ids.length, 2);
    assert.equal(h.api.state().offset, 81);
    assert.equal(h.api.state().hasMore, false);
});

test('Meili and Hampter retain their own page-based browsing', async () => {
    for (const sort of ['janny_newest', 'hampter_latest']) {
        const requests = [];
        const h = harness({ dependencies: {
            searchMeiliJanny: async options => { requests.push(options); return { characters: [full], totalPages: 2 }; },
            fetchHampterCharacters: async options => { requests.push(options); return { characters: [full], total: 68, pageSize: 34 }; },
        } });
        h.api.configure({ sort }); await h.api.load(false); await h.api.advance();
        assert.deepEqual(requests.map(options => options.page), [1, 2]);
    }
});

const baseSource = (await readFile(new URL('../browse-view.js', root), 'utf8'))
    .replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export default .*;$/gm, '').replace(/^export /gm, '');
function bulkHarness(overrides = {}) {
    const calls = [];
    const context = vm.createContext({ ...contract, window: {}, document: { getElementById: () => null },
        setTimeout, clearTimeout, AbortController,
        CoreAPI: { getSetting: () => false, getProvider: () => ({ importCharacter: async (_id, _character, options) => {
            calls.push(['import', options]); return { success: false, cancelled: true, panelClosed: true };
        } }) },
        fetchDatacatCreatorCharacters: async (_creator, options) => {
            calls.push(['page', options.offset]);
            return { list: options.offset < 2 ? [full] : [{ ...full, character_id: id2 }], pagination: { nextOffset: options.offset + 1, hasMore: options.offset < 2 } };
        },
        fetchDatacatCharacter: async (_id, _source, options) => { calls.push(['detail', options]); return full; },
        submitExtraction: async () => { calls.push(['retrieve']); return {}; },
        ...overrides,
    });
    vm.runInContext(baseSource + '\nglobalThis.adapter = CD_ADAPTERS.datacat; globalThis.retrieve = cdDatacatExtract;', context);
    return { calls, adapter: context.adapter, retrieve: context.retrieve };
}

test('creator download continues after an entirely duplicated intermediate page', async () => {
    const h = bulkHarness();
    const cards = await h.adapter.fetchAll({ _cdRef: { creatorId: id, source: 'direct_upload' } });
    assert.deepEqual(h.calls.filter(call => call[0] === 'page').map(call => call[1]), [0, 1, 2]);
    assert.equal(cards.length, 2);
});

test('closing the shared verification panel cancels remaining creator downloads', async () => {
    const h = bulkHarness();
    const view = { _cdCancelled: false, _cdAbortController: new AbortController() };
    const result = await h.adapter.importOne(view, { raw: full });
    assert.equal(result.cancelled, true);
    assert.equal(view._cdCancelled, true);
    assert.equal(view._cdAbortController.signal.aborted, true);
    assert.equal(h.calls.find(call => call[0] === 'import')[1].reusePanel, true);
    assert.equal(h.calls.find(call => call[0] === 'detail')[1].signal, view._cdAbortController.signal);
    await h.retrieve(view, id, 'janitor');
    assert.equal(h.calls.some(call => call[0] === 'retrieve'), false);
});

test('recent browse passes the sort option consumed by the API adapter', async () => {
    const requests = [];
    const h = harness({ dependencies: { fetchRecentPublic: async options => { requests.push(options); return { characters: [], total: 0 }; } } });
    h.api.configure(); await h.api.load(false);
    assert.equal(requests[0].sortBy, 'fresh');
    h.api.configure({ sort: 'score_week', search: 'Creator' }); await h.api.load(false);
    assert.equal(requests[1].sortBy, 'score');
});

test('Following Manager resolves native-owner and encoded Saucepan Datacat URLs', async () => {
    const requests = [];
    const h = harness({ dependencies: { fetchDatacatCreator: async (creatorId, options) => {
        requests.push({ creatorId, ...options });
        return { name: 'Creator' };
    } } });
    await h.api.follow('https://datacat.run/profiles/users/' + id);
    await h.api.follow('https://datacat.run/creators/saucepan%3A' + id2);
    assert.deepEqual(requests, [{ creatorId: id, sourceKind: 'direct_upload' }, { creatorId: 'saucepan:' + id2, sourceKind: undefined }]);
    assert.equal(h.api.followed()[0].source, 'direct_upload');
    assert.equal(h.api.followed()[1].source, 'datacat');
    assert.equal(h.api.creatorCatalogSource('saucepan:' + id, 'saucepan'), 'datacat');
    assert.equal(h.api.creatorCatalogSource(id, 'saucepan'), 'saucepan');
    assert.equal(h.api.creatorReference('https://example.com/creators/' + id), null);
});
