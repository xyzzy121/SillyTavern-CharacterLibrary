import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const copy = value => JSON.parse(JSON.stringify(value));
const id = '11111111-2222-3333-4444-555555555555';
const root = new URL('../../modules/providers/datacat/', import.meta.url);
const contract = `data:text/javascript;base64,${Buffer.from(await readFile(new URL('datacat-contract.js', root), 'utf8')).toString('base64')}`;
const source = await readFile(new URL('datacat-replacement.js', root), 'utf8');
function local() {
    return { avatar: 'identity.png', name: 'Local name', fav: true, chat: 'ongoing-chat', create_date: 'old-date', data: {
        name: 'Local name', description: 'Old definition', first_mes: 'Old hello', tags: ['local'],
        character_book: { entries: [{ keys: ['old'], content: 'Local book' }] },
        extensions: { gallery_id: 'gallery', version_uid: 'uid', world: 'Linked World', talkativeness: 0.4,
            other: { nested: true }, untouchedNull: null,
            datacat: { id, sourceKind: 'janitor', definitionSource: 'reimagination', variantId: 'old', stale: { old: true } } },
    } };
}
function exported() {
    return { card: { _listingName: 'Remote listing', data: {
        name: 'Remote name', description: 'New definition', personality: '', first_mes: 'New hello',
        alternate_greetings: ['Alternative'], tags: ['remote'],
        character_book: null,
        extensions: { gallery_id: 'untrusted', world: 'Remote world', other: { nested: false },
            datacat: { id, sourceKind: 'janitor', definitionSource: 'source', variantId: '' } },
    } }, sourceKind: 'janitor', definitionSource: 'source', variantId: '' };
}
function apply(fields, char) {
    const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
    const merge = (target, source) => {
        const output = Object.assign({}, target);
        if (plain(target) && plain(source)) {
            for (const key of Object.keys(source)) {
                if (plain(source[key])) output[key] = Object.hasOwn(target, key) ? merge(target[key], source[key]) : copy(source[key]);
                else output[key] = copy(source[key]);
            }
        }
        return output;
    };
    const payload = {};
    for (const [path, value] of Object.entries(fields)) {
        const keys = path.split('.'), key = keys.pop();
        let target = payload;
        for (const part of keys) target = target[part] ||= {};
        target[key] = copy(value);
    }
    char.data = merge(char.data, payload);
    const unset = (target, source) => {
        for (const key of Object.keys(source)) {
            if (source[key] === '__@@UNSET@@__') delete target[key];
            else if (plain(source[key]) && plain(target[key])) unset(target[key], source[key]);
        }
    };
    unset(char.data, payload);
}
async function harness(options = {}) {
    let saved = local();
    const cached = copy(saved), writes = [], preflights = [], backups = [], requests = [];
    const core = {
        getCharacterByAvatar: () => cached,
        getExtensionDeleteValue: async () => '__@@UNSET@@__',
        applyTagAliases: tags => tags.map(tag => `${tag}-alias`),
        getModule: () => ({ createVerifiedSnapshot: async char => {
            backups.push(copy(char));
            if (options.backup) await options.backup(char);
            return { versionUid: 'uid', snapshotId: 7 };
        } }),
        apiRequest: async (path, method, body) => {
            requests.push({ path, method, body });
            if (options.read) return options.read(requests.length, copy(saved));
            return Response.json(saved);
        },
        applyCardFieldUpdates: async (avatar, fields, opts) => {
            writes.push({ avatar, fields: copy(fields), opts });
            if (options.write) return options.write({ fields, cached, save: char => { saved = char; }, current: copy(saved) });
            apply(fields, saved);
            return true;
        },
        writeCardFields: async (char, fields, opts) => {
            preflights.push({ fields: copy(fields), opts });
            if (options.preflight) return options.preflight({ fields, cached: char, save: value => { saved = value; }, current: copy(saved) });
            apply(fields, saved);
            return { ok: true };
        },
        ...options.core,
    };
    const key = `__replacement_${crypto.randomUUID().replaceAll('-', '')}`;
    globalThis[key] = core;
    const code = source.replace("import CoreAPI from '../../core-api.js';", `const CoreAPI = globalThis.${key};`)
        .replace("from './datacat-contract.js'", `from '${contract}'`);
    const module = await import(`data:text/javascript;base64,${Buffer.from(code + `\n// ${key}`).toString('base64')}`);
    delete globalThis[key];
    return { ...module, writes, preflights, backups, cached, requests,
        get saved() { return saved; }, set saved(value) { saved = value; },
        invoke(extra = {}) { return module.replaceDatacatCharacter({ targetAvatar: saved.avatar,
            expectedTarget: module.captureDatacatReplacementTarget(saved), acquiredExport: exported(), ...extra }); },
    };
}

test('replacement updates one existing identity with a verified backup and surgical owned-namespace cleanup', async () => {
    const h = await harness();
    const before = copy(h.saved);
    const result = await h.invoke();
    assert.equal(h.backups.length, 1);
    assert.equal(h.writes.length, 1);
    assert.deepEqual(h.writes[0].opts, { awaitNotify: true, surgical: true, extensionCleanupNamespaces: [] });
    assert.equal(result.fileName, before.avatar);
    assert.equal(result.characterName, before.data.name);
    assert.equal(result.snapshotId, 7);
    for (const key of ['avatar', 'name', 'fav', 'chat', 'create_date']) assert.deepEqual(h.saved[key], before[key]);
    for (const key of ['gallery_id', 'version_uid', 'world', 'talkativeness', 'other', 'untouchedNull']) {
        assert.deepEqual(h.saved.data.extensions[key], before.data.extensions[key]);
    }
    assert.equal(h.saved.data.description, 'New definition');
    assert.deepEqual(h.saved.data.tags, ['remote-alias']);
    assert.equal(h.saved.data.extensions.datacat.variantId, '');
    assert.equal(h.saved.data.extensions.datacat.stale, undefined);
    assert.equal(h.saved.data.extensions.datacat.pageName, 'Remote listing');
    assert.ok(h.requests.every(request => request.path === '/characters/get'));
});

test('unknown lorebooks stay local while explicitly empty exports clear them', async () => {
    const h = await harness(), card = exported();
    card.card._lorebookUnavailable = true;
    await h.invoke({ acquiredExport: card });
    assert.equal(h.saved.data.character_book.entries[0].content, 'Local book');
    assert.equal(h.writes[0].fields.character_book, undefined);
});

for (const variant of ['id', 'source', 'definition', 'variant']) {
    test(`invalid selected-export ${variant} fails before backup and write`, async () => {
        const h = await harness(), card = exported();
        if (variant === 'id') card.card.data.extensions.datacat.id = 'invalid';
        if (variant === 'source') card.sourceKind = 'saucepan';
        if (variant === 'definition') card.definitionSource = 'reimagination';
        if (variant === 'variant') card.variantId = 'different';
        await assert.rejects(h.invoke({ acquiredExport: card }), { code: 'replacement_invalid_export' });
        assert.equal(h.backups.length, 0);
        assert.equal(h.writes.length, 0);
    });
}

test('backup failure and cancellation after backup preserve the old card', async () => {
    const h = await harness({ backup: async () => { throw new Error('Disk full'); } });
    await assert.rejects(h.invoke(), /Disk full/);
    assert.equal(h.writes.length, 0);
    const controller = new AbortController();
    const cancelled = await harness({ backup: async () => controller.abort() });
    await assert.rejects(cancelled.invoke({ signal: controller.signal }), { name: 'AbortError' });
    assert.equal(cancelled.writes.length, 0);
});

test('changed targets before confirmation or during backup require fresh confirmation', async () => {
    const h = await harness();
    const expectedTarget = h.captureDatacatReplacementTarget(h.saved);
    h.saved.data.description = 'Edited elsewhere';
    await assert.rejects(h.invoke({ expectedTarget }), { code: 'replacement_stale' });
    assert.equal(h.backups.length, 0);
    const changed = await harness({ backup: async () => { changed.saved.data.description = 'Edited during backup'; } });
    await assert.rejects(changed.invoke(), { code: 'replacement_stale' });
    assert.equal(changed.writes.length, 0);
});

test('HTTP success without a stored write is detected and does not leave optimistic cache state', async () => {
    const h = await harness({ write: async ({ fields, cached }) => { apply(fields, cached); return true; } });
    await assert.rejects(h.invoke(), { code: 'replacement_not_saved', outcome: 'unchanged', snapshotId: 7 });
    assert.equal(h.cached.data.description, 'Old definition');
});

test('a lost write response is accepted only after complete matching readback', async () => {
    const h = await harness({ write: async ({ fields, current, save }) => {
        apply(fields, current); save(current); throw new Error('Connection lost');
    } });
    const result = await h.invoke();
    assert.equal(result.success, true);
    assert.equal(result.reconciled, true);
    assert.equal(h.writes.length, 1);
});

test('unknown readback and changed protected metadata are never retried or rolled back', async () => {
    const h = await harness({ read: async (n, saved) => n === 3 ? new Response('Unavailable', { status: 503 }) : Response.json(saved) });
    await assert.rejects(h.invoke(), { code: 'replacement_unknown', outcome: 'unknown', snapshotId: 7 });
    assert.equal(h.writes.length, 1);
    const changed = await harness({ write: async ({ fields, current, save }) => {
        apply(fields, current); current.chat = 'someone-elses-new-chat'; save(current); return true;
    } });
    await assert.rejects(changed.invoke(), { code: 'replacement_unverified', outcome: 'unknown' });
    assert.equal(changed.saved.chat, 'someone-elses-new-chat');
    assert.equal(changed.writes.length, 1);
});

test('a second replacement of the same avatar cannot overlap; commit finishes after preview abort', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const h = await harness({ backup: () => pending });
    const controller = new AbortController();
    const first = h.invoke({ signal: controller.signal, onCommitStart: () => controller.abort() });
    await assert.rejects(h.invoke(), { code: 'replacement_busy' });
    release();
    assert.equal((await first).success, true);
    assert.equal(h.writes.length, 1);
});

