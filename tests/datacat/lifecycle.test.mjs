import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const contractCode = await readFile(new URL('modules/providers/datacat/datacat-contract.js', root), 'utf8');
const contract = await import(`data:text/javascript;base64,${Buffer.from(contractCode).toString('base64')}`);
const apiCode = (await readFile(new URL('modules/providers/datacat/datacat-api.js', root), 'utf8'))
    .replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export \*.*\r?\n/gm, '')
    .replace(/^export \{.*\};\r?\n/gm, '').replace(/\bexport (?=(?:async )?function|const|class)/g, '');
const helperCode = await readFile(new URL('extras/cl-helper/index.js', root), 'utf8');
const helperSection = helperCode.slice(helperCode.indexOf('const DATACAT_BASE ='), helperCode.indexOf('// Imgchest:'));
const id = '11111111-2222-3333-4444-555555555555';
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise(setImmediate); };

function clock() {
    let now = 1700000000000, serial = 0;
    const timers = new Map();
    return {
        Date: class extends Date { static now() { return now; } },
        setTimeout(fn, ms = 0) { const key = ++serial; timers.set(key, { fn, at: now + Math.max(0, ms) }); return key; },
        clearTimeout(key) { timers.delete(key); },
        now: () => now,
        count: () => timers.size,
        async advance(ms) {
            const end = now + ms;
            await flush();
            for (;;) {
                const next = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
            }
            now = end; await flush();
        },
    };
}

function apiHarness(fetcher, overrides = {}) {
    const time = clock();
    const context = vm.createContext({ ...contract, URL, URLSearchParams, AbortController, DOMException, console,
        CoreAPI: { isUrlSafeForDownload: () => ({ ok: true }) }, CL_HELPER_PLUGIN_BASE: '/plugins/cl-helper',
        slugify: value => value, stripHtml: value => value, JANNY_TAG_MAP: {}, readJsonClassified: response => response.json(),
        classifyErrorPage: () => null, meiliMultiSearch() {}, isJanitorBridgeAvailable: () => false, janitorBridgeFetch() {},
        ...time, ...overrides });
    vm.runInContext(contractCode.replace(/\bexport (?=(?:async )?function|const|class)/g, '') + '\n' + apiCode, context);
    context.setApiRequest(fetcher);
    return { api: context, time };
}

test('owned cancellation interrupts response body and never follows a fallback', async () => {
    const body = deferred();
    const requests = [];
    const { api, time } = apiHarness(async (path, _method, _data, options) => {
        requests.push({ path, signal: options.signal });
        return { ok: true, status: 200, headers: new Headers(), text: () => body.promise };
    });
    const controller = new AbortController();
    const pending = api.fetchDatacatCharacter(id, 'janitor', { signal: controller.signal });
    const rejected = assert.rejects(pending, error => error.name === 'AbortError');
    await flush(); controller.abort(); await rejected;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(time.count(), 0);
});

test('status deadline remains active during body consumption', async () => {
    let transportSignal;
    const { api, time } = apiHarness(async (_path, _method, _data, options) => {
        transportSignal = options.signal;
        return { ok: true, status: 200, headers: new Headers(), text: () => new Promise(() => {}) };
    });
    const pending = api.fetchExtractionStatus();
    const rejected = assert.rejects(pending, error => error.code === 'timeout');
    await time.advance(14999); assert.equal(transportSignal.aborted, false);
    await time.advance(1); await rejected;
    assert.equal(transportSignal.aborted, true);
    assert.equal(time.count(), 0);
});

test('one consumer cannot abort a shared anonymous bootstrap', async () => {
    const response = deferred(), requests = [];
    const { api } = apiHarness((path, _method, _data, options) => { requests.push({ path, signal: options.signal }); return response.promise; });
    const controller = new AbortController();
    const first = api.initDcSession(null, false, { signal: controller.signal });
    const second = api.initDcSession(null);
    const rejected = assert.rejects(first, error => error.name === 'AbortError');
    await flush(); controller.abort(); await rejected;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].signal.aborted, false);
    response.resolve(json({ ok: true, token: 'anonymous' }));
    assert.equal(await second, 'anonymous');
});

