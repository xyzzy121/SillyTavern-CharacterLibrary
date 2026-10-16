// Duplicate replacement owns one existing card identity. It never deletes,
// imports, applies remote artwork, or appends a second library entry.
import CoreAPI from '../../core-api.js';
import { getDatacatCharacterId, normalizeDatacatSourceKind, normalizeDefinitionSource } from './datacat-contract.js';

const replacementLocks = new Map();
const DEFINITION_FIELDS = [
    'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'system_prompt', 'post_history_instructions', 'creator_notes', 'creator',
    'character_version', 'tags', 'alternate_greetings', 'nickname', 'group_only_greetings', 'character_book',
];
const PROTECTED_ROOT = ['avatar', 'name', 'fav', 'chat', 'create_date', 'talkativeness', 'spec', 'spec_version'];
const CONFIRMED_ROOT = PROTECTED_ROOT.filter(key => key !== 'talkativeness');
const CONFIRMED_DATA = ['name', ...DEFINITION_FIELDS, 'extensions', 'depth_prompt'];
const copy = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function fail(code, message, details = {}) { return Object.assign(new Error(message), { code, ...details }); }
function checkCancelled(signal) { if (signal?.aborted) throw new DOMException('Replacement cancelled', 'AbortError'); }

/** Capture after duplicate hydration, before showing the confirmation dialog. */
export function captureDatacatReplacementTarget(char) {
    if (!char?.avatar || !char.data || char._slim) throw fail('replacement_not_loaded', 'Load the local character before confirming replacement');
    // Hydrated library refs deliberately omit unknown optional card fields. Only
    // compare fields they actually retain; surgical writes preserve other fields.
    return JSON.stringify(canonical({ data: Object.fromEntries(CONFIRMED_DATA.filter(key => char.data[key] !== undefined).map(key => [key, char.data[key]])),
        root: Object.fromEntries(CONFIRMED_ROOT.filter(key => char[key] !== undefined).map(key => [key, char[key]])) }));
}

async function readTarget(avatar, signal) {
    const response = await CoreAPI.apiRequest('/characters/get', 'POST', { avatar_url: avatar }, { signal });
    if (!response?.ok) throw fail('replacement_read_failed', `Could not read the existing character (HTTP ${response?.status || 'unknown'})`);
    const char = await response.json();
    if (char?.avatar !== avatar || !char.data || typeof char.data.name !== 'string') {
        throw fail('replacement_read_failed', 'The existing character could not be validated');
    }
    return char;
}

function setPath(object, path, value, deleteValue) {
    const keys = path.split('.');
    const leaf = keys.pop();
    let parent = object;
    for (const key of keys) parent = parent[key] ||= {};
    if (value === deleteValue && deleteValue !== null) delete parent[leaf];
    else {
        const next = copy(value);
        const clean = object => {
            if (!object || typeof object !== 'object' || Array.isArray(object)) return;
            for (const key of Object.keys(object)) {
                if (object[key] === deleteValue && deleteValue !== null) delete object[key];
                else clean(object[key]);
            }
        };
        clean(next);
        parent[leaf] = next;
    }
}

const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
function replaceObjectValue(remote, current, deleteValue, path) {
    if (!plainObject(remote)) return copy(remote);
    if (current !== undefined && !plainObject(current)) {
        // Only the root empty-book null has a separately verified preflight.
        if (!(current === null && path === 'character_book')) {
            throw fail('replacement_needs_repair', `The local ${path} has an incompatible value. Repair it before replacing this character`);
        }
    }
    const output = copy(remote);
    for (const [key, value] of Object.entries(remote)) {
        if (plainObject(value)) output[key] = replaceObjectValue(value, current?.[key], deleteValue, `${path}.${key}`);
    }
    for (const key of Object.keys(current || {})) {
        if (!Object.hasOwn(remote, key)) {
            if (key.includes('.') || ['__proto__', 'constructor', 'prototype'].includes(key)) {
                throw fail('replacement_needs_repair', `The local ${path} has a key that cannot safely be removed. Repair it before replacement`);
            }
            output[key] = deleteValue;
        }
    }
    return output;
}

function emptyObjectPreflight(local, acquiredExport, deleteValue) {
    const fields = {};
    const remote = acquiredExport.card.data;
    if (!acquiredExport.card._lorebookUnavailable && local.data.character_book === null && plainObject(remote.character_book)) fields.character_book = deleteValue;
    if (local.data.extensions?.datacat === null) fields['extensions.datacat'] = deleteValue;
    const prompt = remote.extensions?.depth_prompt ?? remote.depth_prompt;
    if (local.data.extensions?.depth_prompt === null && plainObject(prompt)) fields['extensions.depth_prompt'] = deleteValue;
    return fields;
}

