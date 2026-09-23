// DataCat Provider - implementation for datacat.run character source
//
// DataCat aggregates JanitorAI characters with its own REST API layer
// and AI-powered character scoring. Uses ella.janitorai.com CDN for images.
// Browsing uses a helper session; gated exports use Datacat's browser verification.

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng, fetchWithProxy } from '../provider-utils.js';
import datacatBrowseView from './datacat-browse.js';
import { initJanitorBridge } from '../janitor-bridge.js';
import './datacat-avatar-restore.js';
import { acquireDatacatExport } from './datacat-export.js';
import { closeDatacatExportPanel } from './datacat-export-bridge.js';
import {
    getDatacatCharacterId, getDatacatSourceKind, normalizeDatacatSourceKind,
    normalizeDefinitionSource, parseDatacatUrl, buildDatacatUrl,
    matchRetrievalStatus, isRetrievalShortcut,
} from './datacat-contract.js';
import {
    resolveDatacatAvatarUrl,
    setApiRequest,
    setSavedTokenGetter,
    slugify,
    fetchDatacatCharacter,
    validateDcSession,
    clearDcSession,
    initDcSession,
    checkDcPluginAvailable,
    buildV2FromDatacat,
    hasUnfetchedLorebook,
    submitExtraction,
    fetchExtractionStatus,
    parseJanitoraiSession,
    janitoraiRefreshGrant,
    janitoraiVerifyToken,
    decodeJanitoraiClaims,
} from './datacat-api.js';

let api = null;

// ========================================
// PROVIDER CLASS
// ========================================

class DatacatProvider extends ProviderBase {
    // ── Identity ────────────────────────────────────────────

