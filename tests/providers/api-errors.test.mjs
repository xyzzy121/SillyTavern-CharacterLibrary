import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../modules/providers/', import.meta.url);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const quiet = { error() {}, warn() {}, info() {}, log() {} };
const withoutImports = source => source.replace(/^import[\s\S]*?;\r?\n/gm, '')
    .replace(/^export (?:\{[\s\S]*?\}|\*) from .*;\r?\n/gm, '').replace(/^export /gm, '');

async function network(fetch) {
    const context = vm.createContext({ console: quiet, CoreAPI: {}, fetch, URL });
    vm.runInContext(withoutImports(await readFile(new URL('provider-utils.js', root), 'utf8')), context);
    return context;
}

async function loadApi(id, fetch) {
    const net = await network(fetch);
    const context = vm.createContext({ console: quiet, CoreAPI: {}, URL, URLSearchParams, fetch,
        readJsonClassified: net.readJsonClassified, proxyEncode: encodeURIComponent,
        fetchMetadataWithProxy: net.fetchWithProxy, _rawFetchWithProxy: net.fetchWithProxy,
        CL_HELPER_PLUGIN_BASE: '/plugins/cl-helper',
    });
    vm.runInContext(withoutImports(await readFile(new URL(`${id}/${id}-api.js`, root), 'utf8')), context);
    if (id === 'saucepan') context.setApiRequest(fetch);
    return context;
}

const functions = { chub: 'fetchChubMetadata', wyvern: 'fetchWyvernMetadata', botbooru: 'fetchBotbooruCard', saucepan: 'fetchSaucepanCompanion' };
for (const [id, name] of Object.entries(functions)) {
    test(`${id}: strict update reads distinguish auth/rate limit/server failures from genuine missing cards`, async () => {
        for (const status of [401, 403, 429, 500, 503]) {
            const api = await loadApi(id, async () => json({ error: 'upstream unavailable' }, status));
            await assert.rejects(api[name]('fixture', { strict: true }), error => error.status === status && !error.notFound);
        }
        const api = await loadApi(id, async () => json({ error: 'Not found' }, 404));
        assert.equal(await api[name]('fixture', { strict: true }), null);
    });
    test(`${id}: malformed success and disabled proxy cannot be interpreted as removed`, async () => {
        for (const response of [json({}), new Response('<html>Just a moment</html>'), new Response('CORS proxy is disabled', { status: 404 })]) {
            const api = await loadApi(id, async () => response);
            await assert.rejects(api[name]('fixture', { strict: true }));
        }
    });
}

test('Chub missing definitions remain absent so the canonical PNG fallback can run', async () => {
    const api = await loadApi('chub', async () => json({ node: { id: 1, name: 'Fixture' } }));
    const metadata = await api.fetchChubMetadata('author/fixture', { strict: true });
    assert.equal(metadata.definition, null);
});

test('best-effort metadata callers still receive null rather than an unexpected rejection', async () => {
    for (const [id, name] of Object.entries(functions)) {
        const api = await loadApi(id, async () => json({ error: 'unavailable' }, 503));
        assert.equal(await api[name]('fixture'), null);
    }
});

test('shared network classification never marks a proxy outage or Cloudflare 404 as missing', async () => {
    const net = await network(() => {});
    for (const body of ['CORS proxy is disabled', '<html>Just a moment...</html>']) {
        await assert.rejects(net.readJsonClassified(new Response(body, { status: 404 })), error => !error.notFound);
    }
    await assert.rejects(net.readJsonClassified(json({ error: 'not found' }, 404)), error => error.notFound === true);
});