/** Build only authored definitions and the new DataCat link, never local settings. */
export function buildDatacatReplacementUpdates(local, acquiredExport, deleteValue, versionUid) {
    const card = acquiredExport?.card;
    const data = card?.data;
    const remote = data?.extensions?.datacat;
    const id = getDatacatCharacterId({ id: remote?.id });
    const sourceKind = normalizeDatacatSourceKind(acquiredExport?.sourceKind || remote?.sourceKind);
    const selection = normalizeDefinitionSource(acquiredExport?.definitionSource ?? remote?.definitionSource);
    if (!id || !sourceKind || !data || typeof data.name !== 'string'
        || normalizeDatacatSourceKind(remote?.sourceKind) !== sourceKind
        || remote?.definitionSource !== selection
        || (sourceKind === 'direct_upload' && selection !== 'source')
        || String(remote?.variantId || '') !== String(acquiredExport?.variantId || '')) {
        throw fail('replacement_invalid_export', 'The selected DataCat export could not be validated');
    }
    if (!deleteValue) throw fail('replacement_unsupported_host', 'Safe replacement requires a SillyTavern version with extension-key deletion support');
    const updates = {};
    for (const namespace of ['datacat', 'depth_prompt']) {
        const value = local.data.extensions?.[namespace];
        if (value !== undefined && value !== null && !plainObject(value)) {
            throw fail('replacement_needs_repair', `The local ${namespace} namespace has an incompatible value. Repair it before replacement`);
        }
    }
    for (const field of DEFINITION_FIELDS) {
        if (!Object.hasOwn(data, field) || data[field] === undefined) continue;
        if (field === 'character_book' && card._lorebookUnavailable) continue;
        if (field === 'character_book' && data[field] !== null
            && (!plainObject(data[field]) || !Array.isArray(data[field].entries))) {
            throw fail('replacement_invalid_export', 'The selected export has an invalid embedded lorebook');
        }
        updates[field] = field === 'tags' ? CoreAPI.applyTagAliases(copy(data[field]))
            : field === 'character_book' ? replaceObjectValue(data[field], local.data[field], deleteValue, field) : copy(data[field]);
    }
    // Remote optional prompt settings belong to the definition; omitted settings
    // and all other extension namespaces remain local.
    const prompt = data.extensions?.depth_prompt ?? data.depth_prompt;
    if (prompt && typeof prompt === 'object') {
        for (const field of ['prompt', 'depth', 'role']) {
            if (!Object.hasOwn(prompt, field)) continue;
            if (prompt[field] !== null && typeof prompt[field] === 'object') throw fail('replacement_invalid_export', 'The selected export has invalid character note settings');
            updates[`extensions.depth_prompt.${field}`] = copy(prompt[field]);
        }
    }
    const namespace = {
        id, sourceKind, definitionSource: selection, variantId: String(acquiredExport.variantId || ''),
        creatorId: remote.creatorId ?? null, creatorName: remote.creatorName ?? null,
        pageName: card._listingName || remote.pageName || data.name,
        linkedAt: new Date().toISOString(),
    };
    if (Object.values(namespace).some(value => value !== null && typeof value === 'object')) {
        throw fail('replacement_invalid_export', 'The selected export has invalid DataCat link metadata');
    }
    for (const [key, value] of Object.entries(namespace)) updates[`extensions.datacat.${key}`] = value;
    for (const key of Object.keys(local.data.extensions?.datacat || {})) {
        if (!Object.hasOwn(namespace, key)) {
            if (/[.]/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) {
                throw fail('replacement_invalid_local_link', 'The local DataCat link needs repair before it can be replaced safely');
            }
            updates[`extensions.datacat.${key}`] = deleteValue;
        }
    }
    if (!local.data.extensions?.version_uid) updates['extensions.version_uid'] = versionUid;
    return updates;
}

/**
 * Failure after a local commit starts always carries outcome + backup identity.
 * A lost write response is reconciled by readback; it is never blindly retried.
 */
