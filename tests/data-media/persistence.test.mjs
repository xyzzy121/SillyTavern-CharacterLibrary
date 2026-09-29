import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function load(name, overrides = {}) {
    const source = await readFile(new URL(`../../modules/${name}.js`, import.meta.url), 'utf8');
    const writes = [];
    const context = vm.createContext({
        console: { warn() {}, error() {}, log() {} }, setTimeout, clearTimeout,
        AbortController, Response, Blob, TextEncoder, TextDecoder, DecompressionStream,
        CoreAPI: {
            utf8ToBase64: value => Buffer.from(value).toString('base64'),
            apiRequest: async (_path, _method, body) => {
                writes.push(body);
                return Response.json({ ok: true });
            },
            getSetting: () => 10, debugLog() {}, showToast() {},
            refreshPlaylistBadges() {}, refreshPlaylistFilterIfActive() {},
            ...overrides.CoreAPI,
        },
        fetch: overrides.fetch || (async () => new Response('', { status: 404 })),
    });
    // Execute production storage functions unchanged; replace only their imported host boundary.
    const end = name === 'playlists' ? source.indexOf('let pickerInjected')
        : name === 'character-versions' ? source.indexOf('function generateVersionUid')
        : source.indexOf('const PHASE_LABELS');
    vm.runInContext(source.slice(0, end).replace(/^import .*;\r?\n/gm, '').replace(/export /g, ''), context);
    return { context, writes };
}

for (const name of ['playlists', 'character-versions', 'media-download-queue']) {
    for (const failure of ['server', 'corrupt']) {
        test(`${name} does not treat ${failure} read failure as an empty store`, async () => {
            const { context, writes } = await load(name, { fetch: async () => failure === 'server'
                ? new Response('Unavailable', { status: 503 }) : new Response('{ broken') });
            const action = name === 'playlists' ? () => context.createPlaylist('New')
                : name === 'character-versions' ? () => context.storageSaveSnapshot('a.png', 'A', 'Saved', 'manual', {}, 'uid')
                : () => context.loadQueueFile();
            await assert.rejects(action);
            assert.equal(writes.length, 0);
        });
    }
    test(`${name} retries a failed initial read`, async () => {
        let attempts = 0;
        const { context } = await load(name, { fetch: async () => ++attempts === 1
            ? new Response('Unavailable', { status: 503 }) : new Response('', { status: 404 }) });
        const read = name === 'playlists' ? () => context.loadPlaylists()
            : name === 'character-versions' ? () => context.ensureIndexLoaded() : () => context.loadQueueFile();
        await assert.rejects(read);
        await read();
        assert.equal(attempts, 2);
    });
}

test('playlists recover a missing order list without losing saved playlists', async () => {
    const { context } = await load('playlists', { fetch: async () => Response.json({
        version: 1, playlists: { saved: { name: 'Saved', characters: ['a.png'] } },
    }) });
    await context.loadPlaylists();
    assert.equal(context.getAllPlaylists()[0].uid, 'saved');
});

test('concurrent snapshots for a new character retain both saves with distinct IDs', async () => {
    const { context, writes } = await load('character-versions');
    await Promise.all([
        context.storageSaveSnapshot('a.png', 'A', 'First', 'manual', { description: 'one' }, 'uid'),
        context.storageSaveSnapshot('a.png', 'A', 'Second', 'manual', { description: 'two' }, 'uid'),
    ]);
    const snapshots = await context.storageGetSnapshots('a.png', 'uid');
    assert.equal(snapshots.length, 2);
    assert.equal(new Set(snapshots.map(s => s.id)).size, 2);
    const saved = writes.filter(w => w.name === '_clv_uid.json').at(-1);
    assert.equal(JSON.parse(Buffer.from(saved.data, 'base64').toString()).snapshots.length, 2);
});

test('a failed snapshot upload is not retained in the read cache', async () => {
    const { context } = await load('character-versions', {
        fetch: async name => name.includes('_clv_uid.') ? Response.json({
            version_uid: 'uid', name: 'A', avatar: 'a.png', nextId: 2, backup: null,
            snapshots: [{ id: 1, label: 'Original', data: {}, timestamp: 1 }],
        }) : new Response('', { status: 404 }),
        CoreAPI: { apiRequest: async () => new Response('Disk full', { status: 500 }) },
    });
    await assert.rejects(() => context.storageSaveSnapshot('a.png', 'A', 'Unsaved', 'manual', {}, 'uid'));
    const snapshots = await context.storageGetSnapshots('a.png', 'uid');
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].label, 'Original');
});

test('queue writes preserve jobs awaiting character-list recovery', async () => {
    const { context, writes } = await load('media-download-queue', {
        fetch: async () => Response.json({ version: 1, jobs: [{ avatar: 'old.png', folderName: 'old' }] }),
    });
    await context.saveQueueFile();
    const saved = JSON.parse(Buffer.from(writes.at(-1).data, 'base64').toString());
    assert.equal(saved.jobs[0]?.avatar, 'old.png');
});

