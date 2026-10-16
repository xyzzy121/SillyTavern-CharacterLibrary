import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const moduleSource = await readFile(new URL('../../modules/providers/datacat/datacat-following.js', import.meta.url), 'utf8');
export const { createDatacatFollowingController } = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
const creator = (id = 'a', source = 'datacat') => ({ id, name: id, source });
const page = (offset, count = 50, extra = {}) => ({ rows: Array.from({ length: count }, (_, n) => ({ id: `${offset + n}`, source: 'janitor' })), nextOffset: offset + count, hasMore: true, ...extra });
function setup(fetchPage, extra = {}) {
    const changes = [];
    const controller = createDatacatFollowingController({ fetchPage, getId: row => row.id, getSource: row => row.source,
        onChange: snapshot => changes.push(snapshot), ...extra });
    controller.setCreators([creator()]);
    return { controller, changes };
}
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('initial 60-card view progressively paints after one page instead of draining a 10,000-card creator', async () => {
    const calls = [];
    const { controller, changes } = setup(async (_creator, options) => { calls.push(options); return page(options.offset); });
    const result = await controller.load();
    assert.deepEqual(calls.map(call => call.offset), [0, 50]);
    assert.ok(calls.every(call => call.limit === 50 && call.signal instanceof AbortSignal));
    assert.ok(changes.some(change => change.rows.length === 50 && change.loading));
    assert.equal(result.rows.length, 100);
    assert.equal(result.complete, false);
    await controller.load();
    assert.equal(calls.length, 2, 'reentry uses successful cached pages');
});

