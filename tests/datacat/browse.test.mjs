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
    for (const name of ['datacatGrid', 'datacatCharDefinitionLoading', 'datacatCharDescriptionSection', 'datacatCharDescription', 'datacatCharCreatorNotesSection', 'datacatCharCreatorNotes', 'datacatImportBtn', 'datacatCreatorBannerName', 'datacatCreatorBanner', 'datacatExtractBtn', 'datacatExtractProgress']) make(name);
    const document = { getElementById: name => elements.get(name) || null, createElement: () => new Element(), querySelector: () => null, querySelectorAll: () => [] };
    const noop = () => {};
    const core = new Proxy({
        onElement: (id, event, listener) => (elements.get(id) || make(id)).addEventListener(event, listener),
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
        deactivate() {}
        disconnectImageObserver() {}
        _registerDropdownDismiss() {}
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
            init: initDatacatView,
            search: doSearch,
            deactivate: () => view.deactivate(),
            creator: browseCreator, clearCreator: clearCreatorFilter,
            lookup: fetchCharacterAndOpenPreview, externalLookup: lookupExternalCharacter,
            creatorDownloadReference: () => view._cdRef,
            extract: startExtraction, modalExtract: startModalExtraction,
            pollRetrieval: pollDatacatRetrieval,
            setupRetrieval(requestId, submittedAt) { extractionRequestId = requestId; extractionStartTime = submittedAt; },
            retrievalRequestId: () => extractionRequestId,
            follow: query => view.followCreator(query),
            unfollow: unfollowCreator,
            loadFollowing: loadFollowingCharacters,
            followingIds: () => datacatFollowingCharacters.map(getCharId),
            creatorReference: parseDatacatCreatorReference, creatorCatalogSource: getCreatorCatalogSource,
            followed: () => datacatFollowedCreators,
            setPreviewToken(value) { datacatDetailFetchToken = value; },
            previewToken: () => datacatDetailFetchToken,
            load: loadCharacters, advance: advanceDatacatPage,
            configure(options = {}) {
                delegatesInitialized = true; datacatViewMode = options.view || 'following';
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

test('enabling NSFW reloads Meili and Hampter from page one and rejects an old filtered page', async () => {
    for (const sort of ['janny_newest', 'hampter_latest']) {
        const requests = [];
        let resolveOld;
        const page = { characters: Array.from({ length: 80 }, (_, i) => ({ ...full, character_id: '11111111-2222-3333-4444-' + String(i).padStart(12, '0') })), totalPages: 2, total: 160, pageSize: 80 };
        const fetchPage = options => {
            requests.push(options);
            if (requests.length === 2) return new Promise(resolve => { resolveOld = resolve; });
            return Promise.resolve(requests.length === 1 ? page : { ...page, characters: [{ ...full, character_id: id2 }], totalPages: 1, total: 1 });
        };
        const h = harness({ dependencies: { searchMeiliJanny: fetchPage, fetchHampterCharacters: fetchPage } });
        h.api.init(); h.api.configure({ sort, view: 'browse' });
        await h.api.load(false);
        const oldPage = h.api.advance();
        await new Promise(resolve => setTimeout(resolve, 0));
        h.elements.get('datacatNsfwToggle').events.click();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.deepEqual(requests.map(({ page, nsfw }) => [page, nsfw]), [[1, false], [2, false], [1, true]]);
        resolveOld(page); await oldPage;
        assert.deepEqual(Array.from(h.api.state().ids), [id2]);
    }
});

test('changing browse sort preserves the submitted text query across all search backends', async () => {
    const requests = [];
    const h = harness({ dependencies: {
        fetchRecentPublic: async options => { requests.push(['recent', options.search]); return { characters: [] }; },
        searchMeiliJanny: async options => { requests.push(['meili', options.search]); return { characters: [] }; },
        fetchHampterCharacters: async options => { requests.push(['hampter', options.search]); return { characters: [] }; },
    } });
    h.api.init(); h.api.configure({ view: 'browse' });
    const input = h.elements.get('datacatSearchInput');
    input.value = 'Moon Knight'; h.api.search();
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const sort of ['janny_newest', 'hampter_latest', 'recent']) {
        const select = h.elements.get('datacatSortSelect'); select.value = sort; select.events.change();
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.deepEqual(requests, [['recent', 'Moon Knight'], ['meili', 'Moon Knight'], ['hampter', 'Moon Knight'], ['recent', 'Moon Knight']]);
    h.elements.get('datacatClearSearchBtn').events.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const select = h.elements.get('datacatSortSelect'); select.value = 'janny_newest'; select.events.change();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(requests.at(-1)[1], '');
});

test('submitting a text search leaves the creator catalog and clears its download target', async () => {
    const requests = [];
    const h = harness({ dependencies: {
        fetchRecentPublic: async options => { requests.push(['recent', options.search]); return { characters: [] }; },
        fetchDatacatCreatorCharacters: async () => { requests.push(['creator']); return { list: [] }; },
    } });
    h.api.init(); h.api.configure({ creator: id, view: 'browse' });
    h.elements.get('datacatSearchInput').value = 'Other character'; h.api.search();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(requests, [['recent', 'Other character']]);
    assert.equal(h.api.creatorDownloadReference(), null);
});

test('unfollowing during a timeline load cannot restore the removed creator characters', async () => {
    let follows = [{ id, name: 'Creator', source: 'datacat' }];
    let resolvePage;
    const h = harness({ core: {
        getSetting: name => name === 'datacatFollowedCreators' ? follows : false,
        setSetting: (name, value) => { if (name === 'datacatFollowedCreators') follows = value; },
    }, dependencies: { fetchDatacatCreatorCharacters: () => new Promise(resolve => { resolvePage = resolve; }) } });
    h.api.configure();
    const loading = h.api.loadFollowing();
    h.api.unfollow(id);
    resolvePage({ list: [full], total: 1 }); await loading;
    assert.equal(follows.length, 0);
    assert.deepEqual(Array.from(h.api.followingIds()), []);
});

test('refreshing Following supersedes a pending load and retains only the fresh response', async () => {
    let resolveOld;
    let calls = 0;
    const h = harness({ core: { getSetting: name => name === 'datacatFollowedCreators' ? [{ id, name: 'Creator', source: 'datacat' }] : false },
        dependencies: { fetchDatacatCreatorCharacters: async () => ++calls === 1
            ? new Promise(resolve => { resolveOld = resolve; })
            : { list: [{ ...full, character_id: id2 }], total: 1 } },
    });
    const old = h.api.loadFollowing();
    await h.api.loadFollowing(true);
    assert.equal(calls, 2);
    resolveOld({ list: [full], total: 1 }); await old;
    assert.deepEqual(Array.from(h.api.followingIds()), [id2]);
});

test('deactivating stops a pending Following page and permits a clean reload', async () => {
    const requests = [];
    let resolveOld;
    const h = harness({ core: { getSetting: name => name === 'datacatFollowedCreators' ? [{ id, name: 'Creator', source: 'datacat' }] : false },
        dependencies: { fetchDatacatCreatorCharacters: async (_id, options) => {
            requests.push(options.offset);
            if (requests.length === 1) return new Promise(resolve => { resolveOld = resolve; });
            return { list: [{ ...full, character_id: id2 }], total: 1 };
        } },
    });
    const old = h.api.loadFollowing();
    h.api.deactivate();
    resolveOld({ list: [full], total: 100, nextOffset: 1, hasMore: true }); await old;
    assert.deepEqual(requests, [0]);
    assert.deepEqual(Array.from(h.api.followingIds()), []);
    await h.api.loadFollowing();
    assert.deepEqual(requests, [0, 0]);
    assert.deepEqual(Array.from(h.api.followingIds()), [id2]);
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

test('late creator metadata cannot replace the selected creator download target', async () => {
    let resolveFirst;
    const requests = [];
    const h = harness({ dependencies: {
        fetchDatacatCreator: creatorId => creatorId === id
            ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve({ name: 'Second creator' }),
        fetchDatacatCreatorCharacters: async creatorId => { requests.push(creatorId); return { list: [], total: 0 }; },
    } });
    h.api.configure();
    const first = h.api.creator(id);
    await h.api.creator(id2);
    resolveFirst({ name: 'First creator' });
    await first;
    assert.equal(h.api.creatorDownloadReference().creatorId, id2);
    assert.equal(h.elements.get('datacatCreatorBannerName').textContent, 'Second creator');
    assert.deepEqual(requests, [id2]);
});

test('clearing a creator before its metadata resolves does not restore the stale creator banner', async () => {
    let resolveCreator;
    const h = harness({ dependencies: { fetchDatacatCreator: () => new Promise(resolve => { resolveCreator = resolve; }) } });
    h.api.configure();
    const browsing = h.api.creator(id);
    h.api.clearCreator();
    resolveCreator({ name: 'Old creator' });
    await browsing;
    assert.equal(h.api.creatorDownloadReference(), null);
    assert.notEqual(h.elements.get('datacatCreatorBannerName').textContent, 'Old creator');
});

test('late URL lookups cannot reopen a preview or offer retrieval after a replacement browse', async () => {
    for (const external of [false, true]) {
        for (const found of [false, true]) {
            let resolveLookup;
            const h = harness({ dependencies: { fetchDatacatCharacter: () => new Promise(resolve => { resolveLookup = resolve; }) } });
            h.api.configure(); h.api.watchSelection();
            const lookup = external ? h.api.externalLookup(id, 'https://janitorai.com/characters/' + id) : h.api.lookup(id);
            await h.api.load(false);
            const gridBefore = h.elements.get('datacatGrid').innerHTML;
            resolveLookup(found ? full : null);
            await lookup;
            assert.equal(h.context.changedHit, undefined);
            assert.equal(h.elements.get('datacatGrid').innerHTML, gridBefore);
        }
    }
});

test('failed Meili and Hampter load-more requests retry the failed page without skipping rows', async () => {
    for (const sort of ['janny_newest', 'hampter_latest']) {
        const requests = [];
        const fetchPage = async options => {
            requests.push(options.page);
            if (requests.length === 2) throw new Error('Temporary service failure');
            return { characters: [full], totalPages: 4, total: 136, pageSize: 34 };
        };
        const h = harness({ dependencies: { searchMeiliJanny: fetchPage, fetchHampterCharacters: fetchPage } });
        h.api.configure({ sort });
        await h.api.load(false); await h.api.advance(); await h.api.advance();
        assert.deepEqual(requests, [1, 2, 2]);
    }
});

test('a late Saucepan creator page cannot poison the newly selected creator cache', async () => {
    let resolveFirst;
    let callCount = 0;
    const h = harness({ dependencies: { fetchSaucepanCompanionsOfUser: async () => {
        if (++callCount === 1) return new Promise(resolve => { resolveFirst = resolve; });
        return { characters: [...Array.from({ length: 80 }, () => full), { ...full, character_id: id2 }] };
    } } });
    h.api.configure({ creator: id, source: 'saucepan' });
    const first = h.api.load(false);
    h.api.configure({ creator: id2, source: 'saucepan' });
    await h.api.load(false);
    resolveFirst({ characters: [full] }); await first;
    await h.api.advance();
    assert.equal(h.api.state().ids.length, 2);
    assert.equal(h.api.state().offset, 81);
});

test('concurrent load-more calls cannot skip a Meili or Hampter page', async () => {
    for (const sort of ['janny_newest', 'hampter_latest']) {
        const requests = [];
        let resolveSecond;
        const page = { characters: [full], totalPages: 4, total: 136, pageSize: 34 };
        const fetchPage = async options => {
            requests.push(options.page);
            if (options.page === 2) return new Promise(resolve => { resolveSecond = resolve; });
            return page;
        };
        const h = harness({ dependencies: { searchMeiliJanny: fetchPage, fetchHampterCharacters: fetchPage } });
        h.api.configure({ sort }); await h.api.load(false);
        const second = h.api.advance();
        await new Promise(resolve => setTimeout(resolve, 0));
        await h.api.advance();
        resolveSecond(page); await second; await h.api.advance();
        assert.deepEqual(requests, [1, 2, 3]);
    }
});

test('deactivation cannot commit an unfinished Meili or Hampter page', async () => {
    for (const sort of ['janny_newest', 'hampter_latest']) {
        const requests = [];
        let resolveSecond;
        const page = { characters: [full], totalPages: 4, total: 136, pageSize: 34 };
        const fetchPage = async options => {
            requests.push(options.page);
            if (requests.length === 2) return new Promise(resolve => { resolveSecond = resolve; });
            return page;
        };
        const h = harness({ dependencies: { searchMeiliJanny: fetchPage, fetchHampterCharacters: fetchPage } });
        h.api.configure({ sort }); await h.api.load(false);
        const second = h.api.advance();
        await new Promise(resolve => setTimeout(resolve, 0));
        h.api.deactivate(); resolveSecond(page); await second;
        h.api.configure({ sort }); await h.api.advance();
        assert.deepEqual(requests, [1, 2, 2]);
    }
});

function retrievalClock() {
    let now = 1800000000000;
    let nextId = 0;
    const tasks = new Map();
    return {
        Date: class extends Date { static now() { return now; } },
        setTimeout(fn, delay) { const id = ++nextId; tasks.set(id, { fn, at: now + delay }); return id; },
        clearTimeout(id) { tasks.delete(id); },
        pending: () => tasks.size,
        async tick() {
            const task = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
            assert.ok(task, 'a retrieval poll is scheduled');
            tasks.delete(task[0]); now = task[1].at;
            await task[1].fn();
        },
    };
}

test('grid and modal retrieval submissions stop immediately on terminal failures despite a request ID', async () => {
    for (const modal of [false, true]) for (const status of ['failed', 'cancelled', 'timed_out']) {
        const clock = retrievalClock();
        const h = harness({ dependencies: { ...clock, submitExtraction: async () => ({ status, requestId: 'failed-job', message: 'Terminal ' + status }) } });
        if (modal) await h.api.modalExtract(id); else await h.api.extract('https://janitorai.com/characters/' + id, id);
        assert.equal(clock.pending(), 0);
        const button = h.elements.get(modal ? 'datacatImportBtn' : 'datacatExtractBtn');
        assert.equal(button.disabled, false);
        assert.match(button.innerHTML, /Retry/);
        if (!modal) assert.match(h.elements.get('datacatExtractProgress').innerHTML, /Terminal/);
    }
});

test('retrieval submission completion and existing-card shortcuts load directly without polling', async () => {
    for (const modal of [false, true]) for (const result of [
        { run: { status: 'completed', request_id: 'done' } },
        { skippedExtraction: true, collected: true, characterId: id },
    ]) {
        const clock = retrievalClock();
        const h = harness({ dependencies: { ...clock, submitExtraction: async () => result } });
        h.api.watchSelection();
        if (modal) await h.api.modalExtract(id); else await h.api.extract('https://janitorai.com/characters/' + id, id);
        assert.equal(clock.pending(), 0);
        assert.equal(h.context.changedHit.character_id, id);
    }
});

test('a superseded submission cannot reset a newer retrieval even with identical timestamps', async () => {
    let resolveFirst;
    let count = 0;
    const clock = retrievalClock();
    const h = harness({ dependencies: { ...clock, submitExtraction: () => ++count === 1
        ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve({ run: { status: 'queued', request_id: 'second-job' } }) } });
    const first = h.api.modalExtract(id);
    await h.api.modalExtract(id2);
    resolveFirst({ requestId: 'first-job', status: 'failed' }); await first;
    assert.equal(h.api.retrievalRequestId(), 'second-job');
    assert.equal(h.elements.get('datacatImportBtn').disabled, true);
    assert.match(h.elements.get('datacatImportBtn').innerHTML, /Retrieving/);
    assert.equal(clock.pending(), 1);
    h.api.close(); assert.equal(clock.pending(), 0);
});

test('preview retrieval polling ignores stale/unrelated history and reports each terminal outcome', async () => {
    for (const status of ['completed', 'failed', 'cancelled', 'timed_out']) {
        const clock = retrievalClock();
        const events = [];
        let polls = 0;
        const h = harness({ dependencies: { ...clock, fetchExtractionStatus: async () => ({ history: ++polls === 1 ? [
            { requestId: 'old-job', characterId: id, status: 'completed' },
            { requestId: 'other-job', characterId: id2, status: 'completed' },
        ] : [{ requestId: 'current-job', characterId: id, status }] }) } });
        h.api.setupRetrieval('current-job', clock.Date.now());
        h.api.pollRetrieval(id, { progress: message => events.push(['progress', message]), complete: () => events.push(['complete']), failed: message => events.push(['failed', message]) });
        await clock.tick(); assert.deepEqual(events.map(row => row[0]), ['progress']);
        await clock.tick(); assert.equal(events.at(-1)[0], status === 'completed' ? 'complete' : 'failed');
        assert.equal(clock.pending(), 0);
    }
});

test('preview retrieval polling times out and cancellation ignores an in-flight status response', async () => {
    const clock = retrievalClock();
    const events = [];
    const h = harness({ dependencies: { ...clock, fetchExtractionStatus: async () => ({ history: [] }) } });
    h.api.setupRetrieval('job', clock.Date.now());
    h.api.pollRetrieval(id, { progress() {}, complete: () => events.push('complete'), failed: message => events.push(message) });
    while (clock.pending()) await clock.tick();
    assert.equal(events.length, 1); assert.match(events[0], /timed out/);

    let resolveStatus;
    const cancelledClock = retrievalClock();
    const cancelled = harness({ dependencies: { ...cancelledClock, fetchExtractionStatus: () => new Promise(resolve => { resolveStatus = resolve; }) } });
    cancelled.api.setupRetrieval('job', cancelledClock.Date.now());
    cancelled.api.pollRetrieval(id, { progress: () => assert.fail('cancelled'), complete: () => assert.fail('cancelled'), failed: () => assert.fail('cancelled') });
    const pending = cancelledClock.tick(); cancelled.api.close();
    resolveStatus({ history: [{ requestId: 'job', status: 'completed' }] }); await pending;
    assert.equal(cancelledClock.pending(), 0);
});

test('creator downloads reject terminal or malformed submissions without waiting for status', async () => {
    for (const submission of [{ status: 'failed', requestId: 'job' }, { run: { status: 'cancelled', request_id: 'job' } }, { task: { status: 'timed_out' } }, {}]) {
        let polls = 0;
        const h = bulkHarness({ submitExtraction: async () => submission, fetchExtractionStatus: async () => { polls++; return {}; }, setTimeout: () => assert.fail('terminal submission must not wait') });
        await assert.rejects(h.retrieve({ _cdCancelled: false }, id, 'janitor'), /Retrieval/);
        assert.equal(polls, 0);
    }
});

test('creator downloads match nested submission IDs and ignore stale completed jobs', async () => {
    let polls = 0;
    const h = bulkHarness({ submitExtraction: async () => ({ run: { status: 'queued', request_id: 'current-job' } }),
        setTimeout: fn => { fn(); return 1; },
        fetchExtractionStatus: async () => ({ history: ++polls === 1
            ? [{ requestId: 'old-job', characterId: id, status: 'completed', completedAt: Date.now() + 5000 }]
            : [{ requestId: 'current-job', characterId: id, status: 'completed' }] }),
    });
    const result = await h.retrieve({ _cdCancelled: false }, id, 'janitor');
    assert.equal(polls, 2);
    assert.equal(result.character_id, id);
});