test('version restore stops when a different card opens during remote loading', async () => {
    const source = await readFile(new URL('../../modules/character-versions.js', import.meta.url), 'utf8');
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const writes = [];
    const context = vm.createContext({
        console, currentChar: { avatar: 'first.png', data: {} }, _renderGen: 1,
        activeTab: 'remote', selectedVersionRef: 'v1', selectedSnapshotId: null,
        currentProvider: { name: 'Remote', fetchVersionData: () => pending }, currentLinkInfo: {},
        CoreAPI: { showConfirm: async () => true, showToast() {},
            applyCardFieldUpdates: async (...args) => { writes.push(args); return true; },
            getExtensionDeleteValue: async () => null, refreshCharacters: async () => {},
        },
        el: () => ({}), extractCardData: async () => ({}), ensureVersionUid: async () => 'uid',
        storageSaveBackup: async () => {}, storageSaveSnapshot: async () => {},
        buildNamespaceUpdates: () => ({}), CARD_FIELDS: ['description'],
    });
    vm.runInContext(source.slice(source.indexOf('async function restoreVersion('), source.indexOf('async function undoRestore(')), context);
    const result = context.restoreVersion();
    context.currentChar = { avatar: 'second.png', data: {} };
    context._renderGen++;
    release({ description: 'First card version' });
    await result;
    assert.equal(writes.length, 0);
});

for (const operation of ['create', 'update', 'delete', 'add', 'remove']) {
    test(`failed playlist ${operation} keeps confirmed data and returns failure`, async () => {
        const data = { version: 1, order: ['saved'], playlists: { saved: { name: 'Original', characters: ['a.png'] } } };
        const { context } = await load('playlists', { fetch: async () => Response.json(data),
            CoreAPI: { apiRequest: async () => new Response('Disk full', { status: 500 }) },
        });
        await context.loadPlaylists();
        const before = JSON.stringify(context.getAllPlaylists());
        const result = await ({
            create: () => context.createPlaylist('New'),
            update: () => context.updatePlaylist('saved', { name: 'Changed' }),
            delete: () => context.deletePlaylist('saved'),
            add: () => context.addToPlaylist('saved', ['b.png']),
            remove: () => context.removeFromPlaylist('saved', ['a.png']),
        })[operation]();
        assert.equal(result, false);
        assert.equal(JSON.stringify(context.getAllPlaylists()), before);
    });
}

test('queued playlist mutations await their own upload and publish only confirmed data', async () => {
    const uploads = [], waiting = [];
    const { context } = await load('playlists', { fetch: async () => Response.json({
        version: 1, order: ['saved'], playlists: { saved: { name: 'Original', characters: ['a.png'] } },
    }), CoreAPI: { apiRequest: async (_path, _method, body) => {
        uploads.push(JSON.parse(Buffer.from(body.data, 'base64').toString()));
        return new Promise(resolve => waiting.push(() => resolve(Response.json({ ok: true }))));
    } } });
    await context.loadPlaylists();
    const first = context.updatePlaylist('saved', { name: 'First' });
    const avatars = ['b.png'];
    let secondFinished = false;
    const second = context.addToPlaylist('saved', avatars).then(value => { secondFinished = true; return value; });
    avatars.push('not-submitted.png');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(uploads.length, 1);
    assert.equal(secondFinished, false);
    assert.equal(context.getPlaylist('saved').name, 'Original');
    assert.deepEqual(Array.from(context.getPlaylist('saved').characters), ['a.png']);
    waiting.shift()();
    await first;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(uploads.length, 2);
    assert.equal(secondFinished, false);
    assert.equal(context.getPlaylist('saved').name, 'First');
    assert.deepEqual(Array.from(context.getPlaylist('saved').characters), ['a.png']);
    waiting.shift()();
    assert.equal(await second, 1);
    assert.deepEqual(Array.from(context.getPlaylist('saved').characters), ['a.png', 'b.png']);
    assert.equal(uploads[1].playlists.saved.name, 'First');
});

test('a queued playlist mutation recovers after failure without saving rejected edits', async () => {
    let attempts = 0;
    const uploads = [];
    const { context } = await load('playlists', { fetch: async () => Response.json({
        version: 1, order: ['saved'], playlists: { saved: { name: 'Original', characters: ['a.png'] } },
    }), CoreAPI: { apiRequest: async (_path, _method, body) => {
        uploads.push(JSON.parse(Buffer.from(body.data, 'base64').toString()));
        return ++attempts === 1 ? new Response('Disk full', { status: 500 }) : Response.json({ ok: true });
    } } });
    const results = await Promise.all([
        context.updatePlaylist('saved', { name: 'Rejected' }),
        context.addToPlaylist('saved', ['b.png']),
    ]);
    assert.deepEqual(results, [false, 1]);
    assert.equal(context.getPlaylist('saved').name, 'Original');
    assert.equal(uploads[1].playlists.saved.name, 'Original');
    assert.deepEqual(Array.from(context.getPlaylist('saved').characters), ['a.png', 'b.png']);
});
