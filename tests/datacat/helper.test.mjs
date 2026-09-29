import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../extras/cl-helper/index.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf("const DATACAT_BASE ="), source.indexOf('// Imgchest:'));
const id = '11111111-2222-3333-4444-555555555555';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function harness(fetcher) {
    const routes = new Map();
    const context = vm.createContext({ URL, Buffer, randomUUID: () => 'request-new', fetch: fetcher,
        console: { log() {}, warn() {}, error() {} },
        router: { get: (path, fn) => routes.set(`GET ${path}`, fn), post: (path, fn) => routes.set(`POST ${path}`, fn) } });
    vm.runInContext(`${section}\nregisterDataCatRoutes(router);`, context);
    return async (method, path, req = {}) => {
        const result = { status: 200, body: null, headers: {} };
        const res = { status(code) { result.status = code; return this; }, json(data) { result.body = data; return this; },
            set(name, value) { result.headers[name] = value; return this; }, send(body) { result.body = body; return this; } };
        await routes.get(`${method} ${path}`)(req, res);
        return result;
    };
}

test('retrieval uses current endpoints, retains requested visibility and correlates jobs', async () => {
    const requests = [];
    const route = harness(async (url, options) => { requests.push({ url, options }); return json({ success: true, queued: true }); });
    await route('POST', '/dc-set-token', { body: { token: 'fixture-token' } });
    let result = await route('POST', '/dc-extract', { body: { url: `https://janitorai.com/characters/${id}`, publicFeed: true } });
    assert.equal(result.body.requestId, 'request-new');
    assert.equal(requests[0].url, 'https://datacat.run/api/character/retrieval-v2');
    assert.equal(JSON.parse(requests[0].options.body).appearOnPublicFeed, true);
    assert.equal(JSON.parse(requests[0].options.body).visibilityIntent, 'public');
    assert.equal(requests.length, 1, 'does not query public browser sessions');
    result = await route('POST', '/dc-extract', { body: { url: `https://saucepan.ai/companion/${id}`, publicFeed: false } });
    assert.equal(result.status, 200);
    assert.equal(requests[1].url, 'https://datacat.run/api/saucepan-retrieval/run');
    assert.equal(JSON.parse(requests[1].options.body).visibilityIntent, 'mine');
});

test('anonymous initialization preserves an existing session on service or policy failures', async () => {
    const requests = [];
    let status = 503;
    const route = harness(async (url) => { requests.push(url); return json({ error: 'Unavailable' }, status); });
    await route('POST', '/dc-set-token', { body: { token: 'fixture-token' } });
    assert.equal((await route('POST', '/dc-init', { body: {} })).body.ok, false);
    assert.equal((await route('GET', '/dc-session')).body.active, true);
    status = 403;
    assert.equal((await route('POST', '/dc-init', { body: {} })).body.ok, false);
    assert.equal((await route('GET', '/dc-session')).body.active, true);
    assert.ok(requests.every(url => url.includes('recent-public')), 'does not create a replacement session');
});

test('proxy accepts only exact read routes including native owners and rejects redirects', async () => {
    const requests = [];
    const route = harness(async (url, options) => { requests.push({ url, options }); return json({ ok: true }); });
    const proxy = path => route('GET', '/dc-proxy/*', { params: { 0: path }, url: `/dc-proxy/${path}` });
    assert.equal((await proxy(`api/profiles/users/${id}/bots`)).status, 200);
    assert.equal((await proxy(`api/creators/saucepan%3A${id}/characters`)).status, 200);
    assert.equal((await proxy('api/retrieval/status-projection')).status, 200);
    assert.equal((await proxy('api/features')).status, 200);
    assert.equal((await proxy('api/characters/recent-public/forbidden')).status, 403);
    assert.equal((await proxy('api/characters/fresh/unapproved')).status, 403);
    assert.equal(requests.length, 4);
    assert.ok(requests.every(request => request.options.method === 'GET' && request.options.redirect === 'manual'));
});

test('retrieval preserves structured upstream restrictions and rejects invalid content', async () => {
    let invalid = false;
    const route = harness(async () => invalid ? new Response('<html>maintenance</html>', { status: 503 }) : json({ error: 'CREATOR_REDIRECT_REQUIRED', redirectUrl: 'https://datacat.run/creator' }, 403));
    await route('POST', '/dc-set-token', { body: { token: 'fixture-token' } });
    const req = { body: { url: `https://janitorai.com/characters/${id}` } };
    assert.equal((await route('POST', '/dc-extract', req)).body.error, 'CREATOR_REDIRECT_REQUIRED');
    invalid = true;
    const response = await route('POST', '/dc-extract', req);
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'INVALID_RESPONSE');
});

test('retrieval keeps upstream request aliases and does not invent jobs from malformed JSON', async () => {
    let payload;
    const route = harness(async () => json(payload));
    await route('POST', '/dc-set-token', { body: { token: 'fixture-token' } });
    const req = { body: { url: `https://janitorai.com/characters/${id}` } };
    for (const value of [{ status: 'queued', request_id: 'upstream-job' }, { job: { status: 'running', request_id: 'upstream-job' } }]) {
        payload = value;
        assert.equal((await route('POST', '/dc-extract', req)).body.requestId, 'upstream-job');
    }
    for (const value of [{}, null, [], 'accepted', { message: 'Unexpected' }, { code: 'UNKNOWN' }]) {
        payload = value;
        const result = await route('POST', '/dc-extract', req);
        assert.equal(result.status, 502);
        assert.equal(result.body.code, 'INVALID_RESPONSE');
        assert.equal(result.body.requestId, undefined);
    }
});

test('helper preserves a cached token on generic401 and refreshes only a confirmed expired session', async () => {
    const requests = [];
    let expired = false;
    const route = harness(async url => {
        requests.push(url);
        if (url.endsWith('/identify')) return json({ success: true, sessionToken: 'new-fixture-token' });
        return json({ error: expired ? 'Invalid session' : 'Authentication required' }, 401);
    });
    await route('POST', '/dc-set-token', { body: { token: 'fixture-token' } });
    assert.equal((await route('POST', '/dc-init', { body: {} })).body.ok, false);
    assert.equal((await route('GET', '/dc-session')).body.active, true);
    assert.equal(requests.length, 1);
    expired = true;
    assert.equal((await route('POST', '/dc-init', { body: {} })).body.ok, true);
    assert.equal(requests.filter(url => url.endsWith('/identify')).length, 1);
});
