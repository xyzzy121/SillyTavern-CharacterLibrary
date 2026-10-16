// Shared JannyAI API utilities - used by both janny-provider.js and janny-browse.js
//
// Contains constants, tag mapping, MeiliSearch token management,
// proxy fetch helpers, and text utilities.

// ========================================
// CONSTANTS
// ========================================

const JANNY_SEARCH_URL = 'https://search.jannyai.com/multi-search';
export const JANNY_IMAGE_BASE = 'https://image.jannyai.com/bot-avatars/';
export const JANNY_SITE_BASE = 'https://jannyai.com';
const JANNY_FALLBACK_TOKEN = '88a6463b66e04fb07ba87ee3db06af337f492ce511d93df6e2d2968cb2ff2b30';

// Tag ID → name mapping (JannyAI uses numeric IDs internally)
export const TAG_MAP = {
    1: 'Male', 2: 'Female', 3: 'Non-binary', 4: 'Celebrity', 5: 'OC',
    6: 'Fictional', 7: 'Real', 8: 'Game', 9: 'Anime', 10: 'Historical',
    11: 'Royalty', 12: 'Detective', 13: 'Hero', 14: 'Villain', 15: 'Magical',
    16: 'Non-human', 17: 'Monster', 18: 'Monster Girl', 19: 'Alien', 20: 'Robot',
    21: 'Politics', 22: 'Vampire', 23: 'Giant', 24: 'OpenAI', 25: 'Elf',
    26: 'Multiple', 27: 'VTuber', 28: 'Dominant', 29: 'Submissive', 30: 'Scenario',
    31: 'Pokemon', 32: 'Assistant', 34: 'Non-English', 36: 'Philosophy',
    38: 'RPG', 39: 'Religion', 41: 'Books', 42: 'AnyPOV', 43: 'Angst',
    44: 'Demi-Human', 45: 'Enemies to Lovers', 46: 'Smut', 47: 'MLM',
    48: 'WLW', 49: 'Action', 50: 'Romance', 51: 'Horror', 52: 'Slice of Life',
    53: 'Fantasy', 54: 'Drama', 55: 'Comedy', 56: 'Mystery', 57: 'Sci-Fi',
    59: 'Yandere', 60: 'Furry', 61: 'Movies/TV'
};

// ========================================
// TOKEN MANAGEMENT
// ========================================

let _cachedToken = null;
let _tokenFetchPromise = null;
let _tokenFetchEntry = null;

/**
 * Fetch the MeiliSearch API key from JannyAI's client config JS bundle.
 * Falls back to a known hardcoded key if scraping fails.
 * Token is cached across calls (shared between provider and browse view).
 */
async function getSearchToken(signal) {
    signal?.throwIfAborted();
    if (_cachedToken) return _cachedToken;
    if (_tokenFetchEntry) return waitForToken(_tokenFetchEntry, signal);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException('Search token request timed out', 'TimeoutError')), 30000);
    const entry = { controller, consumers: 0, settled: false, promise: null };
    _tokenFetchEntry = entry;
    _tokenFetchPromise = (async () => {
        try {
            const pageResp = await fetchWithProxy(`${JANNY_SITE_BASE}/characters/search`, { signal: controller.signal });
            const html = await pageResp.text();

            let configPath = null;
            const configMatch = html.match(/client-config\.[a-zA-Z0-9_-]+\.js/);
            if (configMatch) {
                configPath = '/_astro/' + configMatch[0];
            } else {
                const spMatch = html.match(/SearchPage\.[a-zA-Z0-9_-]+\.js/);
                if (spMatch) {
                    const spResp = await fetchWithProxy(`${JANNY_SITE_BASE}/_astro/${spMatch[0]}`, { signal: controller.signal });
                    if (spResp.ok) {
                        const spJs = await spResp.text();
                        const impMatch = spJs.match(/client-config\.[a-zA-Z0-9_-]+\.js/);
                        if (impMatch) configPath = '/_astro/' + impMatch[0];
                    }
                }
            }

            if (configPath) {
                const cfgResp = await fetchWithProxy(`${JANNY_SITE_BASE}${configPath}`, { signal: controller.signal });
                if (cfgResp.ok) {
                    const cfgJs = await cfgResp.text();
                    const tokenMatch = cfgJs.match(/"([a-f0-9]{64})"/);
                    if (tokenMatch) {
                        _cachedToken = tokenMatch[1];
                        return _cachedToken;
                    }
                }
            }

            throw new Error('Could not extract MeiliSearch token');
        } catch (e) {
            if (controller.signal.aborted) throw controller.signal.reason;
            console.warn('[JannyAPI] Token fetch failed, using fallback:', e.message);
            _cachedToken = JANNY_FALLBACK_TOKEN;
            return _cachedToken;
        } finally {
            clearTimeout(timeout);
            entry.settled = true;
            if (_tokenFetchEntry === entry) { _tokenFetchEntry = null; _tokenFetchPromise = null; }
        }
    })();
    entry.promise = _tokenFetchPromise;
    entry.promise.catch(() => {});
    return waitForToken(entry, signal);
}

