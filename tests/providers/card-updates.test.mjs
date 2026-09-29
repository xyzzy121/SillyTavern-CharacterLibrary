import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../../modules/card-updates.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replace(/export default[\s\S]*$/, '').replace(/^export /gm, '');
function harness(overrides = {}) {
    const notices = [];
    const writes = [];
    const context = vm.createContext({ console: { error() {} }, Set, Map, AbortController, CSS: { escape: s => s },
        document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
        CoreAPI: { getCharacterProvider: () => ({ provider: { id: 'chub' } }), getModule: () => null,
            getDisplayTagline: () => '', showToast: (...args) => notices.push(args),
            applyCardFieldUpdates: async (...args) => { writes.push(args); return false; }, ...overrides },
    });
    vm.runInContext(source, context);
    vm.runInContext('hidePreApplySummary = () => {}; updateBatchFilterCounts = () => {}; updateBatchFooter = () => {};', context);
    return { context, notices, writes };
}
const fixture = (avatar, listingOnly = false) => ({ char: { avatar, data: { name: 'Before' } },
    diffs: [{ field: listingOnly ? 'listing_name' : 'name' }], remoteCard: { data: { name: 'After' }, _listingName: 'New listing' } });

test('a closed batch cannot populate or finish a new scan when its remote request returns late', async () => {
    const pending = new Map();
    const { context } = harness({
        getCharacterProvider: char => ({ linkInfo: { id: char.avatar }, provider: {
            refreshRemoteData: async () => {}, fetchRemoteCard: link => new Promise(resolve => pending.set(link.id, resolve)),
        } }), hydrateCharacter: async () => {}, applyTagAliases: tags => tags,
    });
    context.document.getElementById = id => id === 'cardUpdateBatchProgress' ? {} : null;
    const oldScan = context.performBatchCheck([{ avatar: 'old.png', data: { name: 'before' } }], new Set(['name']));
    await new Promise(resolve => setImmediate(resolve));
    context.closeBatchModal();
    const newScan = context.performBatchCheck([{ avatar: 'new.png', data: { name: 'before' } }], new Set(['name']));
    await new Promise(resolve => setImmediate(resolve));
    pending.get('old.png')({ data: { name: 'old response' } });
    await oldScan;
    assert.equal(vm.runInContext("currentUpdateChecks.has('old.png')", context), false);
    assert.equal(vm.runInContext('batchCheckRunning', context), true);
    pending.get('new.png')({ data: { name: 'before' } });
    await newScan;
});

test('failed listing-name-only single updates remain pending and never announce success', async () => {
    const { context, notices, writes } = harness();
    context.record = fixture('fixture.png', true);
    context.document.getElementById = () => ({ querySelectorAll: () => [{ dataset: { field: 'listing_name' } }] });
    vm.runInContext("singleModalAvatar = 'fixture.png'; currentUpdateChecks.set('fixture.png', record);", context);
    await context.applySingleUpdates();
    assert.equal(writes.length, 1);
    assert.equal(notices.some(([, type]) => type === 'success'), false);
    assert.equal(vm.runInContext("currentUpdateChecks.has('fixture.png')", context), true);
});

test('batch application retains failed and unselected comparisons for retry', async () => {
    const { context, notices } = harness({ applyCardFieldUpdates: async avatar => avatar === 'success.png' });
    context.records = [fixture('success.png'), fixture('failed.png'), fixture('unselected.png')];
    vm.runInContext(`for (const r of records) currentUpdateChecks.set(r.char.avatar, r);
        batchSelectedAvatars = new Set(['success.png', 'failed.png']);`, context);
    await context.applyAllBatchUpdates();
    assert.equal(vm.runInContext("currentUpdateChecks.has('success.png')", context), false);
    assert.equal(vm.runInContext("currentUpdateChecks.has('failed.png')", context), true);
    assert.equal(vm.runInContext("currentUpdateChecks.has('unselected.png')", context), true);
    assert.match(notices[0][0], /Updated 1 character, 1 failed/);
});

test('failed listing-name-only batch updates count as failed and remain retryable', async () => {
    const { context, notices } = harness();
    context.record = fixture('fixture.png', true);
    vm.runInContext("currentUpdateChecks.set('fixture.png', record); batchSelectedAvatars.add('fixture.png');", context);
    await context.applyAllBatchUpdates();
    assert.match(notices[0][0], /Updated 0 characters, 1 failed/);
    assert.equal(vm.runInContext("currentUpdateChecks.has('fixture.png')", context), true);
});

test('unavailable export fields never propose clearing existing local data', () => {
    const { context } = harness();
    context.CoreAPI.getListingNameFromExtensions = () => '';
    const local = { alternate_greetings: ['Keep me'], character_book: { entries: [{ keys: ['keep'], content: 'keep' }] } };
    const card = { data: { alternate_greetings: [] }, _unavailableFields: new Set(['alternate_greetings']), _lorebookUnavailable: true };
    const diffs = context.compareCards(local, card, new Set(['alternate_greetings', 'character_book']));
    assert.equal(diffs.length, 0);
});
