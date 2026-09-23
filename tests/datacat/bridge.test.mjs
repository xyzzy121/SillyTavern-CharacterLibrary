import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// A data import keeps these pure protocol tests independent of ST/browser globals.
const moduleSource = await readFile(new URL('../../modules/providers/datacat/datacat-export-bridge.js', import.meta.url), 'utf8');
const bridge = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
const companionSource = await readFile(new URL('../../extras/cl-datacat-bridge.user.js', import.meta.url), 'utf8');
const characterId = '12345678-1234-1234-1234-123456789abc';
const nonce = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const requestId = 'export:123';
const request = bridge.normalizeDatacatExportRequest({ characterId, sourceKind: 'janitor', variantId: 'janitor_core:123' });
const frameWindow = {};
const expected = { nonce, requestId, request, frameWindow };
const event = overrides => ({
    origin: bridge.DATACAT_EXPORT_ORIGIN, source: frameWindow,
    data: { protocol: bridge.DATACAT_EXPORT_PROTOCOL, type: 'card', nonce, requestId, metadata: { ...request } },
    ...overrides,
});

function pngFixture() {
    const bytes = new Uint8Array(45);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 13);
    bytes.set([73, 72, 68, 82], 12); // IHDR
    view.setUint32(16, 1);
    view.setUint32(20, 1);
    bytes.set([73, 69, 78, 68], 37); // IEND, length 0
    return bytes.buffer;
}

test('the existing Character Library PNG parser reads the validated V2 payload', async () => {
    const librarySource = await readFile(new URL('../../app/library.js', import.meta.url), 'utf8');
    const parserSource = librarySource.slice(librarySource.indexOf('function extractCharacterDataFromPng('), librarySource.indexOf('// Embed character data into PNG'));
    const parse = vm.runInNewContext(parserSource + '\nextractCharacterDataFromPng;', {
        Uint8Array, DataView, atob, debugLog() {},
    });
    const card = { spec: 'chara_card_v2', spec_version: '2.0', data: {
        name: 'Unicode café 猫', description: 'Source definition',
        alternate_greetings: ['Hello'], character_book: { entries: [{ content: 'Lore' }] },
        extensions: { datacat: { id: characterId, definitionSource: 'source' }, custom: { retained: true } },
    } };
    const payload = Buffer.from('chara\0' + Buffer.from(JSON.stringify(card)).toString('base64'));
    const chunk = Buffer.alloc(payload.length + 12);
    chunk.writeUInt32BE(payload.length);
    chunk.write('tEXt', 4);
    payload.copy(chunk, 8);
    let crc = 0xffffffff;
    for (const byte of chunk.subarray(4, chunk.length - 4)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
    const combined = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
    const buffer = combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength);
    const parsed = parse(bridge.validateDatacatExportPng(buffer));
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), card);
    assert.equal(parse(bridge.validateDatacatExportPng(pngFixture())), null);
});

test('source is the default and identifiers are normalized', () => {
    const result = bridge.normalizeDatacatExportRequest({ characterId: characterId.toUpperCase(), sourceKind: 'direct_upload' });
    assert.equal(result.characterId, characterId);
    assert.equal(result.definitionSource, 'source');
    assert.equal(result.variantId, '');
});

test('invalid identity, source, definition and variant are refused', () => {
    for (const values of [
        { characterId: '../characters' }, { sourceKind: 'unknown' },
        { definitionSource: 'auto' }, { variantId: 'bad\nvariant' },
        { sourceKind: 'direct_upload', definitionSource: 'reimagination' },
    ]) assert.throws(() => bridge.normalizeDatacatExportRequest({ ...request, ...values }));
});

test('deep links preserve native/saucepan identity and exact parent origin', () => {
    for (const [sourceKind, route] of [['direct_upload', 'direct'], ['saucepan', 'sauce'], ['janitor', 'janitor']]) {
        const url = new URL(bridge.buildDatacatExportUrl({ ...request, sourceKind }, nonce, 'http://localhost:8000'));
        assert.equal(url.pathname, `/characters/recent/${route}/${characterId}`);
        assert.equal(url.searchParams.get('cl_datacat_parent'), 'http://localhost:8000');
        assert.equal(url.searchParams.get('cl_datacat_nonce'), nonce);
    }
    assert.throws(() => bridge.buildDatacatExportUrl(request, 'bad', 'http://localhost:8000'));
    assert.throws(() => bridge.buildDatacatExportUrl(request, nonce, 'https://example.test/path'));
    assert.throws(() => bridge.buildDatacatExportUrl(request, nonce, 'file:///tmp/index.html'));
});

