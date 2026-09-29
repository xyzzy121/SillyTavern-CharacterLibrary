// Pure DataCat boundary contract. Shared by the provider and fixture tests.
const ORIGIN = 'https://datacat.run';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const objectValue = value => {
    if (value && typeof value === 'object') return value;
    if (typeof value === 'string') { try { return JSON.parse(value); } catch { /* unavailable */ } }
    return null;
};

export function normalizeDatacatSourceKind(value) {
    const source = String(value || '').toLowerCase().replace(/-/g, '_');
    if (['janitor', 'janitor_core', 'janitorai', 'janny', 'jannyai'].includes(source)) return 'janitor';
    if (['sauce', 'saucepan', 'companion'].includes(source)) return 'saucepan';
    if (['direct', 'direct_upload', 'upload', 'private_vault', 'privatevault', 'vault'].includes(source)) return 'direct_upload';
    return null;
}

export function getDatacatSourceKind(row, fallback = 'janitor') {
    if (!row) return normalizeDatacatSourceKind(fallback);
    const v2 = objectValue(row.chara_card_v2_json || row.charaCardV2Json);
    // Native uploads can retain the source card's stale Janitor metadata.
    if (objectValue(row.stats)?.direct_upload || objectValue(row.intercepted_chat_data || row.interceptedChatData)?.direct_upload
        || normalizeDatacatSourceKind(v2?.data?.extensions?.datacat?.source) === 'direct_upload') return 'direct_upload';
    const explicit = normalizeDatacatSourceKind(row.primary_content_source_kind || row.primaryContentSourceKind || row.characterSourceKind
        || row.sourceKind || row.source_kind || row.source || v2?.data?.extensions?.datacat?.source);
    if (explicit) return explicit;
    return normalizeDatacatSourceKind(fallback);
}

export function getDatacatCharacterId(row) {
    const embedded = objectValue(row?.chara_card_v2_json || row?.charaCardV2Json);
    const values = typeof row === 'string' ? [row] : [row?.character_id, row?.characterId, row?.id,
        row?.data?.extensions?.datacat?.id, embedded?.data?.extensions?.datacat?.id];
    return values.find(value => typeof value === 'string' && UUID.test(value))?.toLowerCase() || '';
}

export function normalizeDefinitionSource(value) {
    return value === 'reimagination' ? 'reimagination' : 'source';
}

export function getDatacatDefinitionOptions(character) {
    const hasReimagination = record => {
        const reimag = objectValue(record?.datacat_reimagination || record?.datacatReimagination);
        return record?.has_datacat_reimagination === true || record?.hasDatacatReimagination === true
            || String(record?.recovery_badge_text || record?.recoveryBadgeText || '').trim().toUpperCase() === 'REIMAGINED'
            || !!(reimag?.outputText || reimag?.output_text || reimag?.interpretation
                || reimag?.contentHash || reimag?.content_hash || reimag?.generatedAt || reimag?.generated_at
                || reimag?.modelUsed || reimag?.model_used);
    };
    // Current Datacat attaches Reimagination to source variants such as janitor_core.
    // Its existence cannot be inferred from the variant's source name alone.
    const variants = (Array.isArray(character?.content_variants) ? character.content_variants : [])
        .filter(variant => variant && !variant.isRecoveryPlaceholder && !variant.is_recovery_placeholder
            && (hasReimagination(variant) || hasReimagination(objectValue(variant.content))
                || /reimagin/i.test(String(variant.sourceKind || variant.source_kind || variant.kind || variant.type || variant.id || ''))))
        .map(variant => ({ ...variant, id: variant.id || variant.variantId,
            name: variant.name || variant.label || variant.sourceLabel || variant.source_label || 'Reimagination' }));
    return { source: character?.has_source_definition !== false && character?.sourceDefinitionAvailable !== false,
        reimagination: getDatacatSourceKind(character, null) !== 'direct_upload'
            && !!(hasReimagination(character) || variants.length),
        variants };
}

export function parseDatacatUrl(value) {
    try {
        const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
        if (!/^(www\.)?datacat\.run$/i.test(url.hostname)) return null;
        const parts = url.pathname.split('/').filter(Boolean);
        const views = ['recent', 'recent2', 'recent_v1', 'mine', 'mine2', 'mine_v1', 'yours', 'vault', 'cart', 'basket'];
        if (!['characters', 'character', ...views].includes(parts[0])) return null;
        const at = parts.findIndex(part => UUID.test(part.split('_')[0]));
        if (at < 1) return null;
        // Consume the route container and view mode before reading a source segment.
        // In /characters/vault/:uuid, "vault" is a collection, not direct-upload identity.
        const prefix = parts.slice(0, at);
        if (['characters', 'character'].includes(prefix[0])) prefix.shift();
        if (views.includes(prefix[0])) prefix.shift();
        const sourceKind = normalizeDatacatSourceKind(url.searchParams.get('sourceKind'))
            || normalizeDatacatSourceKind(prefix.at(-1)) || null;
        return { id: parts[at].split('_')[0].toLowerCase(), sourceKind };
    } catch { return null; }
}

