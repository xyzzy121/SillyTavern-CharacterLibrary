import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../modules/character-versions.js', import.meta.url), 'utf8');
const char = { avatar: 'local.png', name: 'Local', data: { name: 'Local', description: 'Keep me', extensions: { version_uid: 'uid' } } };
const raw = new Uint8Array(50);
raw.set([137, 80, 78, 71, 13, 10, 26, 10]);

function harness({ upload, read, png = raw, decoded = { data: char.data }, maxBackups = 10 } = {}) {
    const files = new Map(), writes = [], cardWrites = [];
    const context = vm.createContext({ console: { error() {}, log() {}, warn() {} }, btoa, Uint8Array, Blob,
        fetch: async path => {
            if (path.startsWith('/characters/')) return new Response(png, { headers: { 'Content-Type': 'image/png' } });
            if (read) return read(path, files);
            const value = files.get(path.split('/').at(-1));
            return value ? Response.json(value) : new Response('', { status: 404 });
        },
        CoreAPI: {
            getSetting: key => key === 'maxAutoBackups' ? maxBackups : false,
            debugLog() {},
            extractCharacterDataFromPng: () => decoded,
            utf8ToBase64: value => Buffer.from(value).toString('base64'),
            applyCardFieldUpdates: async (...args) => { cardWrites.push(args); return true; },
            apiRequest: async (_path, _method, body) => {
                writes.push(body.name);
                if (upload) return upload(body, files);
                files.set(body.name, JSON.parse(Buffer.from(body.data, 'base64').toString()));
                return Response.json({ ok: true });
            },
        },
    });
    vm.runInContext(source.replace(/^import .*;\r?\n/gm, '')
        .replace(/export default\s*\{[\s\S]*?\};\s*$/, '')
        .replace(/\bexport (?=(?:async )?function)/g, ''), context);
    return { context, files, writes, cardWrites };
}

test('replacement backup is mandatory with ordinary auto-snapshot disabled and verifies fresh disk reads', async () => {
    const h = harness();
    const result = await h.context.createVerifiedSnapshot(structuredClone(char));
    assert.equal(result.versionUid, 'uid');
    assert.equal(result.snapshotId, 1);
    assert.equal(h.cardWrites.length, 0);
    assert.deepEqual(h.writes, ['_clv_uid.json', '_clv_index.json']);
    const snapshot = h.files.get('_clv_uid.json').snapshots[0];
    assert.equal(snapshot.source, 'replacement_backup');
    assert.equal(snapshot.data.description, 'Keep me');
    assert.deepEqual(Buffer.from(snapshot.data._avatarImageData.split(',')[1], 'base64'), Buffer.from(raw));
});

test('a new history identity is returned without mutating the current character', async () => {
    const h = harness(), target = structuredClone(char);
    delete target.data.extensions.version_uid;
    const result = await h.context.createVerifiedSnapshot(target);
    assert.equal(typeof result.versionUid, 'string');
    assert.equal(result.versionUid.length, 16);
    assert.equal(target.data.extensions.version_uid, undefined);
    assert.equal(h.cardWrites.length, 0);
});

for (const mode of ['snapshot', 'index', 'acknowledged-but-not-written']) {
    test(`replacement refuses an unverified ${mode} backup`, async () => {
        const h = harness({ upload: async (body, files) => {
            if (mode === 'acknowledged-but-not-written') return Response.json({ ok: true });
            if (body.name === (mode === 'snapshot' ? '_clv_uid.json' : '_clv_index.json')) return new Response('Disk full', { status: 500 });
            files.set(body.name, JSON.parse(Buffer.from(body.data, 'base64').toString()));
            return Response.json({ ok: true });
        } });
        await assert.rejects(h.context.createVerifiedSnapshot(structuredClone(char)));
        assert.equal(h.cardWrites.length, 0);
    });
}

