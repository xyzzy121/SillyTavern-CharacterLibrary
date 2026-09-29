import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../modules/providers/datacat/datacat-avatar-restore.js', import.meta.url), 'utf8');
const linked = { avatar: 'example.png', name: 'Example', data: { extensions: { datacat: { id: '12345678-1234-1234-1234-123456789abc' } } } };
const candidate = () => ({ avatar: linked.avatar, name: linked.name, remoteUrl: 'https://example.test/avatar.png', remoteHash: 'reviewed-image', checked: true, applied: null });
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function harness(overrides = {}) {
    const writes = [], rowUpdates = [];
    const context = vm.createContext({
        console: { warn() {}, error() {} }, window: {}, Blob, File, FormData,
        document: { getElementById: () => null },
        Image: class { naturalWidth = 100; naturalHeight = 100; set src(_value) { this.onload(); } },
        createImageBitmap: async () => ({ width: 200, height: 200, close() {} }),
        CoreAPI: {
            calculateHash: async () => 'reviewed-image', getCSRFToken: () => '',
            getCharacterAvatarUrl: () => '/local.png', escapeHtml: value => value,
            bumpAvatarCacheBust() {}, notifySTCharacterEdited() {}, performSearch() {}, showToast() {},
            ...overrides.CoreAPI,
        },
        fetchDatacatCharacter: overrides.fetchDatacatCharacter || (async () => ({ avatar: 'remote.png' })),
        resolveDatacatAvatarUrl: () => 'https://example.test/avatar.png',
        fetchWithProxy: overrides.fetchWithProxy || (async () => new Response(new Uint8Array([1, 2, 3]))),
        fetch: overrides.fetch || (async (...args) => { writes.push(args); return new Response('{}'); }),
    });
    vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace(/^export default .*;\r?\n?/gm, '') + `
        globalThis.testApi = {
            scanOne, applySelected,
            reset(token, list = []) { opToken = token; counts = {failed: 0, sanitized: 0, candidates: 0}; candidates = list; },
            counts: () => counts,
            candidates: () => candidates,
        };
        setRowStatus = (index, status) => rowUpdates.push({index, status});
    `, Object.assign(context, { rowUpdates }));
    return { api: context.testApi, writes, rowUpdates };
}

test('a cancelled avatar scan cannot add its failed request to the next scan', async () => {
    const pending = deferred();
    const h = harness({ fetchDatacatCharacter: () => pending.promise });
    h.api.reset(1);
    const scan = h.api.scanOne(linked, 1);
    h.api.reset(2);
    pending.reject(new Error('Late network failure'));
    await scan;
    assert.equal(h.api.counts().failed, 0);
});

test('an avatar scan records the reviewed digest for the eventual write', async () => {
    const h = harness();
    h.api.reset(1);
    await h.api.scanOne(linked, 1);
    assert.equal(h.api.candidates().length, 1);
    assert.equal(h.api.candidates()[0].remoteHash, 'reviewed-image');
    await h.api.applySelected();
    assert.equal(h.writes.length, 1);
});

test('a cancelled avatar hash check cannot add a moderation result to the next scan', async () => {
    const hashing = deferred(), started = deferred();
    const h = harness({ CoreAPI: { calculateHash: () => { started.resolve(); return hashing.promise; } } });
    h.api.reset(1);
    const scan = h.api.scanOne(linked, 1);
    await started.promise;
    h.api.reset(2);
    hashing.resolve('3ac2dcfe_50024');
    await scan;
    assert.equal(h.api.counts().sanitized, 0);
});

test('avatar restore refuses artwork that changed after its reviewed preview', async () => {
    const h = harness({ CoreAPI: { calculateHash: async () => 'changed-image' } });
    h.api.reset(1, [candidate()]);
    await h.api.applySelected();
    assert.equal(h.writes.length, 0, 'changed bytes must never reach edit-avatar');
    assert.match(h.rowUpdates.at(-1).status, /changed.*scan again/i);
});

test('avatar restore writes the reviewed artwork when its digest still matches', async () => {
    const row = candidate();
    const h = harness();
    h.api.reset(1, [row]);
    await h.api.applySelected();
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0][0], '/api/characters/edit-avatar');
    assert.equal(h.writes[0][1].body.get('avatar_url'), linked.avatar);
    assert.equal(row.applied, true);
});

test('a cancelled avatar upload does not mark a replacement scan row as applied', async () => {
    const uploaded = deferred(), started = deferred();
    const h = harness({ fetch: () => { started.resolve(); return uploaded.promise; } });
    h.api.reset(1, [candidate()]);
    const applying = h.api.applySelected();
    await started.promise;
    h.api.reset(3, [candidate()]);
    const previousUpdates = h.rowUpdates.length;
    uploaded.resolve(new Response('{}'));
    await applying;
    assert.equal(h.rowUpdates.length, previousUpdates, 'old uploads must not alter rows from a new scan');
});