test('unsupported host deletion support fails before backup', async () => {
    const h = await harness({ core: { getExtensionDeleteValue: async () => null } });
    await assert.rejects(h.invoke(), { code: 'replacement_unsupported_host' });
    assert.equal(h.backups.length, 0);
});

test('hydrated slim refs can confirm a server card with extra untouched optional fields', async () => {
    const h = await harness();
    const expectedTarget = h.captureDatacatReplacementTarget(h.cached);
    h.saved.data.optional_future_field = { retained: true };
    h.saved.talkativeness = 0.37; // Slim root refs do not retain this legacy field.
    await h.invoke({ expectedTarget });
    assert.deepEqual(h.saved.data.optional_future_field, { retained: true });
    assert.equal(h.saved.talkativeness, 0.37);
});

test('the confirmed export is frozen while its backup is pending', async () => {
    const selected = exported();
    const h = await harness({ backup: async () => { selected.card.data.description = 'Different preview'; } });
    await h.invoke({ acquiredExport: selected });
    assert.equal(h.saved.data.description, 'New definition');
});

test('a first replacement persists the history identity returned by its mandatory backup', async () => {
    const h = await harness();
    delete h.saved.data.extensions.version_uid;
    delete h.cached.data.extensions.version_uid;
    await h.invoke();
    assert.equal(h.saved.data.extensions.version_uid, 'uid');
});

