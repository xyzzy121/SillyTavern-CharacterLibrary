// Bounded, user-driven creator pagination. This module deliberately has no DOM or settings access.
export function createDatacatFollowingController({ fetchPage, getId, getSource, onChange = () => {}, now = Date.now,
    pageSize = 50, concurrency = 3, requestBudget = 12, cacheTtl = 300_000 } = {}) {
    const catalogs = new Map();
    let order = [];
    let cursor = 0;
    let generation = 0;
    let active = null;
    let lastActionRequests = 0;
    const creatorKey = creator => `${creator.source || 'datacat'}:${creator.id}`;
    const rowKey = row => `${getSource(row) || 'janitor'}:${getId(row)}`;
    const snapshot = () => {
        const rows = new Map();
        for (const key of order) for (const row of catalogs.get(key).rows.values()) rows.set(rowKey(row), row);
        const states = order.map(key => catalogs.get(key));
        return { rows: [...rows.values()], loading: !!active, creatorCount: states.length,
            visitedCreators: states.filter(state => state.visited).length,
            complete: states.every(state => state.done && !state.error),
            hasMore: states.some(state => !state.done && !state.error),
            errors: states.filter(state => state.error).map(state => ({ key: state.key, creator: state.creator, offset: state.offset, error: state.error })),
            stale: states.some(state => state.updatedAt !== null && now() - state.updatedAt >= cacheTtl),
            lastActionRequests };
    };
    const emit = () => onChange(snapshot());
    function abort() {
        generation++;
        const previous = active;
        active = null;
        previous?.controller.abort();
        emit();
    }
    function setCreators(creators) {
        const unique = new Map(creators.map(creator => [creatorKey(creator), { ...creator, source: creator.source || 'datacat' }]));
        const keys = [...unique.keys()];
        const changed = keys.length !== order.length || keys.some((key, index) => key !== order[index]);
        if (changed) abort();
        for (const key of catalogs.keys()) if (!unique.has(key)) catalogs.delete(key);
        for (const [key, creator] of unique) {
            if (catalogs.has(key)) catalogs.get(key).creator = creator;
            else catalogs.set(key, { key, creator, rows: new Map(), offset: 0, done: false, error: null, visited: false, updatedAt: null });
        }
        order = keys;
        if (changed) cursor = 0;
        emit();
    }
    async function readPage(state, signal) {
        // Abort must release this action even if a transport/mock fails to settle on abort.
        let listener;
        const interrupted = new Promise((_, reject) => {
            listener = () => { const error = new Error('Following load cancelled'); error.name = 'AbortError'; reject(error); };
            signal.addEventListener('abort', listener, { once: true });
            if (signal.aborted) listener();
        });
        try { return await Promise.race([Promise.resolve().then(() => fetchPage(state.creator, { offset: state.offset, limit: pageSize, signal })), interrupted]); }
        finally { signal.removeEventListener('abort', listener); }
    }
    function load({ target = 60, matches = () => true, retry = false, refresh = false } = {}) {
        // Repeated clicks share the same action, including repeated Refresh clicks.
        if (active && (!refresh || active.refresh)) return active.promise;
        if (refresh) {
            abort();
            for (const state of catalogs.values()) Object.assign(state, { rows: new Map(), offset: 0, done: false, error: null, visited: false, updatedAt: null });
            cursor = 0;
        }
        const token = ++generation;
        const controller = new AbortController();
        const action = { controller, refresh, promise: null };
        const retryKeys = new Set(retry ? snapshot().errors.map(entry => entry.key) : []);
        const attempted = new Set();
        const pending = new Map();
        let requests = 0;
        let rateLimited = false;
        const eligible = state => !pending.has(state.key) && (retry
            ? retryKeys.has(state.key) && !attempted.has(state.key)
            : !state.done && !state.error);
        const select = () => {
            for (let n = 0; n < order.length; n++) {
                const key = order[cursor % order.length];
                cursor = (cursor + 1) % order.length;
                const state = catalogs.get(key);
                if (eligible(state)) return state;
            }
            return null;
        };
        active = action;
        lastActionRequests = 0;
        action.promise = (async () => {
            // Defer admission until the coalesced promise has been assigned.
            await Promise.resolve();
            emit();
            while (token === generation && !controller.signal.aborted) {
                const enough = !retry && snapshot().rows.filter(matches).length >= target;
                while (!enough && !rateLimited && requests < requestBudget && pending.size < concurrency) {
                    const state = select();
                    if (!state) break;
                    attempted.add(state.key);
                    requests++;
                    const offset = state.offset;
                    const task = readPage(state, controller.signal).then(page => ({ state, offset, page }), error => ({ state, offset, error }));
                    pending.set(state.key, task);
                }
                if (!pending.size) break;
                const result = await Promise.race(pending.values());
                pending.delete(result.state.key);
                if (token !== generation || controller.signal.aborted) break;
                const { state, offset, page, error } = result;
                state.visited = true;
                if (error) {
                    state.error = error;
                    if (error.code === 'rate_limited' || error.status === 429) rateLimited = true;
                } else {
                    const list = page?.rows || page?.list || page?.characters;
                    const next = Number(page?.nextOffset);
                    const hasMore = page?.hasMore === true;
                    const staged = new Map();
                    if (Array.isArray(list)) for (const row of list) {
                        if (!getId(row)) continue;
                        const key = rowKey(row);
                        staged.set(key, { ...row, _followedCreatorName: state.creator.name, _followedCreatorId: state.creator.id, _followedCreatorSource: state.creator.source });
                    }
                    const additions = [...staged.keys()].filter(key => !state.rows.has(key)).length;
                    if (!Array.isArray(list) || (hasMore && (!Number.isFinite(next) || next <= offset || additions === 0))) {
                        const failure = new Error('Creator pagination did not advance. Retry this page or refresh the timeline.');
                        failure.code = 'invalid_response';
                        state.error = failure;
                    } else {
                        for (const [key, row] of staged) state.rows.set(key, row);
                        state.error = null;
                        state.done = !hasMore;
                        state.offset = Number.isFinite(next) ? next : offset + list.length;
                        state.updatedAt = now();
                    }
                }
                lastActionRequests = requests;
                emit();
            }
            if (token === generation && active === action) {
                active = null;
                lastActionRequests = requests;
                emit();
            }
            return snapshot();
        })();
        return action.promise;
    }
    return { snapshot, setCreators, load, abort, dispose: abort };
}
