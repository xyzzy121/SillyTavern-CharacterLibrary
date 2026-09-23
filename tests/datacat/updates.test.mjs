import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the production update orchestration with only CoreAPI/DOM boundaries mocked.
const source = await readFile(new URL('../../modules/card-updates.js', import.meta.url), 'utf8');
const characterId = '12345678-1234-1234-1234-123456789abc';
const copy = value => JSON.parse(JSON.stringify(value));

function element() {
    let text = '';
    const classes = new Set(['visible']);
    return {
        dataset: {}, style: {}, checked: true, disabled: false,
        classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle(name, on) { on ? classes.add(name) : classes.delete(name); } },
        get textContent() { return text; }, set textContent(value) { text = String(value); },
        get innerHTML() { return text; }, set innerHTML(value) { text = value.replace(/<[^>]*>/g, ''); },
        querySelector() { return null; }, querySelectorAll() { return []; },
    };
}

function harness({ provider, selectedFields = ['description'], writeSuccess = true } = {}) {
    const writes = [], toasts = [], items = new Map();
    const nodes = new Map(['cardUpdateSingleModal', 'cardUpdateBatchProgress', 'batchFilterCountAll', 'batchFilterCountUpdates', 'batchFilterCountErrors', 'batchFilterCountUnavailable', 'batchFilterCountApplied'].map(id => [id, element()]));
    nodes.get('cardUpdateSingleModal').querySelectorAll = () => selectedFields.map(field => ({ dataset: { field } }));
    const document = {
        getElementById: id => nodes.get(id) || null,
        querySelector: selector => items.get(selector.match(/data-avatar="([^"]+)"/)?.[1]) || null,
        querySelectorAll(selector) {
            if (selector.includes('card-update-filter-pill')) return [];
            if (selector.includes('card-update-batch-item')) return [...items.values()].filter(item => !selector.includes('[data-status="unavailable"]') || item.dataset.status === 'unavailable');
            return [];
        },
    };
    const core = {
        getCharacterProvider: char => provider ? { provider, linkInfo: { id: characterId, fullPath: characterId, ...char.data?.extensions?.datacat } } : null,
        applyCardFieldUpdates: async (avatar, fields) => { writes.push({ avatar, fields: copy(fields) }); return writeSuccess; },
        getModule: () => null, getDisplayTagline: () => '', showToast: (...args) => toasts.push(args),
        hydrateCharacter: async () => {}, escapeHtml: value => String(value), applyTagAliases: tags => tags,
    };
    const context = vm.createContext({ core, document, window: {}, CSS: { escape: value => value }, AbortController, console: { error() {}, warn() {}, log() {} } });
    const executable = source.replace("import * as CoreAPI from './core-api.js';", 'const CoreAPI = globalThis.core;').replace(/export default\s*\{[\s\S]*?\};\s*$/, '').replace(/\bexport (?=(?:async )?function)/g, '');
    vm.runInContext(`${executable}\nglobalThis.hooks = {
        applySingleUpdates, performBatchCheck, applyBatchStatusFilter,
        seed(char, remoteCard) { singleModalAvatar = char.avatar; currentUpdateChecks.set(char.avatar, { char, remoteCard, diffs: [] }); },
        select(avatar) { batchSelectedAvatars.add(avatar); },
        state(avatar) { return { checked: currentUpdateChecks.has(avatar), selected: batchSelectedAvatars.has(avatar) }; }
    };`, context);
    return {
        ...context.hooks, writes, toasts, nodes,
        addItem(char) {
            const item = element(), status = element(), checkbox = element();
            item.dataset = { avatar: char.avatar, status: 'pending' };
            item.querySelector = selector => selector.includes('checkbox') ? checkbox : status;
            items.set(char.avatar, item);
            return { item, status, checkbox };
        },
    };
}

function localCharacter(definitionSource = 'source') {
    return { avatar: 'character.png', data: { description: 'Local content', extensions: { datacat: {
        id: characterId, sourceKind: 'janitor', definitionSource, variantId: 'old-variant',
        linkedAt: 12345, creatorId: 'original-creator', pageName: 'Local listing name', customLocal: { retained: true },
    } } } };
}

