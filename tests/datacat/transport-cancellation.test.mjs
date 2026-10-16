import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const strip = source => source.replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export \{.*\}(?: from [^;]+)?;\r?\n/gm, '').replace(/\bexport (?=(?:async )?function|const|class)/g, '');
const quiet = { debug() {}, info() {}, log() {}, warn() {}, error() {} };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const id = '11111111-2222-3333-4444-555555555555';

async function bridgeHarness(caps = { abort: true }) {
    const messages = []; let listener;
    const context = vm.createContext({ console: quiet, setTimeout, clearTimeout, DOMException, URL,
        isCloudflareBlockPage: () => false,
        window: { location: { origin: 'http://localhost:8001' }, addEventListener(_type, fn) { listener = fn; }, postMessage(message) { messages.push(message); } },
    });
    vm.runInContext(strip(await readFile(new URL('modules/providers/janitor-bridge.js', root), 'utf8')), context);
    context.initJanitorBridge();
    listener({ origin: 'http://localhost:8001', data: { source: 'cl-janitor-bridge', type: 'ready', caps } });
    return { context, messages, reply(data) { listener({ origin: 'http://localhost:8001', data: { source: 'cl-janitor-bridge', ...data } }); } };
}

test('Janitor bridge abort cancels the matching privileged request and ignores late results', async () => {
    const h = await bridgeHarness();
    const controller = new AbortController();
    const pending = h.context.janitorBridgeFetch('https://janitorai.com/hampter/characters', '', { signal: controller.signal });
    const rejected = assert.rejects(pending, error => error.name === 'AbortError');
    await flush(); const request = h.messages.find(message => message.type === 'fetch');
    controller.abort(); await rejected;
    assert.equal(h.messages.find(message => message.type === 'cancel')?.id, request.id);
    h.reply({ type: 'result', id: request.id, ok: true, status: 200, body: '{}' });
    assert.equal(vm.runInContext('pending.size', h.context), 0);
});

test('older Janitor bridge remains usable and cancellation suppresses its unabortable result', async () => {
    const h = await bridgeHarness({});
    const controller = new AbortController();
    const pending = h.context.janitorBridgeFetch('https://janitorai.com/hampter/characters', '', { signal: controller.signal });
    const rejected = assert.rejects(pending, error => error.name === 'AbortError');
    await flush(); controller.abort(); await rejected;
    assert.equal(h.messages.some(message => message.type === 'cancel'), false);
    assert.equal(vm.runInContext('pending.size', h.context), 0);
});

test('Janitor userscript advertises its real version and aborts only the requested GM handle', async () => {
    const messages = [], handles = []; let listener;
    const context = vm.createContext({ URL, console: quiet, setTimeout, clearTimeout,
        location: { origin: 'http://localhost:8001', pathname: '/SillyTavern-CharacterLibrary/app/library.html' }, document: { querySelector() { return null; } },
        window: { addEventListener(_type, fn) { listener = fn; }, postMessage(message) { messages.push(message); } },
        GM_xmlhttpRequest(options) { const handle = { aborted: false, abort() { this.aborted = true; options.onabort(); } }; handles.push(handle); return handle; },
    });
    vm.runInContext(await readFile(new URL('extras/cl-janitor-bridge.user.js', root), 'utf8'), context);
    assert.equal(messages[0].version, '1.3.2'); assert.equal(messages[0].caps.abort, true);
    const send = data => listener({ origin: 'http://localhost:8001', data: { source: 'character-library', ...data } });
    send({ type: 'fetch', id: 'first', url: 'https://janitorai.com/hampter/characters' });
    send({ type: 'fetch', id: 'second', url: 'https://janitorai.com/hampter/characters?page=2' });
    send({ type: 'cancel', id: 'first' });
    assert.equal(handles[0].aborted, true); assert.equal(handles[1].aborted, false);
    send({ type: 'cancel', id: 'second' });
});

test('Meili cancellation does not fall through to proxy or retry', async () => {
    let requests = 0, proxies = 0, transportSignal;
    const context = vm.createContext({ console: quiet, setTimeout, clearTimeout, AbortController, DOMException,
        fetch(_url, options) {
            requests++; transportSignal = options.signal;
            return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
        },
        fetchWithProxy() { proxies++; assert.fail('cancelled work must not start a proxy request'); }, readJsonClassified: response => response.json(),
    });
    vm.runInContext(strip(await readFile(new URL('modules/providers/janny/janny-api.js', root), 'utf8')) + "\n_cachedToken = 'fixture';", context);
    const controller = new AbortController();
    const pending = context.meiliMultiSearch({ signal: controller.signal });
    const rejected = assert.rejects(pending, error => error.name === 'AbortError');
    await flush(); controller.abort(); await rejected;
    assert.equal(requests, 1); assert.equal(proxies, 0); assert.equal(transportSignal.aborted, true);
});