    get id() { return 'datacat'; }
    get name() { return 'DataCat'; }
    get icon() { return 'fa-solid fa-cat'; }
    get iconUrl() { return 'https://datacat.run/catgif.gif'; }
    get beta() { return true; }
    get enableWarning() { return 'Datacat is experimental. Browsing requires cl-helper 1.13.0; some downloads require the optional Datacat companion userscript and human verification.'; }
    get disabledByDefault() { return true; }
    get minClHelperVersion() { return '1.13.0'; }
    get browseView() { return datacatBrowseView; }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-comments', label: 'Chats' },
            stat2: { icon: 'fa-solid fa-envelope', label: 'Messages' },
            stat3: null,
        };
    }

    // ── Lifecycle ───────────────────────────────────────────

    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
        setApiRequest(coreAPI.apiRequest);
        setSavedTokenGetter(() => coreAPI.getSetting('datacatToken') || null);
        // Listen for the optional JanitorAI userscript bridge (passive, free when absent)
        initJanitorBridge();
    }

    // ── View ────────────────────────────────────────────────

    get hasView() { return true; }

    renderFilterBar() { return datacatBrowseView.renderFilterBar(); }
    renderView() { return datacatBrowseView.renderView(); }
    renderModals() { return datacatBrowseView.renderModals(); }

    async activate(container, options = {}) {
        datacatBrowseView.activate(container, options);
    }

    deactivate() {
        datacatBrowseView.deactivate();
    }

    // ── Character Linking ───────────────────────────────────

    getLinkInfo(char) {
        if (!char) return null;
        const extensions = char.data?.extensions || char.extensions;
        const dc = extensions?.datacat;
        if (!dc) return null;

        const id = getDatacatCharacterId({ id: dc.id });
        if (!id) return null;

        return {
            providerId: 'datacat',
            id,
            fullPath: String(id),
            sourceKind: normalizeDatacatSourceKind(dc.sourceKind),
            definitionSource: normalizeDefinitionSource(dc.definitionSource),
            variantId: dc.variantId || '',
            linkedAt: dc.linkedAt || null
        };
    }

    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = { ...char.extensions };

        if (linkInfo) {
            const existing = char.data.extensions.datacat || {};
            char.data.extensions.datacat = {
                ...existing,
                id: linkInfo.id,
                sourceKind: normalizeDatacatSourceKind(linkInfo.sourceKind || existing.sourceKind),
                definitionSource: normalizeDefinitionSource(linkInfo.definitionSource ?? existing.definitionSource),
                variantId: linkInfo.variantId ?? existing.variantId ?? '',
                linkedAt: linkInfo.linkedAt || existing.linkedAt || new Date().toISOString(),
                pageName: linkInfo.pageName || existing.pageName || null,
            };
        } else {
            delete char.data.extensions.datacat;
        }
    }

    // ── Link Stats ───────────────────────────────────────────

    async fetchLinkStats(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const character = await fetchDatacatCharacter(linkInfo.id, linkInfo.sourceKind || null);
            if (!character) return null;

            api?.debugLog?.('[DatacatProvider] fetchLinkStats raw keys:', Object.keys(character).join(', '));
            api?.debugLog?.('[DatacatProvider] chatCount:', character.chatCount, 'chat_count:', character.chat_count, 'stats:', JSON.stringify(character.stats));

            const chats = parseInt(character.chatCount || character.chat_count || character.stats?.chat, 10) || 0;
            const messages = parseInt(character.messageCount || character.message_count || character.stats?.message, 10) || 0;
            return { stat1: chats, stat2: messages, stat3: null };
        } catch (e) {
            api?.debugLog?.('[DatacatProvider] fetchLinkStats:', e.message);
            return null;
        }
    }

    // ── Remote Data ─────────────────────────────────────────

    async fetchMetadata(characterId) {
        const char = await fetchDatacatCharacter(characterId);
        if (!char) return null;
        // Normalize: library.js reads metadata.id as the link identifier.
        // DataCat API returns numeric auto-increment as `id` and UUID as `character_id`.
        // URLs and all API calls use the UUID, so expose it as `id`.
        return char ? { ...char, id: getDatacatCharacterId(char), sourceKind: getDatacatSourceKind(char) } : null;
    }

    async fetchRemoteCard(linkInfo, options = {}) {
        if (!linkInfo?.id) return null;
        try {
            const exported = await acquireDatacatExport(linkInfo.id, {
                ...linkInfo, ...options, interactive: options.interactive === true,
            });
            return exported.card;
        } catch (e) {
            if (e.code === 'not_found') return null;
            throw e;
        }
    }

    normalizeRemoteCard(rawData) {
        if (rawData?.spec === 'chara_card_v2') return rawData;
        const card = buildV2FromDatacat(rawData);
        if (card && hasUnfetchedLorebook(rawData)) card._lorebookUnavailable = true;
        return card;
    }

    async fetchLorebook(linkInfo) {
        if (!linkInfo?.id) return null;
        const card = await this.fetchRemoteCard(linkInfo);
        return card?.data?.character_book || null;
    }

    async refreshRemoteData(linkInfo, options = {}) {
        if (!linkInfo?.id) return;
        if (CoreAPI.getSetting('datacatReextractOnUpdate') !== true) return;

        const signal = options?.signal;
        const checkCancelled = () => {
            if (signal?.aborted) throw new DOMException('Datacat retrieval cancelled', 'AbortError');
        };
        const report = (message) => { if (!signal?.aborted) options.onStatus?.(message); };

        try {
            checkCancelled();
            report?.('Checking cl-helper plugin...');
            const pluginOk = await checkDcPluginAvailable();
            checkCancelled();
            if (!pluginOk) {
                api?.debugLog?.('[DatacatProvider] refreshRemoteData: cl-helper not available, skipping re-extraction');
                return;
            }

            report?.('Validating DataCat session...');
            const sessionOk = await validateDcSession();
            checkCancelled();
            if (!sessionOk.valid) {
                api?.debugLog?.('[DatacatProvider] refreshRemoteData: no active DataCat session, skipping re-extraction');
                return;
            }

            // Backfill from probe for older cards; the post-extract fetch will persist via buildV2*.
            let sourceKind = normalizeDatacatSourceKind(linkInfo.sourceKind);
            if (!sourceKind) {
                const probe = await fetchDatacatCharacter(linkInfo.id, null, { signal });
                checkCancelled();
                sourceKind = getDatacatSourceKind(probe);
            }
            if (sourceKind === 'direct_upload') return;

            const upstreamUrl = sourceKind === 'saucepan'
                ? `https://saucepan.ai/companion/${linkInfo.id}`
                : `https://janitorai.com/characters/${linkInfo.id}`;
            const publicFeed = CoreAPI.getSetting('datacatPublicFeed') === true;

            checkCancelled();
            report?.('Submitting retrieval request...');
            const submittedAt = Date.now();
            const result = await submitExtraction(upstreamUrl, { publicFeed, alwaysReextract: true, signal });
            checkCancelled();
            if (!result?.success && !result?.queued && !result?.started) {
                api?.debugLog?.('[DatacatProvider] refreshRemoteData: extraction submit failed:', result?.error);
                return;
            }

            const submitRequestId = result?.requestId || null;
            if (isRetrievalShortcut(result)) {
                report?.('Character is already available');
                return;
            }

            if (result?.queued) {
                const pos = result.queuePosition ? ` (position ${result.queuePosition})` : '';
                report?.(`Queued for retrieval${pos}...`);
            } else {
                report?.('Retrieval started...');
            }

            const POLL_INTERVAL = 3000;
            const MAX_POLLS = 60;
            for (let i = 0; i < MAX_POLLS; i++) {
                if (signal?.aborted) return;
                await new Promise(r => setTimeout(r, POLL_INTERVAL));
                if (signal?.aborted) return;
                const status = await fetchExtractionStatus({ signal });
                checkCancelled();
                if (!status) continue;

                const done = matchRetrievalStatus(status, { requestId: submitRequestId, characterId: linkInfo.id, submittedAt });
                if (done) {
                    report?.(done.success === false ? (done.message || done.error || 'Retrieval failed; using the available export') : 'Retrieval complete');
                    api?.debugLog?.('[DatacatProvider] refreshRemoteData: re-extraction complete for', linkInfo.id);
                    return;
                }

                if (status.inProgress && (submitRequestId ? status.inProgress.requestId === submitRequestId : getDatacatCharacterId(status.inProgress) === linkInfo.id)) {
                    const phase = status.inProgress.status;
                    const PHASE_LABELS = {
                        opening_page: 'Opening page',
                        preparing: 'Preparing',
                        initiating: 'Initiating',
                        pulling: 'Pulling data',
                        post_extract: 'Finalizing',
                        complete: 'Completing',
                    };
                    report?.(PHASE_LABELS[phase] || `Retrieving (${phase})...`);
                }
            }
            report?.('Retrieval timed out, using the available export');
            api?.debugLog?.('[DatacatProvider] refreshRemoteData: re-extraction timed out after', MAX_POLLS * POLL_INTERVAL / 1000, 'seconds');
        } catch (err) {
            if (err.name === 'AbortError' || signal?.aborted) return;
            console.error('[DatacatProvider] refreshRemoteData failed, continuing with cached data:', err);
        }
    }

    // ── Update Checking ─────────────────────────────────────

    getComparableFields() {
        return [];
    }

    // ── Version History ─────────────────────────────────────

    get supportsVersionHistory() { return false; }

    // ── Gallery ──────────────────────────────────────────────

    // JanitorAI cards have no galleries at all, and the only gallery DataCat ever exposed came
    // from saucepan-sourced rows, which now belong to the standalone Saucepan provider. Declaring
    // false keeps DataCat-linked characters out of the gallery button, the bulk gallery scans and
    // the auto-download-after-import path, instead of walking them to always find nothing. The
    // browse preview's portrait grid is unaffected: that is display, not the download surface.
    get supportsGallery() { return false; }

    // ── Character URL / Link UI ─────────────────────────────

    getCharacterUrl(linkInfo) {
        if (!linkInfo?.id) return null;
        return buildDatacatUrl(linkInfo.id, linkInfo.sourceKind);
    }

    openLinkUI(char) {
        CoreAPI.openProviderLinkModal?.(char);
    }

    // ── In-App Preview ───────────────────────────────────────

    get supportsInAppPreview() { return true; }

    async buildPreviewObject(char, linkInfo) {
        const charId = linkInfo?.id;
        if (!charId) return null;

        try {
            const character = await fetchDatacatCharacter(charId, linkInfo.sourceKind || null);
            if (!character) return null;

            const preview = {
                id: character.character_id || character.characterId,
                name: character.name,
                chat_name: character.chat_name,
                description: character.description,
                avatar: character.avatar,
                tags: character.tags || [],
                custom_tags: character.custom_tags || [],
                is_nsfw: character.is_nsfw,
                creator_id: character.creator_id,
                creator_name: character.creator_name,
                created_at: character.created_at,
                chat_count: character.chat_count ?? character.chatCount ?? character.stats?.chat,
                message_count: character.message_count ?? character.messageCount ?? character.stats?.message,
                primary_content_source_kind: character.primary_content_source_kind || null,
                definitionSource: normalizeDefinitionSource(linkInfo.definitionSource),
                variantId: linkInfo.variantId || '',
            };
            // Full row rides along so the preview skips its refetch and keeps the right source kind.
            preview._fullCharacter = character;
            return preview;
        } catch (e) {
            console.warn('[DatacatProvider] buildPreviewObject failed:', e.message);
        }

        // Fallback to local data
        const dcData = char?.data?.extensions?.datacat || {};
        return {
            id: charId,
            name: char?.name || 'Unknown',
            description: char?.data?.description || '',
            avatar: dcData.avatar || '',
            tags: [],
            is_nsfw: false,
            creator_name: char?.data?.creator || ''
        };
    }

    openPreview(previewChar) {
        window.openDatacatCharPreview?.(previewChar);
    }

    // ── Local Import Enrichment ──────────────────────────────

    async enrichLocalImport(cardData, _fileName) {
        const ext = cardData.data?.extensions?.datacat;
        if (ext?.id) {
            return {
                cardData,
                providerInfo: {
                    providerId: 'datacat',
                    charId: ext.id,
                    fullPath: String(ext.id),
                    hasGallery: false,
                    avatarUrl: null
                }
            };
        }

        // No datacat extensions - cannot auto-enrich without a search API
        return null;
    }

    // ── Authentication ──────────────────────────────────────

    get hasAuth() { return false; }
    getAuthHeaders() { return {}; }

    // ── URL Handling ────────────────────────────────────────

    canHandleUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            return /^(www\.)?datacat\.run$/i.test(u.hostname);
        } catch {
            return false;
        }
    }

    parseUrl(url) {
        return parseDatacatUrl(url)?.id || null;
    }

    // ── Import Pipeline ─────────────────────────────────────

    get supportsImport() { return true; }

    /**
     * Import a character from DataCat.
     * @param {string} identifier - character UUID
     * @param {Object} [hitData] - Optional pre-fetched character data
     */
    async importCharacter(identifier, hitData, options = {}) {
        try {
            const parsed = parseDatacatUrl(options.sourceUrl || String(identifier));
            const charId = parsed?.id || getDatacatCharacterId({ id: String(identifier) });
            if (!charId) throw new Error('Invalid Datacat character ID');
            const definitionSource = normalizeDefinitionSource(options.definitionSource ?? hitData?.definitionSource);
            const variantId = options.variantId ?? hitData?.variantId ?? '';
            const sourceKind = normalizeDatacatSourceKind(options.sourceKind || parsed?.sourceKind)
                || getDatacatSourceKind(hitData?._fullCharacter || hitData, null);
            let exported = options.acquiredExport;
            const existingLink = exported?.card?.data?.extensions?.datacat;
            if (!existingLink || existingLink.id !== charId || exported.definitionSource !== definitionSource
                || String(exported.variantId || '') !== String(variantId)
                || (sourceKind && exported.sourceKind !== sourceKind)) {
                exported = await acquireDatacatExport(charId, {
                    character: hitData, sourceKind, definitionSource, variantId,
                    interactive: options.interactive !== false, signal: options.signal,
                    onStatus: options.onStatus || options.onProgress, reusePanel: options.reusePanel === true,
                });
            }
            if (options.signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
            // Import mutates tags/gallery fields; keep a preview's reusable export untouched.
            const characterCard = structuredClone(exported.card);
            const character = exported.character || hitData?._fullCharacter || hitData;
            const characterName = characterCard.data.name || 'Unnamed';
            characterCard.data.extensions.datacat = {
                ...characterCard.data.extensions.datacat,
                pageName: this.getListingName(character) || characterCard.data.extensions.datacat.pageName || characterName,
                linkedAt: new Date().toISOString(),
            };
            assignGalleryId(characterCard, options, api);
            const avatarUrl = resolveDatacatAvatarUrl(character, { preferOriginal: true });
            let imageBuffer = exported.imageBuffer || null;
            if (!imageBuffer && avatarUrl) {
                try {
                    const response = await fetchWithProxy(avatarUrl);
                    if (response.ok) imageBuffer = await response.arrayBuffer();
                } catch (error) {
                    console.warn('[DatacatProvider] Avatar download failed:', error.message);
                }
            }
            if (options.signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
            return await importFromPng({
                characterCard, imageBuffer,
                fileName: 'datacat_' + slugify(characterName) + '.png',
                characterName, hasGallery: false, providerCharId: charId,
                fullPath: charId, avatarUrl: avatarUrl || null, api,
            });
        } catch (error) {
            if (error.name !== 'AbortError') console.error('[DatacatProvider] importCharacter failed:', identifier, error);
            return { success: false, error: error.message, code: error.code, cancelled: error.name === 'AbortError', panelClosed: error.panelClosed === true };
        }
    }

    // ── Settings ────────────────────────────────────────────

    finishImportBatch() { closeDatacatExportPanel(); }

    getSettings() {
        return [];
    }

    // ── Bulk Linking ────────────────────────────────────────

    get supportsBulkLink() { return false; }
}

const datacatProvider = new DatacatProvider();
export default datacatProvider;

// Window-exposed session management (called by settings panel in library.js)
window.datacatValidateSession = async () => {
    const pluginOk = await checkDcPluginAvailable();
    if (!pluginOk) return { valid: false, reason: 'cl-helper plugin not available' };
    return validateDcSession();
};

window.datacatRefreshToken = async () => {
    const pluginOk = await checkDcPluginAvailable();
    if (!pluginOk) return null;
    return initDcSession(null, true);
};

window.datacatClearSession = async () => {
    return clearDcSession();
};

// ── JanitorAI account session (Supabase; unlocks Hampter pagination) ──────────
// Stateful layer over the pure grant helpers: persists the access token + rotating
// refresh token in settings, refreshes proactively, and shares one in-flight refresh
// so concurrent Hampter loads cant race the single-use refresh token.
let _janitoraiRefreshInFlight = null;

async function janitoraiDoRefresh() {
    if (_janitoraiRefreshInFlight) return _janitoraiRefreshInFlight;
    _janitoraiRefreshInFlight = (async () => {
        const rt = CoreAPI.getSetting('datacatJanitoraiRefreshToken');
        const res = await janitoraiRefreshGrant(rt);
        if (res.access_token) {
            CoreAPI.setSetting('datacatJanitoraiToken', res.access_token);
            if (res.refresh_token) CoreAPI.setSetting('datacatJanitoraiRefreshToken', res.refresh_token);
            return res.access_token;
        }
        // Only wipe the stored session when the refresh token is definitively dead,
        // never on a transient network blip (keeps the user logged in across hiccups).
        if (res.dead) {
            CoreAPI.setSetting('datacatJanitoraiToken', null);
            CoreAPI.setSetting('datacatJanitoraiRefreshToken', null);
        }
        return '';
    })();
    try { return await _janitoraiRefreshInFlight; }
    finally { _janitoraiRefreshInFlight = null; }
}

// Current valid access token, refreshing within 2min of expiry. '' when logged out / refresh failed.
window.datacatJanitoraiGetToken = async () => {
    const tok = CoreAPI.getSetting('datacatJanitoraiToken') || '';
    if (!tok) return '';
    const { expMs } = decodeJanitoraiClaims(tok);
    if (expMs && expMs - Date.now() > 120000) return tok;
    return (await janitoraiDoRefresh()) || '';
};

// Force a refresh (reactive path after an unexpected 401). Returns the new token or ''.
window.datacatJanitoraiForceRefresh = async () => janitoraiDoRefresh();

// Seed the session from a pasted sb-auth-auth-token cookie (or session JSON / bare JWT).
// Verification stays off Cloudflare-gated hampter: its preflight can 403 on a perfectly
// good token, and failing after the up-front rotation would strand the fresh pair.
window.datacatJanitoraiSetSession = async (pasted) => {
    const pair = parseJanitoraiSession(pasted);
    if (!pair) return { ok: false, error: 'Could not find a session in that value. Copy the whole sb-auth-auth-token cookie.' };
    const { email, expMs } = decodeJanitoraiClaims(pair.access_token);
    let token = pair.access_token;
    // If the pasted access token is already stale but a refresh token came with it, rotate up front.
    if ((!expMs || expMs - Date.now() < 120000) && pair.refresh_token) {
        const r = await janitoraiRefreshGrant(pair.refresh_token);
        if (!r.access_token) {
            return { ok: false, error: r.dead
                ? 'That session is expired or invalid. Copy a fresh cookie after logging in again.'
                : 'Could not reach the JanitorAI auth service. Try again in a moment.' };
        }
        // A successful grant is itself the proof; the rotation consumed the single-use pasted
        // token, so proceed straight to persist.
        token = r.access_token;
        pair.refresh_token = r.refresh_token;
    } else {
        // No rotation ran, nothing consumed yet: confirm the pasted token before storing.
        const v = await janitoraiVerifyToken(token);
        if (!v.valid) {
            return { ok: false, error: v.transient
                ? 'Could not reach the JanitorAI auth service. Try again in a moment.'
                : 'That session is expired or invalid. Copy a fresh cookie after logging in again.' };
        }
    }
    CoreAPI.setSetting('datacatJanitoraiToken', token);
    CoreAPI.setSetting('datacatJanitoraiRefreshToken', pair.refresh_token || null);
    return { ok: true, email: decodeJanitoraiClaims(token).email || email, hasRefresh: !!pair.refresh_token };
};

window.datacatJanitoraiLogout = () => {
    CoreAPI.setSetting('datacatJanitoraiToken', null);
    CoreAPI.setSetting('datacatJanitoraiRefreshToken', null);
};

window.datacatJanitoraiSessionStatus = () => {
    const tok = CoreAPI.getSetting('datacatJanitoraiToken') || '';
    if (!tok) return { loggedIn: false };
    const { email, expMs } = decodeJanitoraiClaims(tok);
    return { loggedIn: true, email, expMs, hasRefresh: !!CoreAPI.getSetting('datacatJanitoraiRefreshToken') };
};