test('clearing a session aborts stale bootstrap and prevents token resurrection', async () => {
    const response = deferred(), requests = [];
    const { api } = apiHarness((path, _method, _data, options) => {
        requests.push({ path, signal: options.signal });
        return path.endsWith('/dc-clear-token') ? json({ ok: true }) : response.promise;
    });
    const pending = api.initDcSession(null);
    const rejected = assert.rejects(pending, error => error.name === 'AbortError');
    await flush(); assert.equal(await api.clearDcSession(), true); await rejected;
    assert.equal(requests[0].signal.aborted, true);
    response.resolve(json({ ok: true, token: 'stale' }));
    await flush();
    assert.equal(vm.runInContext('_sessionToken', api), null);
});

for (const kind of ['bootstrap', 'features']) {
    test(`leaving the last ${kind} consumer aborts shared transport and permits a fresh attempt`, async () => {
        const signals = [];
        const { api } = apiHarness((_path, _method, _data, options) => {
            signals.push(options.signal);
            return new Promise(() => {});
        });
        const first = new AbortController(), second = new AbortController();
        const read = signal => kind === 'bootstrap' ? api.initDcSession(null, false, { signal }) : api.fetchDatacatFeatures({ signal });
        const a = assert.rejects(read(first.signal), error => error.name === 'AbortError');
        const b = assert.rejects(read(second.signal), error => error.name === 'AbortError');
        await flush(); assert.equal(signals.length, 1);
        first.abort(); await a; assert.equal(signals[0].aborted, false);
        second.abort(); await b; await flush(); assert.equal(signals[0].aborted, true);
        const next = new AbortController();
        const c = assert.rejects(read(next.signal), error => error.name === 'AbortError');
        await flush(); assert.equal(signals.length, 2); next.abort(); await c;
    });
}

test('active session reentry is cached and manual replacement invalidates feature work', async () => {
    const requests = [], featureResponse = deferred();
    const { api } = apiHarness((path, _method, body, options) => {
        requests.push({ path, body, signal: options.signal });
        if (path.endsWith('/api/features')) return featureResponse.promise;
        if (path.endsWith('/dc-init')) return json({ ok: true, token: 'anonymous' });
        if (path.endsWith('/dc-set-token')) return json({ ok: true });
        if (path.endsWith('/dc-validate')) return json({ valid: true });
        assert.fail(path);
    });
    assert.equal(await api.initDcSession(null), 'anonymous');
    assert.equal(await api.initDcSession('anonymous'), 'anonymous');
    assert.equal(requests.length, 1, 'reentry does not restore or validate the same token again');
    const features = assert.rejects(api.fetchDatacatFeatures(), error => error.name === 'AbortError');
    await flush(); assert.equal(await api.initDcSession('manual'), 'manual'); await features;
    assert.equal(requests.find(item => item.path.endsWith('/api/features')).signal.aborted, true);
    featureResponse.resolve(json({ janitorRetrievalDisabled: true })); await flush();
    assert.equal(vm.runInContext('_featuresCache', api), null);
});

test('feature reads coalesce, isolate consumer aborts, expire and honor viewer flags', async () => {
    const response = deferred(); let count = 0;
    const { api, time } = apiHarness(() => { count++; return count === 1 ? response.promise : json({ janitorRetrievalDisabled: false }); });
    const controller = new AbortController();
    const first = api.fetchDatacatFeatures({ signal: controller.signal });
    const rejected = assert.rejects(first, error => error.name === 'AbortError');
    const second = api.fetchDatacatFeatures();
    await flush(); controller.abort(); await rejected;
    response.resolve(json({ janitorRetrievalDisabled: true, janitorRetrievalDisabledForViewer: false }));
    const features = await second;
    assert.equal(api.getDatacatCapabilities(features, 'janitor').retrievalDisabled, false);
    assert.equal(api.getDatacatCapabilities({ saucepanContentDisabledForViewer: false, saucepanRetrievalDisabledForViewer: true }, 'saucepan').contentDisabled, false);
    assert.equal(api.getDatacatCapabilities({ saucepanRetrievalDisabledForViewer: true }, 'saucepan').retrievalDisabled, true);
    await api.fetchDatacatFeatures(); assert.equal(count, 1);
    await time.advance(300001); await api.fetchDatacatFeatures(); assert.equal(count, 2);
    assert.equal(api.getDatacatCapabilities(null, 'janitor').known, false);
});