test('only messages from the requested frame and exact origin are accepted', () => {
    assert.equal(bridge.isDatacatExportMessage(event(), expected), true);
    for (const origin of ['http://datacat.run', 'https://datacat.run.evil.test', 'https://www.datacat.run', 'null']) {
        assert.equal(bridge.isDatacatExportMessage(event({ origin }), expected), false);
    }
    assert.equal(bridge.isDatacatExportMessage(event({ source: {} }), expected), false);
});

test('nonce, request, variant, source, definition and character are bound to the request', () => {
    for (const values of [{ nonce: 'other-nonce-123456' }, { requestId: 'other' }, { protocol: 'datacat:st-character-card' }]) {
        const message = event();
        Object.assign(message.data, values);
        assert.equal(bridge.isDatacatExportMessage(message, expected), false);
    }
    for (const key of ['characterId', 'sourceKind', 'definitionSource', 'variantId']) {
        const message = event();
        message.data.metadata[key] = 'different';
        assert.equal(bridge.isDatacatExportMessage(message, expected), false);
    }
    assert.equal(bridge.isDatacatExportMessage(event({ data: null }), expected), false);
});

test('PNG validation refuses non-binary, malformed, truncated and oversized payloads', () => {
    assert.equal(bridge.validateDatacatExportPng(pngFixture()).byteLength, 45);
    for (const value of [null, {}, new Uint8Array(45), new ArrayBuffer(8), new ArrayBuffer(45), new ArrayBuffer(bridge.DATACAT_EXPORT_MAX_BYTES + 1)]) {
        assert.throws(() => bridge.validateDatacatExportPng(value), { code: 'DATACAT_BRIDGE_INVALID_PNG' });
    }
    const truncated = pngFixture();
    new DataView(truncated).setUint32(8, 9999);
    assert.throws(() => bridge.validateDatacatExportPng(truncated));
    assert.throws(() => bridge.validateDatacatExportPng(pngFixture().slice(0, 44)));
});

function companionHarness({ nativeExport, contextSource = 'janitor' } = {}) {
    class Element {
        constructor(tag) { this.tag = tag; this.style = {}; this.children = []; this.events = {}; this.disabled = false; }
        setAttribute() {}
        append(...elements) { this.children.push(...elements); }
        addEventListener(name, fn) { this.events[name] = fn; }
        remove() { this.removed = true; }
    }
    const sent = [];
    const calls = [];
    const handlers = {};
    const body = new Element('body');
    const parent = { postMessage: (data, origin, transfer) => sent.push({ data, origin, transfer }) };
    const window = {
        parent,
        addEventListener: (name, fn) => { handlers[name] = fn; },
        DatacatCharacterExport: {
            getCurrentModalContext: () => ({ characterId, sourceKind: contextSource }),
            buildPngPayload: async (...args) => {
                calls.push(args);
                return nativeExport ? nativeExport(...args) : { pngBytes: new Uint8Array(pngFixture()), cardData: { spec: 'chara_card_v2', data: { name: 'Example' } } };
            },
        },
    };
    const document = { body, createElement: tag => new Element(tag), addEventListener: (name, fn) => { handlers[`document:${name}`] = fn; } };
    vm.runInNewContext(companionSource, {
        window, document, location: { origin: 'https://datacat.run', search: `?cl_datacat_export=1&cl_datacat_nonce=${nonce}&cl_datacat_parent=${encodeURIComponent('http://localhost:8000')}` },
        URL, URLSearchParams, ArrayBuffer, Uint8Array, setInterval: () => 1, clearInterval: () => {},
    });
    const send = (data = {}, eventOverrides = {}) => handlers.message({
        origin: 'http://localhost:8000', source: parent,
        data: { protocol: bridge.DATACAT_EXPORT_PROTOCOL, type: 'init', nonce, requestId, metadata: { ...request }, ...data },
        ...eventOverrides,
    });
    const button = () => body.children.at(-1)?.children.find(el => el.textContent === 'Export to Character Library');
    return { send, button, sent, calls, handlers, body };
}

test('companion refuses other parents and does not export automatically', () => {
    const harness = companionHarness();
    harness.send({}, { origin: 'http://evil.test' });
    harness.send({}, { source: {} });
    assert.equal(harness.sent.length, 0);
    harness.send();
    assert.equal(harness.sent[0].data.type, 'ready');
    assert.equal(harness.calls.length, 0);
});

