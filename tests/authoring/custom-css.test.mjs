import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../modules/custom-css.js', import.meta.url), 'utf8');
const store = source.slice(source.indexOf('const MODE_RAW'), source.indexOf('function getMode('));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const initial = { version: 1, snippets: [{ id: 'one', name: 'Original', css: '.original {}' }], order: ['one'] };
function context(upload) {
    const state = vm.createContext({
        CoreAPI: { utf8ToBase64: text => Buffer.from(text).toString('base64'), apiRequest: upload, showToast() {} },
        fetch: async () => ({ ok: true, text: async () => JSON.stringify(initial) }),
        console: { error() {} },
    });
    vm.runInContext(store, state);
    return state;
}

test('failed snippet uploads retain the stored version and report failure', async () => {
    const state = context(async () => ({ ok: false, status: 500, text: async () => 'Disk error' }));
    const result = await state.updateSnippet('one', { css: '.unsaved {}' });
    assert.equal(result, null);
    assert.equal((await state.loadSnippets()).snippets[0].css, '.original {}');
});

test('failed snippet creation is not added as a saved snippet', async () => {
    const state = context(async () => ({ ok: false, status: 500, text: async () => 'Disk error' }));
    assert.equal(await state.createSnippet('Unsaved'), null);
    assert.equal((await state.loadSnippets()).snippets.length, 1);
});

test('concurrent snippet writes resolve only after their own persisted changes', async () => {
    const writes = [];
    const responses = [deferred(), deferred()];
    const started = [deferred(), deferred()];
    const state = context(async (_path, _method, body) => {
        const index = writes.length;
        writes.push(JSON.parse(Buffer.from(body.data, 'base64').toString()));
        started[index].resolve();
        await responses[index].promise;
        return { ok: true, json: async () => ({}) };
    });
    const first = state.updateSnippet('one', { name: 'First' });
    await started[0].promise;
    let secondDone = false;
    const second = state.updateSnippet('one', { css: '.second {}' }).then(value => { secondDone = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(secondDone, false);
    responses[0].resolve();
    await started[1].promise;
    assert.equal(secondDone, false);
    responses[1].resolve();
    await Promise.all([first, second]);
    assert.equal(writes[1].snippets[0].name, 'First');
    assert.equal(writes[1].snippets[0].css, '.second {}');
});

test('snippet edits made during save stay visibly unsaved', async () => {
    const response = deferred();
    const fields = {
        ccssSnippetName: { value: 'Name' }, ccssSnippetEnabled: { checked: true },
        ccssSnippetCss: { value: '.first {}' }, ccssSnippetStatusLabel: { textContent: '' },
    };
    const state = vm.createContext({
        CoreAPI: { getCustomCSSMaxBytes: () => 100000, showToast() {} },
        document: { getElementById: id => fields[id] }, activeSnippetId: 'one', editorDirty: true,
        byteSize: value => value.length, updateSnippet: () => response.promise,
        setSnippetsDirty() {}, renderSidebar() {},
    });
    vm.runInContext(source.slice(source.indexOf('async function saveActiveSnippet('), source.indexOf('function confirmDiscardIfDirty(')), state);
    const saving = state.saveActiveSnippet();
    fields.ccssSnippetCss.value = '.second {}';
    response.resolve({ id: 'one' });
    await saving;
    assert.equal(state.editorDirty, true);
    assert.equal(fields.ccssSnippetStatusLabel.textContent, 'Unsaved');
});

for (const [label, response] of [
    ['HTTP 503', () => ({ ok: false, status: 503 })],
    ['corrupt JSON', () => ({ ok: true, text: async () => '{broken' })],
    ['empty response', () => ({ ok: true, text: async () => '' })],
    ['JSON null response', () => ({ ok: true, text: async () => 'null' })],
    ['invalid store shape', () => ({ ok: true, text: async () => JSON.stringify({ version: 1, snippets: {} }) })],
    ['invalid snippet record', () => ({ ok: true, text: async () => JSON.stringify({ version: 1, snippets: [null] }) })],
    ['network failure', () => { throw new Error('Connection failed'); }],
]) {
    test(`${label} cannot turn existing snippets into an overwritable empty store and can retry`, async () => {
        const writes = [];
        const state = context(async (_path, _method, payload) => {
            writes.push(JSON.parse(Buffer.from(payload.data, 'base64').toString()));
            return { ok: true, json: async () => ({}) };
        });
        state.fetch = async () => response();
        await assert.rejects(state.loadSnippets());
        assert.equal(await state.createSnippet('Must not overwrite'), null);
        assert.equal(writes.length, 0);
        state.fetch = async () => ({ ok: true, text: async () => JSON.stringify(initial) });
        assert.ok(await state.createSnippet('After retry'));
        assert.equal(writes.length, 1);
        assert.deepEqual(writes[0].snippets.map(s => s.name), ['Original', 'After retry']);
    });
}

test('a genuine missing snippets file allows first creation', async () => {
    let written;
    const state = context(async (_path, _method, payload) => {
        written = JSON.parse(Buffer.from(payload.data, 'base64').toString());
        return { ok: true, json: async () => ({}) };
    });
    state.fetch = async () => ({ ok: false, status: 404 });
    assert.ok(await state.createSnippet('First'));
    assert.equal(written.snippets.length, 1);
    assert.equal(written.snippets[0].name, 'First');
});

test('opening the snippet editor handles failed initialization and retries without an unhandled rejection', async () => {
    const state = context(async () => { throw new Error('Must not upload'); });
    state.fetch = async () => ({ ok: false, status: 503 });
    let shown = 0;
    Object.assign(state, {
        injectModal() {}, setSnippetsDirty() {}, computeSnippetsDirty: () => false,
        getMode: () => 'raw', setActiveMode() {}, refreshSnippetsView() {}, loadRawIntoEditor() {},
        document: { getElementById: () => ({ classList: { add() { shown++; } } }) },
    });
    vm.runInContext(source.slice(source.indexOf('async function openModal('), source.indexOf('function closeModal(')), state);
    await assert.doesNotReject(state.openModal());
    assert.equal(shown, 0);
    state.fetch = async () => ({ ok: true, text: async () => JSON.stringify(initial) });
    await state.openModal();
    assert.equal(shown, 1);
});
