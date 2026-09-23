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
    const reimag = objectValue(character?.datacat_reimagination || character?.datacatReimagination);
    const variants = (Array.isArray(character?.content_variants) ? character.content_variants : [])
        .filter(variant => variant && !variant.isRecoveryPlaceholder && /reimagin/i.test(String(variant.sourceKind || variant.source_kind || variant.kind || variant.type || variant.id || '')))
        .map(variant => ({ ...variant, id: variant.id || variant.variantId, name: variant.name || variant.label || 'Reimagination' }));
    return { source: character?.has_source_definition !== false && character?.sourceDefinitionAvailable !== false,
        reimagination: getDatacatSourceKind(character, null) !== 'direct_upload'
            && !!(character?.has_datacat_reimagination || character?.hasDatacatReimagination || reimag?.outputText || reimag?.output_text || variants.length),
        variants };
}

export function parseDatacatUrl(value) {
    try {
        const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
        if (!/^(www\.)?datacat\.run$/i.test(url.hostname)) return null;
        const parts = url.pathname.split('/').filter(Boolean);
        if (!['characters', 'character', 'recent', 'mine', 'vault', 'cart'].includes(parts[0])) return null;
        const at = parts.findIndex(part => UUID.test(part.split('_')[0]));
        if (at < 1) return null;
        // Consume the route container and view mode before reading a source segment.
        // In /characters/vault/:uuid, "vault" is a collection, not direct-upload identity.
        const prefix = parts.slice(0, at);
        if (['characters', 'character'].includes(prefix[0])) prefix.shift();
        if (['recent', 'mine', 'vault', 'cart'].includes(prefix[0])) prefix.shift();
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
    let variants = row.avatarVariantUrls || row.avatar_variant_urls;
    if (typeof variants === 'string') { try { variants = JSON.parse(variants); } catch { variants = {}; } }
    const asset = Array.isArray(row.media_assets) ? row.media_assets.find(item => item?.role === 'avatar') : null;
    const owner = row.ownerUuid || row.owner_uuid || row.ownerUserUuid || row.owner_user_uuid
        || row.liberatorUserOwnerUuid || row.liberator_user_owner_uuid || row.owner_user_id || row.ownerUserId;
    const avatar = row.avatarDisplayUrl || row.avatar_display_url || row.avatarSelfArchiveUrl || row.avatar_self_archive_url
        || variants?.card || variants?.hero || row.avatar || asset?.mediaViewUrl || asset?.url || asset?.originalUrl;
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
    else if (status === 404) code = 'not_found';
    else if (status === 401 || /(?:SESSION|TOKEN).*(?:INVALID|EXPIRED|REQUIRED)/i.test(upstream)) code = 'session_required';
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
    const rows = list.map(normalizeDatacatCharacter).filter(Boolean);
    const pageInfo = { ...payload, ...payload.pagination, ...payload.paging };
    const totalValue = pageInfo.totalCount ?? pageInfo.total;
    const total = Number.isFinite(Number(totalValue)) && totalValue != null ? Number(totalValue) : null;
    const pagination = getDatacatPageState(pageInfo, Number(offset), list.length, total);
    return { characters: rows, list: rows, totalCount: total, total, ...pagination };
}

const failureStates = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled', 'timeout', 'timed_out', 'timedout', 'expired']);
const terminalStates = new Set(['complete', 'completed', 'success', 'succeeded', 'terminal', ...failureStates]);
const activeStates = new Set(['pending', 'queued', 'running', 'processing', 'in_progress', 'opening_page', 'preparing', 'initiating', 'pulling', 'post_extract']);
const statusOf = entry => String(entry?.terminalStatus || entry?.status || entry?.state || entry?.phase || entry?.lifecycle || '').toLowerCase().replace(/-/g, '_');
const isTerminal = entry => terminalStates.has(statusOf(entry)) || terminalStates.has(String(entry?.lifecycle || '').toLowerCase());
const isActive = entry => entry?.lifecycle === 'running' || (entry?.lifecycle !== 'terminal' && activeStates.has(statusOf(entry)));
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
        error: entry.error || entry.errorMessage || entry.contractError || null,
        success: failureStates.has(statusOf(entry)) ? false : entry.success ?? entry.result?.success ?? (!entry.error && !entry.errorMessage && !entry.contractError),
    });
    const active = [data.inProgress, data.run, data.job, data.task].find(item => item && !isTerminal(item));
    const queue = Array.isArray(data.queue) ? data.queue : [];
    return { ...data, inProgress: active ? normalize(active) : null, queue, queueLength: data.queueLength ?? queue.length, history: entries.filter(entry => !isActive(entry)).map(normalize) };
}

export function matchRetrievalStatus(payload, { requestId, characterId, submittedAt } = {}) {
    const entries = normalizeRetrievalStatus(payload).history;
    const expectedTime = typeof submittedAt === 'number' ? submittedAt : Date.parse(submittedAt);
    return entries.find(entry => {
        if (requestId && entry.requestId) return entry.requestId === requestId;
        if (!characterId || String(entry.characterId).toLowerCase() !== String(characterId).toLowerCase()) return false;
        const rawTime = entry.submittedAt || entry.createdAt || entry.startedAt || entry.completedAt || entry.finishedAt
            || entry.endedAt || entry.updatedAt || entry.timestamp || entry.created_at || entry.completed_at;
        const time = typeof rawTime === 'number' ? rawTime : Date.parse(rawTime);
        return Number.isFinite(expectedTime) && Number.isFinite(time) && time >= expectedTime;
    }) || null;
}

export function isRetrievalShortcut(result) {
    return !!(result && (result.alreadyExists || result.alreadyRetrieved || result.cached || result.skipped
        || (result.skippedExtraction === true && result.collected === true && result.characterId)
        || result.reused || result.shortcut || ['already_exists', 'already_retrieved', 'cached', 'complete', 'completed'].includes(statusOf(result))));
}
