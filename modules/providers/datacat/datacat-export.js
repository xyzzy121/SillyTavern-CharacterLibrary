// A single, authoritative export path for imports and linked-card comparisons.
import {
    fetchDatacatCharacter, fetchDatacatDownload, buildV2FromDownload,
    hydrateDatacatScripts, hasUnfetchedLorebook,
} from './datacat-api.js';
import {
    DatacatError, getDatacatCharacterId, getDatacatSourceKind,
    normalizeDatacatSourceKind, normalizeDefinitionSource,
} from './datacat-contract.js';
import { requestDatacatBrowserExport } from './datacat-export-bridge.js';

function checkCancelled(signal) {
    if (signal?.aborted) throw new DOMException('Datacat export cancelled', 'AbortError');
}

/**
 * Metadata enriches a successful export; it can never replace a denied export.
 * Browser verification happens in Datacat's own session and returns a card,
 * rather than transferring credentials or unlocking the helper's session.
 */
export async function acquireDatacatExport(characterId, options = {}) {
    const id = getDatacatCharacterId({ character_id: characterId });
    if (!id) throw new DatacatError('Invalid Datacat character ID', { code: 'invalid_request' });
    const {
        definitionSource: requestedDefinition = 'source', variantId = '',
        interactive = false, signal, onStatus, reusePanel = false,
    } = options;
    const definitionSource = normalizeDefinitionSource(requestedDefinition);
    checkCancelled(signal);
    const supplied = options.character;
    let character = supplied?._fullCharacter || (supplied && (
        supplied.chara_card_v2_json || Array.isArray(supplied.content_variants)
        || Array.isArray(supplied.scripts) || Object.hasOwn(supplied, 'personality')
    ) ? supplied : null);
    let sourceKind = normalizeDatacatSourceKind(options.sourceKind)
        || getDatacatSourceKind(character || options.character, null);
    let metadataUnavailable = false;
    if (!character) {
        try {
            character = await fetchDatacatCharacter(id, sourceKind, { signal });
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            // A valid export can still carry all the content when metadata is unavailable.
            metadataUnavailable = true;
        }
    }
    checkCancelled(signal);
    sourceKind = sourceKind || getDatacatSourceKind(character, null);
    let download;
    let imageBuffer = null;
    try {
        onStatus?.('Fetching Datacat export...');
        download = await fetchDatacatDownload(id, sourceKind, { definitionSource, variantId, signal });
        if (!download) throw new DatacatError('Character export is unavailable on Datacat', { code: 'not_found', status: 404 });
    } catch (error) {
        checkCancelled(signal);
        if (error.code !== 'verification_required' || !interactive) throw error;
        const exported = await requestDatacatBrowserExport({
            characterId: id, sourceKind, definitionSource, variantId,
            characterName: character?.name || options.character?.name || '',
            creatorName: character?.creator_name || character?.creatorName || '',
            signal, onStatus, reusePanel,
        });
        checkCancelled(signal);
        if (exported.definitionSource !== definitionSource) {
            throw new DatacatError('Datacat returned a different definition selection', { code: 'invalid_response' });
        }
        download = exported.card;
        imageBuffer = exported.imageBuffer;
    }
    checkCancelled(signal);
    const downloadedId = getDatacatCharacterId(download);
    if (downloadedId && downloadedId !== id) {
        throw new DatacatError('Datacat returned a different character', { code: 'invalid_response' });
    }
    sourceKind = sourceKind || getDatacatSourceKind(download?.data?.extensions?.datacat, null);
    const hasExportedLorebook = Object.hasOwn(download?.data || download || {}, 'character_book');
    if (character && definitionSource === 'source' && !hasExportedLorebook) {
        await hydrateDatacatScripts(character, { signal });
    }
    checkCancelled(signal);
    const card = buildV2FromDownload(download, character, { id, sourceKind, definitionSource, variantId });
    if (!card?.data || typeof card.data.name !== 'string') {
        throw new DatacatError('Datacat returned an invalid character card', { code: 'invalid_response' });
    }
    const existing = card.data.extensions?.datacat || {};
    const returnedId = getDatacatCharacterId({ character_id: existing.id });
    if (returnedId && returnedId !== id) {
        throw new DatacatError('Datacat returned a different character', { code: 'invalid_response' });
    }
    card.data.extensions = {
        ...card.data.extensions,
        datacat: {
            ...existing, id,
            sourceKind: sourceKind || normalizeDatacatSourceKind(existing.sourceKind) || 'janitor',
            definitionSource, variantId: String(variantId || ''),
            creatorId: character?.creator_id || character?.creatorId || existing.creatorId || null,
            creatorName: character?.creator_name || character?.creatorName || existing.creatorName || null,
        },
    };
    card._listingName = character?.name || existing.pageName || null;
    // Unknown lorebook data must not be compared as a deletion.
    if (!hasExportedLorebook && (hasUnfetchedLorebook(character)
        || (!card.data.character_book && (metadataUnavailable || !character)))) {
        card._lorebookUnavailable = true;
    }
    return { card, imageBuffer, definitionSource, sourceKind: card.data.extensions.datacat.sourceKind, variantId: String(variantId || ''), character };
}