export function buildDatacatUrl(id, sourceKind) {
    const key = getDatacatCharacterId(String(id || ''));
    if (!key) return null;
    const segment = { janitor: 'janitor', saucepan: 'sauce', direct_upload: 'direct' }[normalizeDatacatSourceKind(sourceKind)];
    return `${ORIGIN}/characters/recent/${segment ? `${segment}/` : ''}${key}`;
}

export function normalizeDatacatAvatar(value, sourceKind = 'janitor') {
    if (typeof value !== 'string' || !value.trim()) return null;
    const raw = value.trim();
    if (['none', 'null'].includes(raw.toLowerCase())) return null;
    if (/^(?:https?:\/\/|\/)/i.test(raw)) {
        try {
            const url = new URL(raw, ORIGIN);
            return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
        } catch { return null; }
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(raw)) return null;
    return normalizeDatacatSourceKind(sourceKind) === 'janitor'
        ? `https://ella.janitorai.com/bot-avatars/${raw}` : new URL(raw, ORIGIN).href;
}

export function normalizeDatacatCharacter(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const id = getDatacatCharacterId(row);
    const sourceKind = getDatacatSourceKind(row);
    let variants = row.avatarVariantUrls || row.avatar_variant_urls || row.imageVariantUrls || row.image_variant_urls;
    if (typeof variants === 'string') { try { variants = JSON.parse(variants); } catch { variants = {}; } }
    const intercepted = objectValue(row.intercepted_chat_data || row.interceptedChatData);
    const directUpload = objectValue(intercepted?.direct_upload || intercepted?.directUpload || row.direct_upload || row.directUpload);
    const mediaAssets = row.directUploadMediaAssets || row.direct_upload_media_assets
        || directUpload?.mediaAssets || directUpload?.media_assets || row.media_assets || [];
    const assets = Array.isArray(mediaAssets) ? mediaAssets.filter(asset => asset && typeof asset === 'object') : [];
    const asset = assets.find(item => String(item.role || '').toLowerCase() === 'avatar') || assets[0];
    const assetUrl = asset?.mediaViewUrl || asset?.media_view_url || asset?.url || asset?.originalUrl || asset?.original_url;
    const owner = row.ownerUuid || row.owner_uuid || row.ownerUserUuid || row.owner_user_uuid
        || row.liberatorUserOwnerUuid || row.liberator_user_owner_uuid || row.owner_user_id || row.ownerUserId;
    const displayUrl = row.avatarDisplayUrl || row.avatar_display_url || row.imageDisplayUrl || row.image_display_url;
    const archiveUrl = row.avatarSelfArchiveUrl || row.avatar_self_archive_url || row.imageSelfArchiveUrl
        || row.image_self_archive_url || row.selfArchiveUrl || row.self_archive_url;
    const avatar = displayUrl || archiveUrl || variants?.card || variants?.hero
        || (sourceKind === 'direct_upload' ? assetUrl : null) || row.avatar || assetUrl;
    return {
        ...row,
        ...(id ? { character_id: id, characterId: id } : {}),
        primary_content_source_kind: sourceKind,
        creator_id: (sourceKind === 'direct_upload' ? owner : null) || row.creator_id || row.creatorId || owner || null,
        owner_uuid: owner || null,
        creator_name: row.creator_name || row.creatorName || row.owner_username || row.ownerUsername || '',
        chat_name: row.chat_name ?? row.chatName,
        is_nsfw: row.is_nsfw ?? row.isNsfw,
        chat_count: row.chat_count ?? row.chatCount,
        message_count: row.message_count ?? row.messageCount,
        total_tokens: row.total_tokens ?? row.totalTokens,
        created_at: row.created_at ?? row.createdAt,
        stats: objectValue(row.stats) || row.stats,
        intercepted_chat_data: objectValue(row.intercepted_chat_data || row.interceptedChatData) || row.intercepted_chat_data || row.interceptedChatData,
        chara_card_v2_json: objectValue(row.chara_card_v2_json || row.charaCardV2Json) || row.chara_card_v2_json || row.charaCardV2Json,
        avatar: normalizeDatacatAvatar(avatar, sourceKind),
        avatar_variant_urls: variants || {},
        avatar_self_archive_url: archiveUrl || null,
        media_assets: assets,
    };
}