test('a feature request can bootstrap an expired session without aborting itself', async () => {
    let features = 0, bootstraps = 0;
    const { api } = apiHarness(path => {
        if (path.endsWith('/dc-init')) { bootstraps++; return json({ ok: true, token: 'replacement-session' }); }
        assert.match(path, /api\/features$/);
        return ++features === 1 ? json({ error: 'SESSION_EXPIRED' }, 401) : json({ janitorRetrievalDisabledForViewer: true });
    });
    assert.equal((await api.fetchDatacatFeatures()).janitorRetrievalDisabledForViewer, true);
    await api.fetchDatacatFeatures(); assert.equal(features, 2); assert.equal(bootstraps, 1);
});

test('429 preserves Retry-After and holds subsequent reads until the shared cooldown', async () => {
    const starts = [];
    const { api, time } = apiHarness(() => {
        starts.push(time.now());
        return starts.length === 1 ? json({ error: 'Slow down' }, 429, { 'retry-after': '5' }) : json({ character: { characterId: id } });
    });
    await assert.rejects(api.fetchDatacatCharacter(id), error => error.code === 'rate_limited' && error.retryAfterMs === 5000 && error.retryAt === time.now() + 5000);
    const next = api.fetchDatacatCharacter(id);
    await time.advance(4999); assert.equal(starts.length, 1);
    await time.advance(1); await next; assert.equal(starts.length, 2);
    assert.equal(starts[1] - starts[0], 5000);
});

test('Retry-After HTTP dates and malformed values retain distinct metadata', () => {
    const date = new Date(Date.now() + 60000).toUTCString();
    const error = contract.classifyDatacatError(429, {}, new Headers({ 'retry-after': date }));
    assert.ok(error.retryAfterMs > 58000 && error.retryAfterMs <= 60000);
    assert.equal(contract.classifyDatacatError(429, {}, new Headers({ 'retry-after': 'invalid' })).retryAt, null);
});

test('shared polling backs off transient errors, resets after success and matches only its job', async () => {
    const starts = [];
    const { api, time } = apiHarness(() => {
        starts.push(time.now());
        if (starts.length <= 2) return json({ error: 'Unavailable' }, 503);
        return json({ history: starts.length === 3 ? [{ requestId: 'other', characterId: id, status: 'completed' }]
            : [{ requestId: 'current', characterId: id, status: 'completed' }] });
    });
    const start = time.now();
    const pending = api.pollDatacatRetrieval({ requestId: 'current', characterId: id, submittedAt: start });
    await time.advance(15000);
    assert.equal((await pending).requestId, 'current');
    assert.deepEqual(starts.map(value => value - start), [3000, 6000, 12000, 15000]);
    assert.equal(time.count(), 0);
});

test('polling respects a 60-second Retry-After and never submits a job', async () => {
    const starts = [];
    const { api, time } = apiHarness((path, method) => {
        assert.equal(method, 'GET'); assert.match(path, /status-projection/);
        starts.push(time.now());
        return starts.length === 1 ? json({ error: 'Slow down' }, 429, { 'retry-after': '60' })
            : json({ history: [{ requestId: 'current', characterId: id, status: 'completed' }] });
    });
    const start = time.now();
    const pending = api.pollDatacatRetrieval({ requestId: 'current', characterId: id, submittedAt: start });
    await time.advance(62999); assert.equal(starts.length, 1);
    await time.advance(1); await pending;
    assert.deepEqual(starts.map(value => value - start), [3000, 63000]);
});

test('hard polling deadline interrupts pending status work and leaves no timers', async () => {
    const signals = [];
    const { api, time } = apiHarness((_path, _method, _data, options) => { signals.push(options.signal); return new Promise(() => {}); });
    const pending = api.pollDatacatRetrieval({ requestId: 'current', characterId: id });
    const rejected = assert.rejects(pending, error => error.code === 'timeout');
    await time.advance(180000); await rejected;
    assert.ok(signals.length > 0 && signals.every(signal => signal.aborted));
    assert.equal(time.count(), 0);
});