test('corrupt PNGs and mismatched/missing embedded metadata fail before any backup upload', async () => {
    for (const options of [{ png: new Uint8Array(50) }, { decoded: null }, { decoded: { data: { name: 'Different' } } }]) {
        const h = harness(options);
        await assert.rejects(h.context.createVerifiedSnapshot(structuredClone(char)));
        assert.equal(h.writes.length, 0);
    }
});

test('readback failure does not get hidden by the snapshot memory cache', async () => {
    let reads = 0;
    const h = harness({ read: async (path, files) => {
        if (++reads > 2) return new Response('Unavailable', { status: 503 });
        const value = files.get(path.split('/').at(-1));
        return value ? Response.json(value) : new Response('', { status: 404 });
    } });
    await assert.rejects(h.context.createVerifiedSnapshot(structuredClone(char)), /Could not read version history/);
    assert.ok(h.writes.length > 0);
    assert.equal(h.cardWrites.length, 0);
});

test('mandatory PNG backups share automatic retention while preserving manual history and the latest backup', async () => {
    const h = harness({ maxBackups: 2 });
    await h.context.storageSaveSnapshot(char.avatar, char.name, 'Manual', 'local', { description: 'Manual history' }, 'uid');
    await h.context.storageSaveSnapshot(char.avatar, char.name, 'Automatic', 'auto_backup', { description: 'Older automatic history' }, 'uid');
    let last;
    for (let index = 0; index < 3; index++) {
        const target = structuredClone(char); target.data.description = `Replacement state ${index}`;
        last = await h.context.createVerifiedSnapshot(target);
    }
    const snapshots = h.files.get('_clv_uid.json').snapshots;
    assert.equal(snapshots.length, 3);
    assert.equal(snapshots.filter(snapshot => snapshot.source === 'local').length, 1);
    assert.equal(snapshots.filter(snapshot => ['auto_backup', 'replacement_backup'].includes(snapshot.source)).length, 2);
    assert.equal(snapshots.at(-1).id, last.snapshotId);
    assert.equal(snapshots.at(-1).data.description, 'Replacement state 2');
});

test('identical replacement snapshots deduplicate after verified readback and zero cap remains unlimited', async () => {
    const h = harness({ maxBackups: 0 });
    const first = await h.context.createVerifiedSnapshot(structuredClone(char));
    const uploadCount = h.writes.length;
    const second = await h.context.createVerifiedSnapshot(structuredClone(char));
    assert.equal(first.snapshotId, second.snapshotId);
    assert.equal(h.writes.length, uploadCount);
    for (let index = 0; index < 3; index++) {
        const target = structuredClone(char); target.data.description = `Distinct state ${index}`;
        await h.context.createVerifiedSnapshot(target);
    }
    assert.equal(h.files.get('_clv_uid.json').snapshots.length, 4);
});

test('retrying a failed first replacement reuses avatar-indexed history before version_uid reaches the card', async () => {
    const h = harness({ maxBackups: 2 }), target = structuredClone(char);
    delete target.data.extensions.version_uid;
    const first = await h.context.createVerifiedSnapshot(target);
    // The definition commit fails: the live card still has no version_uid.
    const retry = await h.context.createVerifiedSnapshot(target);
    assert.equal(retry.versionUid, first.versionUid);
    assert.equal(retry.snapshotId, first.snapshotId);
    for (let index = 0; index < 3; index++) {
        target.data.description = `Later retained state ${index}`;
        const later = await h.context.createVerifiedSnapshot(target);
        assert.equal(later.versionUid, first.versionUid);
    }
    const histories = [...h.files.keys()].filter(name => name !== '_clv_index.json');
    assert.equal(histories.length, 1);
    assert.equal(h.files.get(histories[0]).snapshots.length, 2);
    assert.equal(h.files.get('_clv_index.json').avatarMap[target.avatar], first.versionUid);
    assert.equal(target.data.extensions.version_uid, undefined);
    assert.equal(h.cardWrites.length, 0);
});