test('synthetic clicks cannot trigger a native export', async () => {
    const harness = companionHarness();
    harness.send();
    await harness.button().events.click({ isTrusted: false });
    assert.equal(harness.calls.length, 0);
});

test('a visible click passes the explicit definition and variant to native export', async () => {
    const harness = companionHarness();
    harness.send({ metadata: { ...request, definitionSource: 'reimagination' } });
    await harness.button().events.click({ isTrusted: true });
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0][0], characterId);
    assert.equal(harness.calls[0][3], request.variantId);
    assert.equal(harness.calls[0][4], 'janitor');
    assert.equal(harness.calls[0][5].definitionSource, 'reimagination');
    const result = harness.sent.find(item => item.data.type === 'card');
    assert.equal(result.origin, 'http://localhost:8000');
    assert.equal(result.data.metadata.definitionSource, 'reimagination');
    assert.equal(result.data.cardData.data.name, 'Example');
    assert.equal(result.transfer[0], result.data.png);
    assert.deepEqual(Object.keys(result.data).sort(), ['cardData', 'metadata', 'nonce', 'png', 'protocol', 'requestId', 'type'].sort());
});

test('the visible character source must match before export is enabled', async () => {
    const harness = companionHarness({ contextSource: 'saucepan' });
    harness.send();
    assert.equal(harness.button().disabled, true);
    await harness.button().events.click({ isTrusted: true });
    assert.equal(harness.calls.length, 0);
});

test('native denial is returned as an error with no reconstructed card', async () => {
    const harness = companionHarness({ nativeExport: () => { throw new Error('Creator restricted this export.'); } });
    harness.send();
    await harness.button().events.click({ isTrusted: true });
    assert.equal(harness.sent.at(-1).data.type, 'error');
    assert.match(harness.sent.at(-1).data.message, /Creator restricted/);
    assert.equal(harness.sent.some(item => item.data.type === 'card'), false);
});

test('cancellation prevents a late native export result from being delivered', async () => {
    let finish;
    const harness = companionHarness({ nativeExport: () => new Promise(resolve => { finish = resolve; }) });
    harness.send();
    const pending = harness.button().events.click({ isTrusted: true });
    harness.send({ type: 'cancel' });
    finish({ pngBytes: new Uint8Array(pngFixture()), cardData: { data: { name: 'late' } } });
    await pending;
    assert.equal(harness.sent.some(item => item.data.type === 'card'), false);
});

function panelHarness() {
    const posts = [];
    const nodes = new Map();
    const handlers = new Set();
    const timers = new Set();
    let sequence = 0;
    class Element {
        constructor(tag) {
            this.tag = tag; this.events = new Map(); this.children = new Map(); this.isConnected = false;
            if (tag === 'iframe') this.contentWindow = { postMessage: (data, origin) => posts.push({ data, origin }) };
        }
        setAttribute() {}
        addEventListener(name, fn) { this.events.set(name, fn); }
        removeEventListener(name) { this.events.delete(name); }
        append(element) { element.isConnected = true; nodes.set(element.id, element); }
        remove() { this.isConnected = false; nodes.delete(this.id); }
        focus() {}
        querySelector(selector) {
            if (!this.children.has(selector)) this.children.set(selector, new Element(selector === 'iframe' ? 'iframe' : 'button'));
            return this.children.get(selector);
        }
    }
    const body = new Element('body');
    const context = {
        URL, ArrayBuffer, Uint8Array, DataView, DOMException, AbortController,
        crypto: { randomUUID: () => `aaaaaaaa-bbbb-cccc-dddd-${String(++sequence).padStart(12, '0')}` },
        document: { body, head: new Element('head'), createElement: tag => new Element(tag), getElementById: id => nodes.get(id) },
        window: { location: { origin: 'http://localhost:8000' }, registerOverlay: value => { context.overlay = value; }, pushOverlayGuard: () => { context.guardCount = (context.guardCount || 0) + 1; }, addEventListener: (_, fn) => handlers.add(fn), removeEventListener: (_, fn) => handlers.delete(fn) },
        setInterval: callback => { timers.add(callback); return callback; }, clearInterval: callback => timers.delete(callback),
        setTimeout: callback => { timers.add(callback); return callback; }, clearTimeout: callback => timers.delete(callback),
        decodeCard: () => ({ spec: 'chara_card_v2', data: { name: 'PNG canonical card' } }),
    };
    const source = moduleSource.replaceAll('export ', '').replaceAll('import.meta.url', JSON.stringify('https://st.test/modules/providers/datacat/datacat-export-bridge.js'))
        .replace("await import('../../core-api.js')", '({default:{extractCharacterDataFromPng:globalThis.decodeCard}})');
    vm.runInNewContext(`${source}\nglobalThis.api = {requestDatacatBrowserExport, closeDatacatExportPanel};`, context);
    const root = () => nodes.get('datacatExportPanel');
    const frame = () => root().querySelector('iframe');
    const init = () => { frame().events.get('load')(); return posts.at(-1).data; };
    const deliver = async (data, overrides = {}) => {
        const message = { origin: bridge.DATACAT_EXPORT_ORIGIN, source: frame().contentWindow, data, ...overrides };
        for (const handler of [...handlers]) await handler(message);
    };
    return { api: context.api, context, init, root, frame, deliver, handlers, timers, posts };
}

