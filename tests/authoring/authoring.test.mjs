import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const root = new URL('../../modules/', import.meta.url);
const source = Object.fromEntries(await Promise.all(['lorebook-manager', 'character-creator', 'batch-tagging'].map(async name => [name, await readFile(new URL(`${name}.js`, root), 'utf8')])));
const section = (name, start, end) => source[name].slice(source[name].indexOf(start), source[name].indexOf(end, source[name].indexOf(start)));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const button = () => ({ disabled: false, innerHTML: '', classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null });
const quietConsole = { error() {}, warn() {}, log() {} };

function lorebookContext(overrides = {}) {
    const context = vm.createContext({
        CoreAPI: { showToast() {}, ...overrides }, console: quietConsole,
        document: { getElementById: () => button() },
        currentWorld: 'Original', workingWorld: { entries: { 0: { uid: 0, content: 'edited' } } },
        dirty: true, originalSnapshot: '', diskSnapshot: '', worldLoadToken: 0, worldSaveInProgress: false,
        entryCountCache: new Map(), expandedUids: new Set(), advancedUids: new Set(),
        linkedMap: new Map(), auxMap: new Map(), chatBoundMap: new Map(), chatIndexLoaded: true,
        renderWorldList() {}, renderEditor() {}, renderEmptyContent() {}, setEditingMode() {},
        updateSaveButton() {}, refreshList: async () => {}, confirmDiskDivergence: async () => true,
    });
    return context;
}

test('lorebook rename stops when pending edits fail to save', async () => {
    let renames = 0;
    const context = lorebookContext({ saveWorldInfoData: async () => false, renameWorldInfo: async () => { renames++; return true; }, charLoreRenameWorld: async () => 0 });
    vm.runInContext(section('lorebook-manager', 'async function doRename(', 'async function duplicateWorld('), context);
    await context.doRename('Original', 'Renamed');
    assert.equal(renames, 0);
    assert.equal(context.currentWorld, 'Original');
    assert.equal(context.dirty, true);
});

test('lorebook save retains dirty edits made while the write is pending', async () => {
    const write = deferred();
    const started = deferred();
    let submitted;
    const context = lorebookContext({ saveWorldInfoData: async (_name, value) => { submitted = structuredClone(value); started.resolve(); return write.promise; } });
    vm.runInContext(section('lorebook-manager', 'async function saveWorld(', 'function startCreate('), context);
    const saving = context.saveWorld();
    await started.promise;
    context.workingWorld.entries[0].content = 'newer unsaved edit';
    write.resolve(true);
    await saving;
    assert.equal(submitted.entries[0].content, 'edited');
    assert.equal(context.dirty, true);
    assert.equal(JSON.parse(context.diskSnapshot).entries[0].content, 'edited');
});

test('lorebook save completion cannot mark a different world saved', async () => {
    const write = deferred();
    const started = deferred();
    const context = lorebookContext({ saveWorldInfoData: async () => { started.resolve(); return write.promise; } });
    vm.runInContext(section('lorebook-manager', 'async function saveWorld(', 'function startCreate('), context);
    const saving = context.saveWorld();
    await started.promise;
    context.currentWorld = 'Other';
    context.workingWorld = { entries: { 1: { content: 'other draft' } } };
    context.originalSnapshot = 'other snapshot';
    write.resolve(true);
    await saving;
    assert.equal(context.currentWorld, 'Other');
    assert.equal(context.originalSnapshot, 'other snapshot');
    assert.equal(context.dirty, true);
});

test('the latest lorebook selection wins out-of-order loads', async () => {
    const slow = deferred();
    const context = lorebookContext({ getWorldInfoData: name => name === 'Slow' ? slow.promise : Promise.resolve({ entries: {} }) });
    context.dirty = false;
    context.document.getElementById = () => null;
    vm.runInContext(section('lorebook-manager', 'async function selectWorld(', 'function lbNavAllowed('), context);
    const first = context.selectWorld('Slow');
    await context.selectWorld('Latest');
    slow.resolve({ entries: {} });
    await first;
    assert.equal(context.currentWorld, 'Latest');
});

test('failed Creator Save As keeps the selected target available for retry', async () => {
    const target = { avatar: 'Existing.png', name: 'Existing' };
    const context = vm.createContext({
        CoreAPI: { getActiveTaglineNamespace: () => 'cl', autoSnapshotBeforeChange: async () => {}, applyCardFieldUpdates: async () => false, showToast() {} },
        document: { getElementById: () => button() }, console: quietConsole,
        saveAsTarget: target, avatarBuffer: null, avatarSourceAvatar: null,
        collectCreatorValues: () => ({ name: 'Draft', tags: [], alternate_greetings: [] }),
    });
    vm.runInContext(section('character-creator', 'async function confirmSaveAs(', 'function toggleSplitMenu('), context);
    await context.confirmSaveAs();
    assert.equal(context.saveAsTarget, target);
});

test('batch analysis counts prototype-named tags without corrupting objects', () => {
    const context = vm.createContext({});
    vm.runInContext(section('batch-tagging', 'function analyzeSelectedTags(', 'function renderExistingTags('), context);
    const result = context.analyzeSelectedTags([{ tags: ['constructor', '__proto__', 'toString'] }, { data: { tags: ['constructor', '__proto__', 'toString'] } }]);
    assert.deepEqual(Array.from(result.all).sort(), ['__proto__', 'constructor', 'toString']);
    assert.equal(result.some.length, 0);
});

for (const fileName of ['New Character', 'New Character.png']) {
    test(`Creator opens and notifies the actual PNG avatar after import returns ${fileName}`, async () => {
        const opened = [], notified = [];
        const char = { name: 'New Character', avatar: 'New Character.png' };
        const context = vm.createContext({
            CoreAPI: { embedCharacterDataInPng: () => new Uint8Array([1]), getCSRFToken: () => 'test',
                showToast() {}, fetchCharacters: async () => {}, getAllCharacters: () => [char],
                notifySTCharacterAdded: avatar => notified.push(avatar), openCharacterModal: card => opened.push(card) },
            document: { getElementById: id => id === 'creatorName' ? { value: char.name } : button() },
            avatarBuffer: new Uint8Array([1]), buildCharacterCard: () => ({}), closeModal() {}, console: quietConsole,
            fetch: async () => ({ ok: true, json: async () => ({ file_name: fileName }) }), File, FormData,
        });
        vm.runInContext(section('character-creator', 'async function handleCreate(', 'let saveAsDiffInjected'), context);
        await context.handleCreate();
        assert.deepEqual(notified, [char.avatar]);
        assert.deepEqual(opened, [char]);
    });
}