for (const [before, after] of [['source', 'reimagination'], ['reimagination', 'source']]) {
    test(`accepted ${after} update remembers selection while retaining local link metadata`, async () => {
        const h = harness(), char = localCharacter(before);
        const remote = { data: { description: 'Verified exported content', extensions: { datacat: {
            id: characterId, sourceKind: 'janitor', definitionSource: after, variantId: '',
            linkedAt: 99999, creatorId: 'remote-creator', pageName: 'Remote name', customLocal: null,
        } } } };
        h.seed(char, remote);
        await h.applySingleUpdates();
        assert.deepEqual(h.writes, [{ avatar: char.avatar, fields: {
            description: remote.data.description,
            'extensions.datacat': { ...char.data.extensions.datacat, definitionSource: after, variantId: '' },
        } }]);
        assert.equal(h.state(char.avatar).checked, false);
        assert.equal(h.nodes.get('cardUpdateSingleModal').classList.contains('visible'), false);
    });
}

test('generic-provider accepted update adds no Datacat metadata', async () => {
    const h = harness();
    const char = { avatar: 'chub.png', data: { description: 'Local', extensions: { chub: { full_path: 'author/card', linkedAt: 42 } } } };
    h.seed(char, { data: { description: 'Updated', extensions: { chub: { full_path: 'author/card' } } } });
    await h.applySingleUpdates();
    assert.deepEqual(h.writes, [{ avatar: char.avatar, fields: { description: 'Updated' } }]);
});

test('a mismatched remote identity cannot replace the local Datacat link selection', async () => {
    const h = harness(), char = localCharacter();
    h.seed(char, { data: { description: 'Updated', extensions: { datacat: { id: 'different-id', definitionSource: 'reimagination' } } } });
    await h.applySingleUpdates();
    assert.deepEqual(h.writes, [{ avatar: char.avatar, fields: { description: 'Updated' } }]);
});

test('batch verification requirement is an error, never removed, and never opens an interactive export', async () => {
    const char = localCharacter(), before = copy(char), calls = [];
    const h = harness({ provider: {
        async refreshRemoteData(link, options) { calls.push(['refresh', link, options]); },
        async fetchRemoteCard(link, options) {
            calls.push(['fetch', link, options]);
            assert.equal(options.interactive, false, 'background checks must not request a browser panel');
            throw Object.assign(new Error('Complete Datacat verification'), { code: 'verification_required' });
        },
    } });
    const { item, status, checkbox } = h.addItem(char);
    h.select(char.avatar);
    await h.performBatchCheck([char], new Set(['description']));
    assert.equal(calls.length, 2);
    assert.ok(calls[0][2].signal instanceof AbortSignal);
    assert.equal(calls[1][2].signal, calls[0][2].signal);
    assert.equal(calls[1][1].definitionSource, 'source');
    assert.equal(status.textContent, 'Verification required');
    assert.equal(item.dataset.status, 'error');
    assert.equal(checkbox.checked, false);
    assert.equal(checkbox.disabled, true);
    assert.equal(h.state(char.avatar).checked, false);
    assert.equal(h.state(char.avatar).selected, false);
    assert.equal(h.nodes.get('batchFilterCountErrors').textContent, '1');
    assert.equal(h.nodes.get('batchFilterCountUnavailable').textContent, '0');
    assert.match(h.nodes.get('cardUpdateBatchProgress').textContent, /1 error/);
    h.applyBatchStatusFilter('errors');
    assert.equal(item.style.display, '');
    h.applyBatchStatusFilter('unavailable');
    assert.equal(item.style.display, 'none');
    assert.deepEqual(h.writes, []);
    assert.deepEqual(char, before);
});

test('generic providers still classify null cards as unavailable and compare real updates', async () => {
    const first = { avatar: 'missing.png', data: { description: 'Keep this' } };
    const second = { avatar: 'updated.png', data: { description: 'Old' } };
    let count = 0;
    const h = harness({ provider: {
        async refreshRemoteData() {},
        async fetchRemoteCard(_link, options) {
            assert.equal(options.interactive, false);
            return count++ === 0 ? null : { data: { description: 'New' } };
        },
    } });
    const missing = h.addItem(first), updated = h.addItem(second);
    h.select(first.avatar); h.select(second.avatar);
    await h.performBatchCheck([first, second], new Set(['description']));
    assert.equal(missing.item.dataset.status, 'unavailable');
    assert.match(missing.status.textContent, /Removed \/ Private/);
    assert.equal(updated.item.dataset.status, 'has-updates');
    assert.equal(h.state(second.avatar).checked, true);
    assert.equal(h.nodes.get('batchFilterCountUnavailable').textContent, '1');
    assert.equal(h.nodes.get('batchFilterCountErrors').textContent, '0');
    assert.deepEqual(h.writes, []);
});