test('parent decodes the PNG, ignores a mismatched result and cleans up after success', async () => {
    const harness = panelHarness();
    const promise = harness.api.requestDatacatBrowserExport(request);
    const init = harness.init();
    await harness.deliver({ ...init, type: 'card', metadata: { ...request, definitionSource: 'reimagination' }, png: pngFixture() });
    assert.equal(harness.handlers.size, 1);
    await harness.deliver({ ...init, type: 'card', cardData: { data: { name: 'untrusted envelope' } }, png: pngFixture() });
    const result = await promise;
    assert.equal(result.card.data.name, 'PNG canonical card');
    assert.equal(result.definitionSource, 'source');
    assert.equal(harness.handlers.size, 0);
    assert.equal(harness.timers.size, 0);
    assert.equal(harness.root(), undefined);
});

test('a serial bulk session reuses one panel and rejects old request messages', async () => {
    const harness = panelHarness();
    const first = harness.api.requestDatacatBrowserExport({ ...request, reusePanel: true });
    const firstRoot = harness.root();
    assert.equal(harness.context.guardCount, 1, 'a new panel must arm the mobile Back guard');
    const oldInit = harness.init();
    await harness.deliver({ ...oldInit, type: 'card', png: pngFixture() });
    await first;
    const second = harness.api.requestDatacatBrowserExport({ ...request, definitionSource: 'reimagination', reusePanel: true });
    assert.equal(harness.root(), firstRoot);
    assert.equal(harness.context.guardCount, 1, 'serial reuse must not add duplicate Back guards');
    const nextInit = harness.init();
    await harness.deliver({ ...oldInit, type: 'card', png: pngFixture() });
    assert.equal(harness.handlers.size, 1);
    await harness.deliver({ ...nextInit, type: 'card', png: pngFixture() });
    assert.equal((await second).definitionSource, 'reimagination');
    harness.api.closeDatacatExportPanel();
    assert.equal(harness.root(), undefined);
});

test('per-character cancellation and overlay close reject without dangling listeners', async () => {
    const harness = panelHarness();
    const first = harness.api.requestDatacatBrowserExport({ ...request, reusePanel: true });
    const rejection = assert.rejects(first, error => error.name === 'AbortError' && error.panelClosed === false);
    harness.root().querySelector('.dc-export-cancel').events.get('click')();
    await rejection;
    assert.ok(harness.root());
    const second = harness.api.requestDatacatBrowserExport({ ...request, reusePanel: true });
    const closed = assert.rejects(second, error => error.name === 'AbortError' && error.panelClosed === true);
    harness.context.overlay.close();
    await closed;
    assert.equal(harness.root(), undefined);
    assert.equal(harness.handlers.size, 0);
    assert.equal(harness.timers.size, 0);
});

test('AbortSignal cancels the active request and native denial never becomes a card', async () => {
    const harness = panelHarness();
    const controller = new AbortController();
    const pending = harness.api.requestDatacatBrowserExport({ ...request, signal: controller.signal });
    const aborted = assert.rejects(pending, { name: 'AbortError' });
    controller.abort();
    await aborted;
    const denied = harness.api.requestDatacatBrowserExport(request);
    const init = harness.init();
    const rejection = assert.rejects(denied, { code: 'DATACAT_BRIDGE_EXPORT_FAILED', message: 'Export denied.' });
    await harness.deliver({ ...init, type: 'error', message: 'Export denied.' });
    await rejection;
    assert.equal(harness.root(), undefined);
});
