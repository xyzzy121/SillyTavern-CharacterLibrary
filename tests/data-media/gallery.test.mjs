import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../modules/gallery-viewer.js', import.meta.url), 'utf8');

test('an older gallery response cannot replace the newly selected character gallery', async () => {
    let release;
    const first = new Promise(resolve => { release = resolve; });
    const calls = [];
    const context = vm.createContext({
        CoreAPI: { showToast() {} }, console,
        document: { getElementById: () => null },
        _clearStaleImage() {}, updateCharacterInfo() {}, renderThumbnails() {}, updateCounter() {},
        showImage: () => calls.push(vm.runInContext('currentImages[0].name', context)),
        fetchGalleryImages: char => char.avatar === 'first.png' ? first : Promise.resolve([{ name: 'second.jpg' }]),
    });
    const state = source.slice(source.indexOf('// Module state'), source.indexOf('function _getGvThumbLoader'));
    const open = source.slice(source.indexOf('export async function openViewer('), source.indexOf('export function openViewerWithImages(')).replace('export ', '');
    vm.runInContext(state + open, context);
    const waiting = context.openViewer({ avatar: 'first.png' });
    await context.openViewer({ avatar: 'second.png' });
    release([{ name: 'first.jpg' }]);
    await waiting;
    assert.deepEqual(calls, ['second.jpg']);
});
