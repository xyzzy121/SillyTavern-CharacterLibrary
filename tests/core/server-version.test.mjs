import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../app/library.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('function compareSemverParts('), source.indexOf('// Sentinel when ST supports it'));
function harness(version, context = null) {
    const requests = [];
    const ctx = vm.createContext({
        ST_MIN_VERSION_FOR_SENTINEL: '1.13.5', ST_UNSET_SENTINEL: '__@@UNSET@@__',
        getSTContext: () => context, debugLog() {},
        fetchStSettings: async () => ({ data: {}, settings: {} }),
        fetch: async path => { requests.push(path); return path === '/version'
            ? new Response(JSON.stringify({ pkgVersion: version }), { headers: { 'Content-Type': 'application/json' } })
            : new Response('Not Found', { status: 404 }); },
    });
    vm.runInContext(functions, ctx);
    return { ctx, requests };
}

test('standalone tabs discover unset support through the real SillyTavern version endpoint', async () => {
    const h = harness('1.19.0');
    assert.equal(await h.ctx.probeSTSentinelSupport(), true);
    assert.deepEqual(h.requests, ['/version']);
});

test('older versions retain the null fallback', async () => {
    assert.equal(await harness('1.12.0').ctx.probeSTSentinelSupport(), false);
});

test('host capability detection avoids unnecessary version requests', async () => {
    const h = harness('1.19.0', { writeExtensionField() {} });
    assert.equal(await h.ctx.probeSTSentinelSupport(), true);
    assert.deepEqual(h.requests, []);
});