export async function replaceDatacatCharacter({ targetAvatar, expectedTarget, acquiredExport, signal, onCommitStart } = {}) {
    if (!targetAvatar || !expectedTarget) throw fail('replacement_missing_target', 'Choose and confirm an existing character to replace');
    if (replacementLocks.has(targetAvatar)) throw fail('replacement_busy', 'This character is already being replaced');
    const lock = {};
    replacementLocks.set(targetAvatar, lock);
    let backup;
    let commitStarted = false;
    try {
        // A preview may select another variant while the mandatory backup is
        // pending. Keep this operation bound to the export that was confirmed.
        const selectedExport = {
            card: acquiredExport?.card ? copy(acquiredExport.card) : null,
            sourceKind: acquiredExport?.sourceKind,
            definitionSource: acquiredExport?.definitionSource,
            variantId: acquiredExport?.variantId,
        };
        checkCancelled(signal);
        const before = await readTarget(targetAvatar, signal);
        if (captureDatacatReplacementTarget(before) !== expectedTarget) throw fail('replacement_stale', 'The local character changed. Review the duplicate and confirm replacement again');
        const deleteValue = await CoreAPI.getExtensionDeleteValue();
        // Validate the selected export before making even a backup write.
        buildDatacatReplacementUpdates(before, selectedExport, deleteValue, before.data.extensions?.version_uid || 'pending');
        const versions = CoreAPI.getModule('character-versions');
        if (!versions?.createVerifiedSnapshot) throw fail('replacement_backup_unavailable', 'Verified replacement backups are unavailable');
        backup = await versions.createVerifiedSnapshot(before, { source: 'replace' });
        checkCancelled(signal);
        let latest = await readTarget(targetAvatar, signal);
        if (captureDatacatReplacementTarget(latest) !== expectedTarget) throw fail('replacement_stale', 'The local character changed while it was backed up. Review it and confirm again');
        // Rebase the existing cached ref to the fresh server state. The surgical
        // writer sends only approved fields and preserves all other server data.
        const cached = CoreAPI.getCharacterByAvatar(targetAvatar);
        if (!cached) throw fail('replacement_stale', 'The target is no longer in the local library');
        if (captureDatacatReplacementTarget(cached) !== expectedTarget) {
            throw fail('replacement_stale', 'The local character has pending changes. Review it before confirming replacement again');
        }
        Object.assign(cached, copy(latest));
        checkCancelled(signal);
        commitStarted = true;
        onCommitStart?.();
        const preflight = emptyObjectPreflight(latest, selectedExport, deleteValue);
        if (Object.keys(preflight).length) {
            const expectedPreflight = copy(latest);
            for (const [field, value] of Object.entries(preflight)) setPath(expectedPreflight.data, field, value, deleteValue);
            // Only semantically empty owned nulls can be removed here. Populated
            // objects are always replaced with sentinels in the one main merge.
            let preflightError;
            try {
                await CoreAPI.writeCardFields(cached, preflight, { surgical: true, extensionCleanupNamespaces: [] });
            } catch (error) { preflightError = error; }
            let checked;
            try { checked = await readTarget(targetAvatar); }
            catch (error) { throw fail('replacement_unknown', 'Could not verify the empty-field preparation. Review this character and its backup before retrying', { outcome: 'unknown', cause: error }); }
            Object.assign(cached, copy(checked));
            if (!equal(checked.data, expectedPreflight.data)
                || PROTECTED_ROOT.some(key => !equal(checked[key], latest[key]))) {
                const unchanged = equal(checked.data, latest.data)
                    && PROTECTED_ROOT.every(key => equal(checked[key], latest[key]));
                throw fail('replacement_preflight_failed', 'Could not verify the empty-field preparation. Review this character before retrying', {
                    outcome: unchanged ? 'unchanged' : 'unknown', cause: preflightError,
                });
            }
            latest = checked;
        }
        const updates = buildDatacatReplacementUpdates(latest, selectedExport, deleteValue, backup.versionUid);
        const expected = copy(latest);
        for (const [field, value] of Object.entries(updates)) setPath(expected.data, field, value, deleteValue);
        let acknowledged = false;
        let writeError;
        try {
            acknowledged = await CoreAPI.applyCardFieldUpdates(targetAvatar, updates, {
                awaitNotify: true, surgical: true, extensionCleanupNamespaces: [],
            });
        } catch (error) { writeError = error; }
        let saved;
        try { saved = await readTarget(targetAvatar); }
        catch (error) {
            throw fail('replacement_unknown', 'The write result could not be verified. Refresh this character before retrying; its backup is available in version history', { cause: error, outcome: 'unknown' });
        }
        // Undo optimistic cache updates even on a false acknowledgement or failed
        // verification. The readback is authoritative, and it is never appended.
        Object.assign(cached, copy(saved));
        if (!equal(saved.data, expected.data)
            || PROTECTED_ROOT.some(key => !equal(saved[key], latest[key]))) {
            const unchanged = captureDatacatReplacementTarget(saved) === captureDatacatReplacementTarget(latest);
            throw fail(unchanged ? 'replacement_not_saved' : 'replacement_unverified',
                unchanged ? 'Replacement was not saved. The existing character is intact; review it before retrying'
                    : 'Replacement could not be fully verified. Review this character and its backup before retrying',
                { outcome: unchanged ? 'unchanged' : 'unknown', acknowledged, cause: writeError });
        }
        if (!acknowledged) {
            // A committed write with a lost response skipped the writer's normal
            // host notification. Resync once after readback establishes success.
            try { await CoreAPI.notifySTCharacterEdited?.(targetAvatar); }
            catch (error) { console.warn('[DatacatReplacement] Verified update; host refresh failed:', error); }
        }
        return { success: true, replaced: true, fileName: targetAvatar,
            characterName: saved.data.name, cardData: saved.data, character: saved,
            providerCharId: saved.data.extensions.datacat.id,
            galleryId: saved.data.extensions.gallery_id || null,
            ...backup, reconciled: !acknowledged };
    } catch (error) {
        if (backup) Object.assign(error, backup);
        if (!error.outcome) error.outcome = commitStarted ? 'unknown' : 'not_started';
        throw error;
    } finally {
        if (replacementLocks.get(targetAvatar) === lock) replacementLocks.delete(targetAvatar);
    }
}
