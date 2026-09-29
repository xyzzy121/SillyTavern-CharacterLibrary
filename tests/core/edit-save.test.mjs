import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../app/library.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('async function performSave()'), source.indexOf('// Heavy Details-tab fields:'));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function harness({ hydrate, snapshot, writeSuccess = false } = {}) {
    const a = { avatar: 'a.png', name: 'A', data: {} }, b = { avatar: 'b.png', name: 'B', data: {} };
    const writes = [], notifications = [], paints = [], locks = [], toasts = [];
    const updates = { name: 'A edited', description: 'Confirmed edit' };
    const context = vm.createContext({
        activeChar: a, pendingUpdates: updates, pendingAvatarFile: null, originalValues: { name: 'A' },
        originalRawData: {}, _saveInProgress: false, _modalOpenGen: 1, allCharacters: [a, b],
        window: { autoSnapshotBeforeChange: snapshot || (async () => {}) },
        hydrateCharacter: hydrate || (async char => { char._slim = false; }),
        getCharacterGalleryId: () => null,
        writeCardFields: async (char, fields) => { writes.push({ char, fields }); return { ok: writeSuccess }; },
        getSetting: () => false, handleGalleryFolderRename() {},
        collectEditValues: () => ({ name: 'A edited', description: 'Confirmed edit' }),
        generateChangesDiff: (a, b) => JSON.stringify(a) === JSON.stringify(b) ? [] : ['changed'],
        refreshModalDisplay: () => paints.push(context.activeChar?.avatar),
        setEditLock: value => locks.push(value),
        getListingNameFromExtensions: () => '', getDisplayTagline: () => '', performSearch() {},
        notifySTCharacterEdited: avatar => notifications.push(avatar), fetchCharacters() {},
        showToast: (...args) => toasts.push(args), console,
        document: { getElementById: () => ({ classList: { add() {} } }), querySelector: () => null },
        File, FormData, fetch: async () => ({ ok: false, status: 500, text: async () => 'upload failed' }),
        getCSRFToken: () => 'test', bumpAvatarCacheBust() {}, getCharacterAvatarUrl: () => '',
        gridUsesThumbnails: () => false, findCardElement: () => null,
        clearPendingAvatar: () => { context.pendingAvatarFile = null; },
    });
    vm.runInContext(handler, context);
    return { context, a, b, writes, notifications, paints, locks, toasts };
}

test('an edit stays bound to its original card while the snapshot is pending', async () => {
    const hold = deferred();
    const h = harness({ snapshot: () => hold.promise });
    const saving = h.context.performSave();
    h.context.activeChar = h.b;
    h.context._modalOpenGen++;
    h.context.originalValues = { name: 'B' };
    h.context.pendingUpdates = { name: 'B edited' };
    hold.resolve();
    await saving;
    assert.equal(h.writes[0]?.char, h.a);
    assert.equal(h.writes[0]?.fields.name, 'A edited');
});

test('closing the modal while hydration is pending does not reject or unlock a second save', async () => {
    const hold = deferred();
    const h = harness({ hydrate: async char => { await hold.promise; char._slim = false; } });
    h.a._slim = true;
    const saving = h.context.performSave();
    assert.equal(h.context._saveInProgress, true);
    h.context.activeChar = null;
    h.context._modalOpenGen++;
    hold.resolve();
    await saving;
    assert.equal(h.writes[0]?.char, h.a);
    assert.equal(h.context._saveInProgress, false);
});

test('late save completion leaves a newer modal and its pending edits untouched', async () => {
    const hold = deferred();
    const h = harness({ snapshot: () => hold.promise, writeSuccess: true });
    const saving = h.context.performSave();
    const bUpdates = { name: 'B edited' };
    h.context.activeChar = h.b;
    h.context._modalOpenGen++;
    h.context.pendingUpdates = bUpdates;
    hold.resolve();
    await saving;
    assert.equal(h.context.activeChar, h.b);
    assert.equal(h.context.pendingUpdates, bUpdates);
    assert.deepEqual(h.notifications, ['a.png']);
    assert.deepEqual(h.paints, []);
    assert.deepEqual(h.locks, []);
});

test('edits made during a save remain unsaved and editable', async () => {
    const hold = deferred();
    const h = harness({ snapshot: () => hold.promise, writeSuccess: true });
    const saving = h.context.performSave();
    h.context.collectEditValues = () => ({ name: 'A edited', description: 'A newer unsaved edit' });
    hold.resolve();
    await saving;
    assert.equal(h.context.originalValues.description, 'Confirmed edit');
    assert.deepEqual(h.paints, []);
    assert.deepEqual(h.locks, []);
});

test('a successful save updates the structured-field Cancel baseline', async () => {
    const h = harness({ writeSuccess: true });
    h.context.pendingUpdates.alternate_greetings = ['new greeting'];
    h.context.pendingUpdates.character_book = { entries: [{ content: 'new lore' }] };
    h.context.originalRawData = { altGreetings: ['old'], characterBook: null };
    await h.context.performSave();
    assert.equal(h.context.originalRawData.altGreetings[0], 'new greeting');
    assert.equal(h.context.originalRawData.characterBook.entries[0].content, 'new lore');
    assert.notEqual(h.context.originalRawData.characterBook, h.context.pendingUpdates?.character_book);
});

test('failed image upload retains the selected image and keeps editing open for retry', async () => {
    const h = harness({ writeSuccess: true });
    const selected = new File(['test image'], 'replacement.png', { type: 'image/png' });
    h.context.pendingAvatarFile = selected;
    await h.context.performSave();
    assert.equal(h.context.pendingAvatarFile, selected);
    assert.deepEqual(h.locks, []);
    assert.equal(h.toasts.some(([text]) => text === 'Character saved successfully!'), false);
});