export class DatacatError extends Error {
    constructor(message, { code = 'request_failed', status = 0, payload = null } = {}) {
        super(message);
        this.name = 'DatacatError';
        this.code = code;
        this.status = status;
        this.payload = payload;
        if (payload?.redirectUrl) this.redirectUrl = payload.redirectUrl;
    }
}

export function classifyDatacatError(status, payload) {
    const upstream = String(payload?.code || payload?.errorCode || payload?.error?.code || (typeof payload?.error === 'string' ? payload.error : ''));
    const message = payload?.message || payload?.error?.message || (typeof payload?.error === 'string' ? payload.error : '');
    const text = message || `DataCat returned HTTP ${status}`;
    let code = 'request_failed';
    if (status >= 500) code = 'service_unavailable';
    else if (status === 429) code = 'rate_limited';
    else if (/TURNSTILE|VERIFICATION_REQUIRED/i.test(upstream)) code = 'verification_required';
    else if (upstream === 'CREATOR_REDIRECT_REQUIRED') code = 'creator_restricted';
    else if (/(?:SESSION|TOKEN).*(?:INVALID|EXPIRED|REQUIRED|MISSING)|(?:INVALID|EXPIRED|MISSING|NO).*(?:SESSION|TOKEN)/i.test(`${upstream} ${message}`)) code = 'session_required';
    else if (status === 401 || /AUTH(?:ENTICATION)?_REQUIRED|LOGIN_REQUIRED/i.test(upstream)) code = 'authentication_required';
    else if (status === 404 && (/^(?:CHARACTER_|RESOURCE_|ENDPOINT_)?NOT_FOUND$/i.test(upstream)
        || /^(?:character|resource|endpoint|route)?\s*not found[.!]?$/i.test(message))) code = 'not_found';
    else if (status === 403) code = 'forbidden';
    return new DatacatError(text, { code, status, payload });
}

export function getDatacatPageState(pageInfo, offset, rowCount, total = null) {
    pageInfo = { ...pageInfo, ...pageInfo?.pagination, ...pageInfo?.paging };
    const rawNext = pageInfo?.nextOffset;
    const explicitNext = rawNext != null && Number.isFinite(Number(rawNext));
    const advancing = !explicitNext || Number(rawNext) > offset;
    const nextOffset = explicitNext && advancing ? Number(rawNext) : offset + rowCount;
    const knownTotal = total ?? pageInfo?.totalCount ?? pageInfo?.total;
    const hasMore = rowCount > 0 && advancing && (typeof pageInfo?.hasMore === 'boolean' ? pageInfo.hasMore
        : knownTotal != null && Number.isFinite(Number(knownTotal)) ? nextOffset < Number(knownTotal) : true);
    return { nextOffset, hasMore };
}

export function normalizeDatacatPage(payload, { offset = 0, limit = 24, listKey = 'characters' } = {}) {
    const list = payload?.[listKey] ?? payload?.characters ?? payload?.list;
    if (!Array.isArray(list)) throw new DatacatError('DataCat returned an invalid character list', { code: 'invalid_response' });
    const rows = list.map(normalizeDatacatCharacter).filter(row => getDatacatCharacterId(row));
    const pageInfo = { ...payload, ...payload.pagination, ...payload.paging };
    const totalValue = pageInfo.totalCount ?? pageInfo.total;
    const total = Number.isFinite(Number(totalValue)) && totalValue != null ? Number(totalValue) : null;
    const pagination = getDatacatPageState(pageInfo, Number(offset), list.length, total);
    return { characters: rows, list: rows, totalCount: total, total, ...pagination };
}