test('populated books replace old-only object leaves in the same main merge and replace complete entry arrays', async () => {
    const h = await harness(), card = exported();
    h.saved.data.character_book = { name: 'Old', scan_depth: 8, extensions: { obsolete: true, nested: { old: true } }, entries: [{ content: 'one' }, { content: 'two' }] };
    h.cached.data.character_book = copy(h.saved.data.character_book);
    card.card.data.character_book = { name: 'New', extensions: { nested: { current: true } }, entries: [{ keys: ['new'], content: 'new' }] };
    await h.invoke({ acquiredExport: card });
    assert.equal(h.preflights.length, 0);
    assert.equal(h.writes.length, 1);
    assert.deepEqual(h.saved.data.character_book, card.card.data.character_book);
    assert.equal(h.writes[0].fields.character_book.scan_depth, '__@@UNSET@@__');
    assert.equal(h.writes[0].fields.character_book.extensions.obsolete, '__@@UNSET@@__');
});

test('owned empty null book and namespaces prepare once after backup and strictly verify before the main commit', async () => {
    const h = await harness(), card = exported();
    for (const char of [h.saved, h.cached]) {
        char.data.character_book = null;
        char.data.extensions.datacat = null;
        char.data.extensions.depth_prompt = null;
    }
    card.card.data.character_book = { name: 'New', extensions: {}, entries: [] };
    card.card.data.extensions.depth_prompt = { prompt: 'New note', depth: 4, role: 'system' };
    const controller = new AbortController();
    await h.invoke({ acquiredExport: card, signal: controller.signal, onCommitStart: () => controller.abort() });
    assert.equal(h.backups.length, 1);
    assert.equal(h.backups[0].data.character_book, null);
    assert.equal(h.preflights.length, 1);
    assert.deepEqual(h.preflights[0].fields, { character_book: '__@@UNSET@@__', 'extensions.datacat': '__@@UNSET@@__', 'extensions.depth_prompt': '__@@UNSET@@__' });
    assert.equal(h.writes.length, 1);
    assert.deepEqual(h.saved.data.character_book, card.card.data.character_book);
    assert.equal(h.saved.data.extensions.depth_prompt.prompt, 'New note');
    assert.equal(h.saved.data.extensions.untouchedNull, null);
});