test('cached infinite-scroll overshoot cannot inflate the next explicit network target', async () => {
    const browse = (await readFile(new URL('../../modules/providers/datacat/datacat-browse.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    const entry = browse.match(/function loadFollowingCharacters\([^]*?\n}\n/)[0];
    const calls = [];
    const context = vm.createContext({ datacatFollowingDisplayLimit: 10000, datacatFollowingLoading: false,
        datacatFollowingCharacters: Array.from({ length: 100 }, () => ({})), datacatFollowedCreators: [],
        followingCharacterMatches: () => true, loadFollowedCreators() {},
        followingController: { setCreators() {}, load(options) { calls.push(options); } } });
    vm.runInContext(entry + '\nloadFollowingCharacters(false, { more: true });', context);
    assert.equal(calls[0].target, 160);
    assert.equal(context.datacatFollowingDisplayLimit, 10000, 'network target and display ceiling have separate ownership');
});

test('each explicit filtered action admits at most twelve pages without a lifetime ceiling', async () => {
    let calls = 0;
    const { controller } = setup(async (_creator, options) => { calls++; return page(options.offset); });
    for (let action = 0; action < 10; action++) {
        const result = await controller.load({ matches: () => false });
        assert.equal(result.lastActionRequests, 12);
    }
    assert.equal(calls, 120);
    assert.equal(controller.snapshot().rows.length, 6000);
});

test('round-robin pagination reaches later creators across bounded actions with at most three concurrent calls', async () => {
    const calls = [];
    let active = 0; let maximum = 0;
    const { controller } = setup(async (creator, options) => {
        calls.push([creator.id, options.offset]);
        active++; maximum = Math.max(maximum, active);
        await Promise.resolve(); active--;
        return page(options.offset, 50, { rows: page(options.offset).rows.map(row => ({ ...row, id: creator.id + row.id })) });
    });
    controller.setCreators(Array.from({ length: 20 }, (_, n) => creator(String(n))));
    await controller.load({ matches: () => false });
    assert.equal(calls.length, 12);
    assert.equal(new Set(calls.map(call => call[0])).size, 12);
    await controller.load({ matches: () => false });
    assert.equal(new Set(calls.map(call => call[0])).size, 20);
    assert.equal(maximum, 3);
});

test('partial errors retain rows and targeted retry requests only the failed cursor once', async () => {
    const calls = []; let failed = false;
    const { controller } = setup(async (_creator, options) => {
        calls.push(options.offset);
        if (options.offset === 50 && !failed) { failed = true; throw new Error('Unavailable'); }
        return page(options.offset);
    });
    let result = await controller.load();
    assert.equal(result.rows.length, 50);
    assert.equal(result.errors[0].offset, 50);
    assert.equal(result.complete, false);
    result = await controller.load({ retry: true });
    assert.deepEqual(calls, [0, 50, 50]);
    assert.equal(result.rows.length, 100);
    assert.equal(result.errors.length, 0);
});

test('ordinary clicks and repeated manual refreshes coalesce; refresh supersedes an ordinary pending load', async () => {
    const old = gate(); const fresh = gate(); const started = gate(); let calls = 0;
    const { controller } = setup((_creator, { signal }) => { calls++; if (calls === 1) { started.resolve(signal); return old.promise; } return fresh.promise; });
    const first = controller.load();
    assert.equal(controller.load(), first);
    const oldSignal = await started.promise;
    const refresh = controller.load({ refresh: true });
    assert.equal(controller.load({ refresh: true }), refresh);
    assert.equal(oldSignal.aborted, true);
    fresh.resolve(page(10, 1, { hasMore: false }));
    await refresh;
    old.resolve(page(0, 1, { hasMore: false })); await first;
    assert.equal(calls, 2);
    assert.deepEqual(controller.snapshot().rows.map(row => row.id), ['10']);
});

test('deactivation aborts pending pages promptly and ignores late rows while preserving successful cache', async () => {
    const pending = gate(); const entered = gate(); let calls = 0;
    const { controller } = setup(async (_creator, { offset, signal }) => {
        calls++; if (offset === 50) { entered.resolve(signal); return pending.promise; }
        return page(offset);
    });
    const loading = controller.load(); const signal = await entered.promise;
    controller.abort();
    await loading;
    assert.equal(signal.aborted, true);
    assert.equal(controller.snapshot().rows.length, 50);
    pending.resolve(page(50)); await Promise.resolve();
    assert.equal(controller.snapshot().rows.length, 50);
    assert.equal(calls, 2);
});

test('unfollowing removes that contribution, keeps another creator cache, and cannot be undone by a stale response', async () => {
    const late = gate(); const entered = gate();
    const { controller } = setup(async (creator, { signal }) => {
        if (creator.id === 'a') { entered.resolve(signal); return late.promise; }
        return page(0, 1, { rows: [{ id: 'b', source: 'janitor' }], hasMore: false });
    });
    controller.setCreators([creator(), creator('b')]);
    const loading = controller.load(); const signal = await entered.promise;
    await Promise.resolve(); await Promise.resolve();
    controller.setCreators([creator('b')]); await loading;
    late.resolve(page(0));
    assert.equal(signal.aborted, true);
    await controller.load();
    assert.deepEqual(controller.snapshot().rows.map(row => row.id), ['b']);
});

test('source-qualified creator and character keys preserve matching UUIDs from different sources', async () => {
    const { controller } = setup(async creator => ({ rows: [{ id: 'same-uuid', source: creator.source === 'saucepan' ? 'saucepan' : 'janitor' }], hasMore: false }));
    controller.setCreators([creator('same-creator', 'datacat'), creator('same-creator', 'saucepan')]);
    const result = await controller.load();
    assert.equal(result.creatorCount, 2);
    assert.equal(result.rows.length, 2);
    assert.equal(result.complete, true);
});

test('nonadvancing cursors and duplicate pages stop and surface a retryable incomplete page', async () => {
    for (const variant of ['cursor', 'duplicate']) {
        let calls = 0;
        const { controller } = setup(async (_creator, { offset }) => {
            calls++;
            return variant === 'cursor' ? page(offset, 50, { nextOffset: offset }) : page(0, 50, { nextOffset: offset + 50 });
        });
        const result = await controller.load({ matches: () => false });
        assert.equal(calls, variant === 'cursor' ? 1 : 2);
        assert.equal(result.errors.length, 1);
        assert.equal(result.errors[0].error.code, 'invalid_response');
        assert.equal(result.complete, false);
    }
});

test('429 stops new admission; completion and cache staleness remain explicit', async () => {
    let calls = 0; let clock = 0;
    const { controller } = setup(async () => {
        calls++; const error = new Error('Slow down'); error.code = 'rate_limited'; throw error;
    });
    const limited = await controller.load({ matches: () => false });
    assert.equal(calls, 1);
    assert.equal(limited.errors.length, 1);
    const completed = setup(async () => page(0, 1, { hasMore: false }), { now: () => clock }).controller;
    await completed.load(); assert.equal(completed.snapshot().complete, true);
    clock = 300_000;
    assert.equal(completed.snapshot().stale, true);
    await completed.load(); assert.equal(completed.snapshot().rows.length, 1);
});