const failureStates = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled', 'abandoned', 'timeout', 'timed_out', 'timedout', 'expired']);
const terminalStates = new Set(['complete', 'completed', 'success', 'succeeded', 'terminal', ...failureStates]);
const activeStates = new Set(['pending', 'queued', 'running', 'processing', 'in_progress', 'opening_page', 'preparing', 'initiating', 'pulling', 'post_extract']);
const statusOf = entry => String(entry?.terminalStatus || entry?.status || entry?.state || entry?.phase || entry?.lifecycle || '').toLowerCase().replace(/-/g, '_');
const isTerminal = entry => terminalStates.has(statusOf(entry)) || terminalStates.has(String(entry?.lifecycle || '').toLowerCase());
const isActive = entry => !isTerminal(entry) && (entry?.lifecycle === 'running' || activeStates.has(statusOf(entry)));
const retrievalErrorText = value => typeof value === 'string' ? value : value?.message || value?.code || null;
export function normalizeRetrievalStatus(payload) {
    const data = payload && typeof payload === 'object' ? payload : {};
    const entries = [data.latestTerminalJob, data.run?.latestTerminalJob, data.job?.latestTerminalJob,
        ...(Array.isArray(data.history) ? data.history : []), ...(Array.isArray(data.taskHistory) ? data.taskHistory : [])].filter(Boolean);
    for (const item of [data.run, data.job, data.task]) {
        if (item && isTerminal(item)) entries.push(item);
    }
    const normalize = entry => ({ ...entry,
        requestId: entry.requestId || entry.request_id || entry.idempotencyKey || entry.task?.requestId || entry.id || null,
        characterId: entry.characterId || entry.character_id || entry.companionId || entry.result?.characterId || entry.task?.characterId
            || (entry.targetType === 'character' ? entry.targetId : null) || null,
        error: retrievalErrorText(entry.error || entry.errorMessage || entry.contractError),
        success: failureStates.has(statusOf(entry)) || entry.success === false || entry.result?.success === false
            || !!(entry.error || entry.errorMessage || entry.contractError) ? false : entry.success ?? entry.result?.success ?? true,
    });
    const active = [data.inProgress, data.run, data.job, data.task].find(item => item && !isTerminal(item)
        && !['idle', 'none'].includes(statusOf(item)) && (isActive(item)
            || item.requestId || item.request_id || item.characterId || item.character_id));
    const queue = Array.isArray(data.queue) ? data.queue : [];
    const finished = entries.filter(entry => !isActive(entry) && !['idle', 'none'].includes(statusOf(entry))
        && (isTerminal(entry) || typeof entry.success === 'boolean' || typeof entry.result?.success === 'boolean'
            || entry.error || entry.errorMessage || entry.contractError));
    return { ...data, inProgress: active ? normalize(active) : null, queue, queueLength: data.queueLength ?? queue.length, history: finished.map(normalize) };
}

export function matchRetrievalStatus(payload, { requestId, characterId, submittedAt } = {}) {
    const entries = normalizeRetrievalStatus(payload).history;
    const expectedTime = typeof submittedAt === 'number' ? submittedAt : Date.parse(submittedAt);
    return entries.find(entry => {
        if (characterId && entry.characterId && String(entry.characterId).toLowerCase() !== String(characterId).toLowerCase()) return false;
        if (requestId && entry.requestId) return entry.requestId === requestId;
        if (!characterId || String(entry.characterId).toLowerCase() !== String(characterId).toLowerCase()) return false;
        const rawTime = entry.submittedAt || entry.createdAt || entry.startedAt || entry.completedAt || entry.finishedAt
            || entry.endedAt || entry.updatedAt || entry.timestamp || entry.created_at || entry.completed_at;
        const time = typeof rawTime === 'number' ? rawTime : Date.parse(rawTime);
        return Number.isFinite(expectedTime) && Number.isFinite(time) && time >= expectedTime;
    }) || null;
}

export function isRetrievalShortcut(result) {
    return !!(result && result.success !== false && !result.error && !result.errorCode && !failureStates.has(statusOf(result))
        && (result.alreadyExists || result.alreadyRetrieved || result.cached || result.skipped
        || (result.skippedExtraction === true && result.collected === true && result.characterId)
        || result.reused || result.shortcut || ['already_exists', 'already_retrieved', 'cached', 'complete', 'completed'].includes(statusOf(result))));
}

/** Normalize the submit response before any caller decides to poll or use a cached card. */
export function normalizeRetrievalSubmission(result) {
    const raw = result;
    const data = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
    const job = data.job || data.run || data.task || {};
    const status = [statusOf(data), statusOf(job)].find(value => failureStates.has(value)) || statusOf(data) || statusOf(job);
    const requestId = data.requestId || data.request_id || data.idempotencyKey
        || job.requestId || job.request_id || job.idempotencyKey || job.id || null;
    const characterId = data.characterId || data.character_id || data.companionId
        || data.result?.characterId || job.characterId || job.character_id || null;
    const error = data.error || data.errorMessage || data.errorCode || data.contractError
        || job.error || job.errorMessage || job.errorCode || job.contractError || null;
    let state = 'invalid';
    if (failureStates.has(status) || data.success === false || job.success === false || error) {
        state = ['cancelled', 'canceled', 'abandoned'].includes(status) ? 'cancelled'
            : ['timeout', 'timed_out', 'timedout', 'expired'].includes(status) ? 'timed_out' : 'failed';
    } else if (isRetrievalShortcut(data)) {
        state = ['complete', 'completed', 'success', 'succeeded'].includes(status) ? 'completed' : 'existing';
    } else if (['complete', 'completed', 'success', 'succeeded'].includes(status)) {
        state = 'completed';
    } else if (data.started || ['running', 'processing', 'in_progress'].includes(status)) {
        state = 'running';
    } else if (data.queued || activeStates.has(status) || !status && (data.success === true || requestId)) {
        state = 'queued';
    }
    return { state, requestId, characterId, error: retrievalErrorText(error) || data.message || job.message || null, raw };
}