test('unsafe nested null object conversions refuse replacement before any write or backup', async () => {
    const h = await harness(), card = exported();
    h.saved.data.character_book.extensions = null;
    h.cached.data.character_book.extensions = null;
    card.card.data.character_book = { extensions: { settings: {} }, entries: [] };
    await assert.rejects(h.invoke({ acquiredExport: card }), { code: 'replacement_needs_repair', outcome: 'not_started' });
    assert.equal(h.backups.length, 0);
    assert.equal(h.preflights.length, 0);
    assert.equal(h.writes.length, 0);
});

test('unwritten preflight and concurrent changes prevent the main commit without a blind retry', async () => {
    for (const concurrent of [false, true]) {
        const h = await harness({ preflight: async ({ current, save }) => {
            if (concurrent) { current.data.description = 'Newer local edit'; save(current); }
            return { ok: true };
        } });
        for (const char of [h.saved, h.cached]) char.data.character_book = null;
        const card = exported(); card.card.data.character_book = { extensions: {}, entries: [] };
        await assert.rejects(h.invoke({ acquiredExport: card }), { code: 'replacement_preflight_failed', outcome: concurrent ? 'unknown' : 'unchanged' });
        assert.equal(h.preflights.length, 1);
        assert.equal(h.writes.length, 0);
    }
});

test('a lost preflight acknowledgement is reconciled by readback and is never repeated', async () => {
    const h = await harness({ preflight: async ({ fields, current, save }) => {
        apply(fields, current); save(current); throw new Error('Lost acknowledgement');
    } });
    for (const char of [h.saved, h.cached]) char.data.character_book = null;
    const card = exported(); card.card.data.character_book = { extensions: {}, entries: [] };
    await h.invoke({ acquiredExport: card });
    assert.equal(h.preflights.length, 1);
    assert.equal(h.writes.length, 1);
});

test('unavailable preflight readback stops before the main write', async () => {
    const h = await harness({ read: async (n, saved) => n === 3 ? new Response('Unavailable', { status: 503 }) : Response.json(saved) });
    for (const char of [h.saved, h.cached]) char.data.character_book = null;
    const card = exported(); card.card.data.character_book = { extensions: {}, entries: [] };
    await assert.rejects(h.invoke({ acquiredExport: card }), { code: 'replacement_unknown', outcome: 'unknown' });
    assert.equal(h.preflights.length, 1);
    assert.equal(h.writes.length, 0);
});

test('malformed authored object fields cannot reach the backup or commit paths', async () => {
    for (const corrupt of [
        card => { card.card.data.character_book = []; },
        card => { card.card.data.extensions.depth_prompt = { prompt: { unexpected: 'object' } }; },
        card => { card.card.data.extensions.datacat.creatorId = { unexpected: 'object' }; },
    ]) {
        const h = await harness(), card = exported(); corrupt(card);
        await assert.rejects(h.invoke({ acquiredExport: card }), { code: 'replacement_invalid_export' });
        assert.equal(h.backups.length, 0);
        assert.equal(h.preflights.length, 0);
        assert.equal(h.writes.length, 0);
    }
});