test('Meili token discovery isolates one abort and stops when the last consumer leaves', async () => {
    const requests = [];
    const context = vm.createContext({ console: quiet, setTimeout, clearTimeout, AbortController, DOMException,
        fetch() { assert.fail('no query should start before a search token is available'); },
        fetchWithProxy(_url, options) {
            requests.push({ signal: options.signal });
            return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
        }, readJsonClassified: response => response.json(),
    });
    vm.runInContext(strip(await readFile(new URL('modules/providers/janny/janny-api.js', root), 'utf8')), context);
    const first = new AbortController(), second = new AbortController();
    const a = assert.rejects(context.meiliMultiSearch({ signal: first.signal }), error => error.name === 'AbortError');
    const b = assert.rejects(context.meiliMultiSearch({ signal: second.signal }), error => error.name === 'AbortError');
    await flush(); assert.equal(requests.length, 1);
    first.abort(); await a; assert.equal(requests[0].signal.aborted, false);
    second.abort(); await b; await flush(); assert.equal(requests[0].signal.aborted, true);
    assert.equal(vm.runInContext('_cachedToken', context), null, 'cancellation does not cache a fallback token');
});

test('Saucepan details isolate consumer aborts and preserve another consumer response', async () => {
    const requests = [];
    const context = vm.createContext({ console: quiet, URL, URLSearchParams, AbortController, DOMException, setTimeout, clearTimeout,
        CL_HELPER_PLUGIN_BASE: '/plugins/cl-helper', readJsonClassified: response => response.json() });
    vm.runInContext(strip(await readFile(new URL('modules/providers/saucepan/saucepan-api.js', root), 'utf8')), context);
    context.setApiRequest((_path, _method, _body, options) => new Promise((resolve, reject) => {
        requests.push({ resolve, signal: options.signal });
        options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    const controller = new AbortController();
    const first = context.fetchSaucepanCompanion(id, { signal: controller.signal });
    const rejected = assert.rejects(first, error => error.name === 'AbortError');
    const second = context.fetchSaucepanCompanion(id);
    await flush(); assert.equal(requests.length, 2);
    controller.abort(); await rejected;
    requests[1].resolve(new Response(JSON.stringify({ companion: { id, name: 'Kept' } })));
    assert.equal((await second).name, 'Kept');
    assert.equal(requests[0].signal.aborted, true);
});

test('classified JSON reader preserves body cancellation and timeouts even on HTTP404', async () => {
    const context = vm.createContext({ console: quiet, CoreAPI: {}, URL });
    vm.runInContext(strip(await readFile(new URL('modules/providers/provider-utils.js', root), 'utf8')), context);
    for (const name of ['AbortError', 'TimeoutError']) {
        const failure = new DOMException('Interrupted body', name);
        await assert.rejects(context.readJsonClassified({ ok: false, status: 404, text: async () => { throw failure; } }), error => error === failure);
    }
});

test('Saucepan creator read deadline includes a stalled body and token restore wait', async () => {
    for (const stage of ['body', 'token']) {
        let timeout, transportSignal, requests = 0;
        const context = vm.createContext({ console: quiet, URL, URLSearchParams, AbortController, DOMException,
            setTimeout(fn, ms) { assert.equal(ms, 30000); timeout ||= fn; return 1; }, clearTimeout() {},
            CL_HELPER_PLUGIN_BASE: '/plugins/cl-helper', readJsonClassified: response => response.json() });
        vm.runInContext(strip(await readFile(new URL('modules/providers/saucepan/saucepan-api.js', root), 'utf8')), context);
        context.setSaucepanTokenGetter(() => 'fixture');
        context.setApiRequest(async (path, _method, _body, options) => {
            requests++;
            if (path.endsWith('saucepan-set-token')) return new Promise(() => {});
            transportSignal = options.signal;
            return stage === 'body' ? { ok: true, status: 200, json: () => new Promise(() => {}) }
                : { ok: false, status: 403 };
        });
        const pending = context.fetchSaucepanCompanionsOfUser('fixture');
        const rejected = assert.rejects(pending, error => error.name === 'TimeoutError');
        await flush(); timeout(); await rejected;
        assert.equal(transportSignal.aborted, true);
        assert.equal(requests, stage === 'body' ? 1 : 2, 'timed out token restore must not send a retry');
    }
});

test('Saucepan shared token restore survives one consumer leaving and aborts with its last consumer', async () => {
    let pushes = 0, restoreSignal;
    const context = vm.createContext({ console: quiet, URL, URLSearchParams, AbortController, DOMException, setTimeout, clearTimeout,
        CL_HELPER_PLUGIN_BASE: '/plugins/cl-helper', readJsonClassified: response => response.json() });
    vm.runInContext(strip(await readFile(new URL('modules/providers/saucepan/saucepan-api.js', root), 'utf8')), context);
    context.setSaucepanTokenGetter(() => 'fixture');
    context.setApiRequest(async (path, _method, _body, { signal }) => {
        if (!path.endsWith('saucepan-set-token')) return { status: 403, ok: false };
        pushes++; restoreSignal = signal; return new Promise(() => {});
    });
    const first = new AbortController(), second = new AbortController();
    const a = assert.rejects(context.fetchSaucepanCompanionsOfUser('first', { signal: first.signal }), error => error.name === 'AbortError');
    const b = assert.rejects(context.fetchSaucepanCompanionsOfUser('second', { signal: second.signal }), error => error.name === 'AbortError');
    await flush(); assert.equal(pushes, 1);
    first.abort(); await a; assert.equal(restoreSignal.aborted, false);
    second.abort(); await b; await flush(); assert.equal(restoreSignal.aborted, true);
    assert.equal(vm.runInContext('_tokenPushInFlight', context), null);
});