function waitForToken(entry, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    entry.consumers++;
    const consumer = !signal ? entry.promise : new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(signal.reason || new DOMException('Search cancelled', 'AbortError')); };
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        entry.promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
    return consumer.finally(() => {
        entry.consumers--;
        if (!entry.settled && entry.consumers === 0) {
            entry.controller.abort(new DOMException('No active search consumers', 'AbortError'));
            if (_tokenFetchEntry === entry) { _tokenFetchEntry = null; _tokenFetchPromise = null; }
        }
    });
}

// ========================================
// NETWORK & TEXT UTILITIES (shared)
// ========================================

import { fetchWithProxy, readJsonClassified } from '../provider-utils.js';
export { fetchWithProxy };
export { slugify, stripHtml } from '../provider-utils.js';

/**
 * One JannyAI MeiliSearch multi-search request. Callers own their filters, facets and
 * sort; the envelope, auth headers, direct-then-proxy fallback and classified read are
 * shared (the browse view, the provider's lookups, DataCat's Janny sorts and the Creator
 * Downloads adapter all query the same index and drifted into four copies of this before).
 * @param {Object} opts
 * @param {string} [opts.search] - q
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=80] - hitsPerPage
 * @param {string[]} [opts.filters] - MeiliSearch filter expressions
 * @param {string[]} [opts.facets]
 * @param {string[]} [opts.sort] - empty for relevance
 * @param {boolean} [opts.highlight] - add the crop/highlight attributes the browse grids render
 * @returns {Promise<Object>} raw multi-search response ({ results: [...] })
 */
export async function meiliMultiSearch({ search = '', page = 1, limit = 80, filters = [], facets = [], sort = [], highlight = false, signal } = {}) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new DOMException('Search request timed out', 'TimeoutError')), 30000);
    const requestSignal = controller.signal;
    try {
    const query = {
        indexUid: 'janny-characters',
        q: search,
        filter: filters,
        hitsPerPage: limit,
        page,
    };
    if (facets.length) query.facets = facets;
    if (highlight) {
        query.attributesToCrop = ['description:300'];
        query.cropMarker = '...';
        query.attributesToHighlight = ['name', 'description'];
        query.highlightPreTag = '__ais-highlight__';
        query.highlightPostTag = '__/ais-highlight__';
    }
    if (sort.length) query.sort = sort;

    const token = await getSearchToken(requestSignal);
    const headers = {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Origin': JANNY_SITE_BASE,
        'Referer': `${JANNY_SITE_BASE}/`,
        'x-meilisearch-client': 'Meilisearch instant-meilisearch (v0.19.0) ; Meilisearch JavaScript (v0.41.0)',
    };

    const body = JSON.stringify({ queries: [query] });
    let response;
    try {
        response = await fetch(JANNY_SEARCH_URL, { method: 'POST', headers, body, signal: requestSignal });
    } catch (error) {
        requestSignal.throwIfAborted();
        if (error.name === 'AbortError') throw error;
        response = await fetchWithProxy(JANNY_SEARCH_URL, { method: 'POST', headers, body, signal: requestSignal });
    }
    const result = await readJsonClassified(response);
    requestSignal.throwIfAborted();
    return result;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
    }
}

export function resolveTagNames(tagIds) {
    return (tagIds || []).map(id => TAG_MAP[id] || `Tag ${id}`);
}
