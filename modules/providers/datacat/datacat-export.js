// A single, authoritative export path for imports and linked-card comparisons.
import {
    fetchDatacatCharacter, fetchDatacatDownload, buildV2FromDownload,
    hydrateDatacatScripts, hasUnfetchedLorebook,
} from './datacat-api.js';
import {
    DatacatError, getDatacatCharacterId, getDatacatSourceKind,
    normalizeDatacatSourceKind, normalizeDefinitionSource, getDatacatDefinitionOptions,
} from './datacat-contract.js';
import { requestDatacatBrowserExport } from './datacat-export-bridge.js';

function checkCancelled(signal) {
    if (signal?.aborted) throw new DOMException('Datacat export cancelled', 'AbortError');
}

function variantContent(variant) {
    let content = variant?.content;
    if (typeof content === 'string') {
        try { content = JSON.parse(content); } catch { return null; }
    }
    return content && typeof content === 'object' && !Array.isArray(content) ? content : null;
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
    // Feed summaries can carry empty/partial versions of detail fields. Only the
    // explicit detail handoff proves that the caller has already fetched metadata.
    let character = supplied?._fullCharacter || null;
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
    const metadataId = getDatacatCharacterId(character);
    const metadataSource = getDatacatSourceKind(character, null);
    if ((metadataId && metadataId !== id) || (sourceKind && metadataSource && sourceKind !== metadataSource)) {
        throw new DatacatError('Datacat returned metadata for a different character or source', { code: 'invalid_response' });
    }
    sourceKind = sourceKind || metadataSource;
    let selectedVariant = null;
    if (character) {
        const available = getDatacatDefinitionOptions(character);
        if (!available[definitionSource]) {
            throw new DatacatError(`The selected ${definitionSource === 'source' ? 'Source' : 'Reimagination'} definition is unavailable. Open the Datacat preview to choose an available definition.`, { code: 'selection_unavailable' });
        }
        if (variantId && Array.isArray(character.content_variants)) {
            // A top-level Reimagination may belong to an ordinary source variant;
            // it need not be duplicated inside that variant's content object.
            selectedVariant = character.content_variants.find(variant => String(variant?.id || variant?.variantId || '') === String(variantId));
            if (!selectedVariant) {
                throw new DatacatError('The selected Datacat variant is no longer available. Open the Datacat preview to choose an available version.', { code: 'selection_unavailable' });
            }
            if (definitionSource === 'reimagination'
                && !available.variants.some(variant => String(variant.id || '') === String(variantId))
                && !getDatacatDefinitionOptions({ ...character, content_variants: [] }).reimagination) {
                throw new DatacatError('Reimagination is unavailable for the selected Datacat variant. Open the Datacat preview to choose an available version.', { code: 'selection_unavailable' });
            }
        }
    }
    let download;
    let imageBuffer = null;
    try {
        onStatus?.('Fetching Datacat export...');
        download = await fetchDatacatDownload(id, sourceKind, { definitionSource, variantId, signal });
        if (!download) throw new DatacatError('Character export is unavailable on Datacat', { code: 'not_found', status: 404 });
        // Explicit direct-response selection must agree before enrichment can stamp
        // link metadata. Native PNGs instead bind selection through the companion.
        const returnedSelection = download.data?.extensions?.datacat;
        if (returnedSelection?.definitionSource && returnedSelection.definitionSource !== definitionSource
            || variantId && returnedSelection?.variantId != null && String(returnedSelection.variantId) !== String(variantId)) {
            throw new DatacatError('Datacat returned a different definition or variant selection', { code: 'invalid_response' });
        }
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
    let enrichmentCharacter = character;
    let variantLorebookUnavailable = false;
    if (definitionSource === 'source' && variantId) {
        const content = variantContent(selectedVariant);
        if (content && Object.hasOwn(content, 'scripts')) {
            enrichmentCharacter = { ...character, scripts: content.scripts };
        } else if (!selectedVariant?.isPrimary && !selectedVariant?.is_primary) {
            // The row's scripts belong to its primary definition. A different
            // selected variant must not inherit that book when its export omits it.
            enrichmentCharacter = { ...character, scripts: undefined };
            variantLorebookUnavailable = true;
        }
    }
    if (enrichmentCharacter && definitionSource === 'source' && !hasExportedLorebook) {
        await hydrateDatacatScripts(enrichmentCharacter, { signal });
    }
    checkCancelled(signal);
    const card = buildV2FromDownload(download, enrichmentCharacter, { id, sourceKind, definitionSource, variantId });
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
    if (!hasExportedLorebook && (definitionSource === 'source' && (variantLorebookUnavailable || hasUnfetchedLorebook(enrichmentCharacter))
        || (!card.data.character_book && (metadataUnavailable || !character)))) {
        card._lorebookUnavailable = true;
    }
    return { card, imageBuffer, definitionSource, sourceKind: card.data.extensions.datacat.sourceKind, variantId: String(variantId || ''), character };
}