test('canceling the polling wait sends no request', async () => {
    const { api, time } = apiHarness(() => assert.fail('must not fetch after cancellation'));
    const controller = new AbortController();
    const pending = api.pollDatacatRetrieval({ characterId: id, signal: controller.signal });
    const rejected = assert.rejects(pending, error => error.name === 'AbortError');
    controller.abort(); await rejected; assert.equal(time.count(), 0);
});

test('submission deadline reports unknown outcome and never resubmits', async () => {
    const requests = [];
    const { api, time } = apiHarness((_path, method, _body, options) => { requests.push({ method, signal: options.signal }); return new Promise(() => {}); });
    const pending = api.submitExtraction(`https://janitorai.com/characters/${id}`);
    const rejected = assert.rejects(pending, error => error.code === 'timeout' && error.unknownOutcome === true && /Check DataCat before retrying/.test(error.message));
    await time.advance(60000); await rejected;
    assert.equal(requests.length, 1); assert.equal(requests[0].method, 'POST'); assert.equal(requests[0].signal.aborted, true);
});

test('submission deadline includes cooldown and does not report dispatch when nothing was sent', async () => {
    let calls = 0;
    const { api, time } = apiHarness(() => { calls++; return json({ error: 'Slow down' }, 429, { 'retry-after': '120' }); });
    await assert.rejects(api.fetchDatacatCharacter(id), error => error.code === 'rate_limited');
    const pending = api.submitExtraction(`https://janitorai.com/characters/${id}`);
    const rejected = assert.rejects(pending, error => error.code === 'timeout' && error.unknownOutcome !== true);
    await time.advance(60000); await rejected;
    assert.equal(calls, 1, 'the only request was the earlier rate-limited read');
    assert.equal(time.count(), 0);
});

test('DataCat requires a helper advertising actual cancellation support', async () => {
    let capable = false;
    const { api } = apiHarness(() => json({ ok: true, version: capable ? '1.13.2' : '1.13.1', capabilities: { datacatCancellation: capable } }));
    assert.equal(await api.checkDcPluginAvailable(), false);
    assert.equal(await api.checkDcPluginAvailable({ requireCapabilities: false }), true);
    capable = true; assert.equal(await api.checkDcPluginAvailable(), true);
});

function helperHarness(fetcher) {
    const time = clock(), routes = new Map();
    const context = vm.createContext({ URL, Buffer, AbortController, DOMException, ...time, fetch: fetcher, randomUUID: () => 'request-new',
        console: { log() {}, warn() {}, error() {} },
        router: { get: (path, handler) => routes.set(`GET ${path}`, handler), post: (path, handler) => routes.set(`POST ${path}`, handler) } });
    vm.runInContext(helperSection + '\nregisterDataCatRoutes(router);', context);
    function start(method, path, body = null) {
        const req = new EventEmitter(), res = new EventEmitter();
        Object.assign(req, { body, method, params: { 0: 'api/features' }, url: '/dc-proxy/api/features', aborted: false });
        const result = { status: 200, body: null, writes: 0, headers: {} };
        Object.assign(res, { writableEnded: false, destroyed: false,
            status(code) { result.status = code; return this; }, set(name, value) { result.headers[name.toLowerCase()] = value; return this; },
            json(value) { result.writes++; result.body = value; this.writableEnded = true; return this; },
            send(value) { result.writes++; result.body = value; this.writableEnded = true; return this; } });
        const done = routes.get(`${method} ${path}`)(req, res);
        return { req, res, result, done };
    }
    return { start, time };
}

test('helper paces upstream starts and holds at most three slots through body reads', async () => {
    const starts = [], bodies = [];
    const { start, time } = helperHarness(async () => {
        starts.push(time.now()); const body = deferred(); bodies.push(body);
        return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: () => body.promise, json: () => body.promise, arrayBuffer: () => body.promise };
    });
    const origin = time.now();
    const jobs = Array.from({ length: 4 }, () => start('GET', '/dc-proxy/*'));
    await time.advance(2999); assert.equal(starts.length, 3);
    bodies[0].resolve('{}'); await flush();
    await time.advance(1); assert.equal(starts.length, 4);
    assert.deepEqual(starts.map(value => value - origin), [0, 1000, 2000, 3000]);
    for (const body of bodies) body.resolve('{}');
    await Promise.all(jobs.map(job => job.done)); assert.equal(time.count(), 0);
});

