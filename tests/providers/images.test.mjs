import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../../modules/providers/provider-utils.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
function harness({ offscreen, bitmap, nullBlob = false } = {}) {
    const draws = [], closed = [], revoked = [];
    const context2d = { fillRect() {}, fillText() {}, drawImage: (...args) => draws.push(args) };
    const png = () => new Blob(['png'], { type: 'image/png' });
    const globals = {
        Blob, URL: { createObjectURL: () => 'blob:avatar', revokeObjectURL: url => revoked.push(url) },
        CoreAPI: { debugLog() {} },
        document: { createElement: () => ({ getContext: () => context2d,
            toBlob: callback => callback(nullBlob ? null : png()) }) },
        Image: class { width = 100; height = 200; set src(_) { queueMicrotask(() => this.onload()); } },
    };
    if (offscreen) globals.OffscreenCanvas = offscreen;
    if (bitmap) globals.createImageBitmap = async () => ({ width: 200, height: 100,
        close: () => closed.push(true) });
    const context = vm.createContext(globals);
    vm.runInContext(source + '\nglobalThis.api = {ensurePng,generatePlaceholder};', context);
    return { ...context.api, draws, closed, revoked };
}
test('missing OffscreenCanvas can generate placeholder and convert via HTML canvas/Image', async () => {
    const h = harness();
    assert.equal(Buffer.from(await h.generatePlaceholder()).toString(), 'png');
    assert.equal(Buffer.from(await h.ensurePng(new Uint8Array([1, 2, 3, 4]).buffer)).toString(), 'png');
    assert.equal(h.draws.length, 1);
    assert.deepEqual(h.revoked, ['blob:avatar']);
});
test('broken OffscreenCanvas encoding falls back and closes decoded bitmap', async () => {
    const h = harness({ bitmap: true, offscreen: class {
        getContext() { return { drawImage() {} }; }
        async convertToBlob() { throw new Error('Unsupported'); }
    } });
    assert.equal(Buffer.from(await h.ensurePng(new Uint8Array([1, 2, 3, 4]).buffer)).toString(), 'png');
    assert.equal(h.closed.length, 1);
});
test('failed HTML encoding rejects placeholders and releases bitmap during conversion', async () => {
    const h = harness({ bitmap: true, nullBlob: true });
    await assert.rejects(h.generatePlaceholder(), /PNG encoding failed/);
    assert.equal(await h.ensurePng(new Uint8Array([1, 2, 3, 4]).buffer), null);
    assert.equal(h.closed.length, 1);
});