test('helper aborts upstream on disconnect while body is pending and sends no response', async () => {
    let transportSignal;
    const { start, time } = helperHarness(async (_url, options) => {
        transportSignal = options.signal;
        return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: () => new Promise(() => {}), json() {}, arrayBuffer() {} };
    });
    const job = start('GET', '/dc-proxy/*'); await flush();
    job.res.emit('close'); await job.done;
    assert.equal(transportSignal.aborted, true); assert.equal(job.result.writes, 0);
    assert.equal(job.req.listenerCount('aborted'), 0); assert.equal(job.res.listenerCount('close'), 0); assert.equal(time.count(), 0);
});

test('helper does not abort a normal request close and still enforces its body deadline', async () => {
    let transportSignal;
    const { start, time } = helperHarness(async (_url, options) => {
        transportSignal = options.signal;
        return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: () => new Promise(() => {}), json() {}, arrayBuffer() {} };
    });
    const job = start('GET', '/dc-proxy/*'); await flush();
    job.req.emit('close'); assert.equal(transportSignal.aborted, false);
    await time.advance(30000); await job.done;
    assert.equal(transportSignal.aborted, true); assert.equal(job.result.status, 504); assert.equal(time.count(), 0);
});

test('helper rate limit postpones already queued work and forwards Retry-After', async () => {
    const starts = [];
    const { start, time } = helperHarness(async () => {
        starts.push(time.now());
        return starts.length === 1 ? json({ error: 'Slow down' }, 429, { 'retry-after': '5' }) : json({ success: true });
    });
    const first = start('GET', '/dc-proxy/*'), second = start('GET', '/dc-proxy/*');
    await time.advance(4999); assert.equal(starts.length, 1);
    await time.advance(1); await Promise.all([first.done, second.done]);
    assert.equal(first.result.headers['retry-after'], '5'); assert.equal(starts[1] - starts[0], 5000);
});

test('helper drops a disconnected queued consumer before it can contact DataCat', async () => {
    let requests = 0;
    const body = deferred();
    const { start, time } = helperHarness(async () => {
        requests++;
        return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: () => body.promise, json() {}, arrayBuffer() {} };
    });
    const first = start('GET', '/dc-proxy/*'), queued = start('GET', '/dc-proxy/*');
    await flush(); queued.req.aborted = true; queued.req.emit('aborted'); await queued.done;
    await time.advance(3000); assert.equal(requests, 1); assert.equal(queued.result.writes, 0);
    body.resolve('{}'); await first.done; assert.equal(time.count(), 0);
});

test('helper submission has a 60-second body deadline and never resends the POST', async () => {
    let requests = 0, transportSignal;
    const { start, time } = helperHarness(async (_url, options) => {
        requests++; transportSignal = options.signal;
        return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: () => new Promise(() => {}), json() {}, arrayBuffer() {} };
    });
    await start('POST', '/dc-set-token', { token: 'fixture-token' }).done;
    const job = start('POST', '/dc-extract', { url: `https://janitorai.com/characters/${id}`, publicFeed: false });
    await time.advance(59999); assert.equal(transportSignal.aborted, false);
    await time.advance(1); await job.done;
    assert.equal(requests, 1); assert.equal(job.result.status, 504); assert.match(job.result.body.error, /remote job may still finish/);
    assert.equal(transportSignal.aborted, true); assert.equal(time.count(), 0);
});

test('late helper anonymous identify cannot overwrite a token set by another consumer', async () => {
    const response = deferred();
    const { start } = helperHarness(() => response.promise);
    const init = start('POST', '/dc-init'); await flush();
    await start('POST', '/dc-set-token', { token: 'new-manual-token' }).done;
    response.resolve(json({ success: true, sessionToken: 'stale-anonymous-token' }));
    await init.done; assert.equal(init.result.body.ok, false);
    const session = start('GET', '/dc-session'); await session.done; assert.equal(session.result.body.active, true);
});
