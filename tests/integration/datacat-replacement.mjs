// Run only against the disposable independent instance. All DataCat traffic is
// fixture-controlled; imports, snapshots, card writes, chats and galleries are real.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const base = process.env.CL_TEST_BASE_URL || 'http://127.0.0.1:8001';
if (base !== 'http://127.0.0.1:8001') throw new Error('This destructive fixture harness requires the disposable loopback instance on port 8001');
const playwrightPath = process.env.CL_PLAYWRIGHT_MODULE;
const playwright = await import(playwrightPath
    ? pathToFileURL(/\.[cm]?js$/.test(playwrightPath) ? resolve(playwrightPath) : resolve(playwrightPath, 'index.mjs')).href
    : new URL('../../../SillyTavern-WorldInfoDrawer/tests/mobile/node_modules/playwright/index.mjs', import.meta.url).href);
const engine = process.env.CL_TEST_ENGINE || 'chromium';
if (!['chromium', 'webkit'].includes(engine)) throw new Error('CL_TEST_ENGINE must be chromium or webkit');
const viewport = process.env.CL_TEST_MOBILE === '1' ? { width: 390, height: 844 } : { width: 1440, height: 1000 };
const output = resolve(process.env.CL_TEST_OUTPUT || join(process.cwd(), '..', 'datacat-validation', 'replacement-integration', engine));
await mkdir(output, { recursive: true });
const root = '/scripts/extensions/third-party/SillyTavern-CharacterLibrary';
const run = Date.now();
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGJkAAAAASUVORK5CYII=';
const sha = value => createHash('sha256').update(value).digest('hex');
const report = { run, base, engine, viewport, liveDataCatRequests: 0, checks: [], requests: [], blockedExternal: [], console: [], pageErrors: [] };
const records = new Map();
const scenarios = [
    { name: 'successful-multiple-target', mode: 'normal', success: true },
    { name: 'failed-write', mode: 'write-failure' },
    { name: 'http-200-without-write', mode: '200-no-write' },
    { name: 'lost-response-after-commit', mode: 'ambiguous-commit', success: true },
    { name: 'failed-backup-upload', mode: 'backup-failure' },
    { name: 'acknowledged-backup-without-write', mode: 'backup-no-write' },
    { name: 'close-preview-during-commit', mode: 'hold-commit', success: true },
    { name: 'changed-target-after-confirmation-opened', mode: 'stale-target' },
    { name: 'old-only-lorebook-fields', mode: 'book-old-only', success: true },
    { name: 'empty-null-lorebook', mode: 'book-root-null', success: true },
    { name: 'nested-null-lorebook-refused', mode: 'book-nested-null' },
    { name: 'root-null-main-write-fails', mode: 'book-root-null-failure' },
].filter(scenario => !process.env.CL_TEST_SCENARIOS || process.env.CL_TEST_SCENARIOS.split(',').includes(scenario.name));
let browser, context, page, headers;
let active = null, releaseCommit = null, admittedCommit = null;
let writesAdmitted = 0;

async function post(path, data) {
    const response = await context.request.post(base + path, { headers, data });
    const text = await response.text();
    assert.ok(response.ok(), `${path}: HTTP ${response.status()} ${text}`);
    try { return JSON.parse(text); } catch { return { text }; }
}
async function card(avatar) { return post('/api/characters/get', { avatar_url: avatar }); }
async function png(avatar) {
    const response = await context.request.get(`${base}/characters/${encodeURIComponent(avatar)}?qa=${run}-${Date.now()}`);
    assert.ok(response.ok(), 'Existing avatar must remain available');
    return response.body();
}
async function pixelDigest(avatar) {
    return page.evaluate(async ({ base, avatar }) => {
        const response = await fetch(`${base}/characters/${encodeURIComponent(avatar)}?pixels=${Date.now()}`, { cache: 'no-store' });
        const url = URL.createObjectURL(await response.blob());
        try {
            const image = new Image(); image.src = url; await image.decode();
            const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
            const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
            const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            return { width: canvas.width, height: canvas.height, sha256: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('') };
        } finally { URL.revokeObjectURL(url); }
    }, { base, avatar });
}
async function file(name) {
    const response = await context.request.get(`${base}/user/files/${encodeURIComponent(name)}?qa=${Date.now()}`);
    assert.ok(response.ok(), `Expected durable file ${name}: HTTP ${response.status()}`);
    return response.json();
}
async function uploadFile(name, value) {
    return post('/api/files/upload', { name, data: Buffer.from(JSON.stringify(value)).toString('base64') });
}
async function boot() {
    await page.goto(`${base}${root}/app/library.html?csrf=${headers['X-CSRF-Token']}`);
    await page.waitForFunction(() => window.ModuleLoader?.initialized && !document.documentElement.classList.contains('cl-initial-loading'), null, { timeout: 60000 });
    await page.evaluate(async root => {
        window.qaCore = (await import(root + '/modules/core-api.js')).default;
        window.qaProvider = window.ProviderRegistry.getProvider('datacat');
    }, root);
}

async function seedScenario(scenario, index) {
    const runId = (BigInt(run) * 16n + BigInt(index)).toString(16).slice(-12).padStart(12, '0');
    const id = `face${String(index).padStart(4, '0')}-1111-4222-8333-${runId}`;
    const remoteName = `CL replace ${run} ${index} incoming`;
    const remoteCard = { spec: 'chara_card_v2', spec_version: '2.0', data: {
        name: remoteName, description: `New validated definition ${id}`, personality: 'Remote personality',
        scenario: 'Independent replacement regression', first_mes: 'Remote greeting', mes_example: 'Remote examples',
        system_prompt: '', post_history_instructions: '', creator: 'Replacement QA', creator_notes: 'Remote notes',
        character_version: '2.0', tags: ['remote-qa'], alternate_greetings: ['Remote alternate'],
        character_book: { name: 'New book', entries: [{ id: 1, keys: ['new'], content: 'New embedded lore', enabled: true, insertion_order: 1 }] },
        extensions: { gallery_id: 'MUST-NOT-REPLACE', world: 'MUST-NOT-RELINK', fav: false,
            qa: { protected: 'MUST-NOT-REPLACE' }, datacat: { id, sourceKind: 'janitor', definitionSource: 'source', variantId: '' } },
    } };
    records.set(id, { card: remoteCard, character: { character_id: id, name: remoteName, chat_name: remoteName,
        creator_name: 'Replacement QA', primary_content_source_kind: 'janitor', has_source_definition: true,
        has_datacat_reimagination: true, description: 'Listing description', tags: [], total_tokens: 1000 } });
    if (['book-old-only', 'book-root-null', 'book-root-null-failure', 'book-nested-null'].includes(scenario.mode)) {
        remoteCard.data.character_book.extensions = { nested: { current: true } };
    }
    const pair = [];
    for (const suffix of ['A', 'B']) {
        const localName = `CL replace ${run} ${index} local ${suffix}`;
        const uid = `qa_replace_${run}_${index}_${suffix}`;
        const galleryId = `g_${run}_${index}_${suffix}`;
        const local = structuredClone(remoteCard);
        Object.assign(local.data, { name: localName, description: `Original definition ${suffix}`, personality: 'Local personality',
            tags: ['local-qa'], first_mes: 'Local greeting', alternate_greetings: ['Local alternate'],
            character_book: { name: 'Old book', entries: [{ id: 1, keys: ['old'], content: 'Old embedded lore', enabled: true, insertion_order: 1 }] },
            extensions: { gallery_id: galleryId, version_uid: uid, world: `QA linked ${run}`, fav: true, talkativeness: 0.37,
                qa: { protected: 'Local metadata', nested: { retained: true } }, unrelatedNull: null,
                datacat: { id, sourceKind: 'janitor', definitionSource: 'reimagination', variantId: 'outdated', stale: { retained: false }, pageName: 'Old listing', linkedAt: 'old-link' } } });
        if (scenario.mode === 'book-old-only') {
            local.data.character_book.scan_depth = 8;
            local.data.character_book.extensions = { obsolete: true, nested: { old: true, current: false } };
        }
        if (['book-root-null', 'book-root-null-failure'].includes(scenario.mode)) local.data.character_book = null;
        if (scenario.mode === 'book-nested-null') local.data.character_book.extensions = null;
        const response = await context.request.post(base + '/api/characters/import', { headers, multipart: { file_type: 'json',
            avatar: { name: 'local.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(local)) } } });
        assert.ok(response.ok(), await response.text());
        const result = await response.json();
        const avatar = result.file_name.endsWith('.png') ? result.file_name : result.file_name + '.png';
        const chatName = `qa-preservation-${run}-${index}-${suffix}`;
        await post('/api/characters/merge-attributes', { avatar, fav: true, chat: chatName, data: { extensions: { fav: true, talkativeness: 0.37 } } });
        await post('/api/chats/save', { avatar_url: avatar, file_name: chatName, force: true, chat: [
            { user_name: 'QA', character_name: localName, chat_metadata: { note: 'Preserve chat identity' } },
            { name: 'QA', is_user: true, mes: `Protected conversation ${avatar}`, send_date: Date.now() },
        ] });
        const folder = `${localName}_${galleryId}`;
        await post('/api/images/upload', { image, format: 'png', filename: 'qa-preservation', ch_name: folder });
        pair.push({ avatar, uid, galleryId, name: localName, chatName, folder });
    }
    return { ...scenario, id, remoteName, pair };
}

async function exercise(scenario) {
    const evidence = { name: scenario.name, mode: scenario.mode, startedAt: new Date().toISOString(), expectedFaults: [], requestStart: report.requests.length };
    report.checks.push(evidence);
    try {
        await page.evaluate(async () => window.qaCore.refreshCharacters(true));
        await page.evaluate(({ id, name }) => window.qaProvider.openPreview({ character_id: id, name, primary_content_source_kind: 'janitor' }), { id: scenario.id, name: scenario.remoteName });
        const importTrigger = process.env.CL_TEST_MOBILE === '1'
            ? page.locator('#datacatCharModal .mobile-quick-import-btn') : page.locator('#datacatImportBtn');
        await importTrigger.waitFor({ state: 'visible' });
        await page.waitForFunction(() => !document.querySelector('#datacatImportBtn')?.disabled);
        await importTrigger.click();
        await page.locator('#preImportDuplicateModal.visible').waitFor();
        const radios = page.locator('input[name="preImportReplacementTarget"]');
        assert.ok(await radios.count() >= 2, 'The actual duplicate dialog must expose multiple targets');
        const targetAvatar = await radios.nth(1).getAttribute('value');
        const target = scenario.pair.find(item => item.avatar === targetAvatar);
        assert.ok(target, 'Explicit target must belong to the current synthetic duplicate pair');
        await radios.nth(1).check();
        const other = scenario.pair.find(item => item.avatar !== targetAvatar);
        const before = await card(targetAvatar), otherBefore = await card(other.avatar);
        const beforePng = await png(targetAvatar), beforePixels = await pixelDigest(targetAvatar);
        const beforeChat = await post('/api/chats/get', { avatar_url: targetAvatar, file_name: target.chatName });
        const beforeGallery = await post('/api/images/list', { folder: target.folder });
        const beforePlaylist = await file('_cl_playlists.json');
        const beforePrefs = await page.evaluate(() => window.qaCore.getSetting('namePreferences'));
        evidence.target = target;
        evidence.protected = { avatar: before.avatar, name: before.name, chat: before.chat, fav: before.fav, create_date: before.create_date,
            galleryId: before.data.extensions.gallery_id, versionUid: before.data.extensions.version_uid, image: beforePixels };
        await page.screenshot({ path: join(output, `${scenario.name}-confirmation.png`), fullPage: true });
        active = { ...scenario, targetAvatar, uid: target.uid };
        writesAdmitted = 0;
        let admitted;
        let admissionTimer;
        if (scenario.mode === 'hold-commit') admitted = new Promise(resolve => { admittedCommit = resolve; });
        if (scenario.mode === 'stale-target') {
            await post('/api/characters/merge-attributes', { avatar: targetAvatar, data: { description: 'Edited after the duplicate dialog opened' } });
        }
        await page.locator('#preImportReplaceBtn').click();
        if (scenario.mode === 'hold-commit') {
            try {
                await Promise.race([admitted, new Promise((_, reject) => { admissionTimer = setTimeout(() => reject(new Error('Commit admission timed out')), 20000); })]);
            } finally { clearTimeout(admissionTimer); }
            await page.locator('#datacatCharClose').click();
            await page.waitForFunction(() => document.querySelector('#datacatCharModal').classList.contains('hidden'));
            releaseCommit();
        }
        if (scenario.success) {
            await page.waitForFunction(() => document.querySelector('#datacatCharModal').classList.contains('hidden'), null, { timeout: 30000 });
            // The close-during-commit preview was already hidden. Wait for the
            // actual saved result plus the application's trailing refresh.
            await page.waitForFunction(({ avatar, description }) => {
                const char = window.qaCore.getCharacterByAvatar(avatar);
                return char?.data?.description === description || char?._slim && char.creator === 'Replacement QA';
            }, { avatar: targetAvatar, description: records.get(scenario.id).card.data.description }, { timeout: 30000 });
            let after;
            for (let attempt = 0; attempt < 100; attempt++) {
                after = await card(targetAvatar);
                if (after.data.description === records.get(scenario.id).card.data.description) break;
                await page.waitForTimeout(100);
            }
            assert.equal(after.data.description, records.get(scenario.id).card.data.description);
            assert.equal(after.data.name, before.data.name);
            for (const key of ['avatar', 'name', 'fav', 'chat', 'create_date']) assert.deepEqual(after[key], before[key], `Protected ${key}`);
            for (const key of ['gallery_id', 'version_uid', 'world', 'fav', 'talkativeness', 'qa', 'unrelatedNull']) {
                assert.deepEqual(after.data.extensions[key], before.data.extensions[key], `Protected namespace ${key}`);
            }
            assert.deepEqual(await pixelDigest(targetAvatar), beforePixels);
            assert.equal(after.data.extensions.datacat.id, scenario.id);
            assert.equal(after.data.extensions.datacat.definitionSource, 'source');
            assert.equal(after.data.extensions.datacat.variantId, '');
            assert.equal(after.data.extensions.datacat.stale, undefined);
            assert.deepEqual(after.data.character_book, records.get(scenario.id).card.data.character_book);
            const history = await file(`_clv_${target.uid}.json`);
            const snapshot = history.snapshots.find(snapshot => snapshot.source === 'replacement_backup');
            assert.ok(snapshot, 'The replacement must have a persisted mandatory snapshot');
            assert.equal(snapshot.data.description, before.data.description);
            assert.equal(sha(Buffer.from(snapshot.data._avatarImageData.split(',')[1], 'base64')), sha(beforePng));
            const index = await file('_clv_index.json');
            assert.equal(index.avatarMap[targetAvatar], target.uid);
            evidence.backup = { snapshotId: snapshot.id, versionUid: target.uid, oldPngSha256: sha(beforePng) };
            assert.equal(writesAdmitted, scenario.mode === 'book-root-null' ? 2 : 1, 'One main commit plus only a required empty-null preparation; no retry');
        } else {
            await page.waitForFunction(() => {
                const button = document.querySelector('#datacatImportBtn');
                return button && !button.disabled && button.textContent.trim() === 'Import';
            }, null, { timeout: 30000 });
            const after = await card(targetAvatar);
            if (scenario.mode === 'stale-target') assert.equal(after.data.description, 'Edited after the duplicate dialog opened');
            else if (scenario.mode === 'book-root-null-failure') {
                const expectedData = structuredClone(before.data); delete expectedData.character_book;
                assert.deepEqual(after.data, expectedData, 'Failed main commit preserves authored data; only the semantically empty null marker was prepared');
                for (const key of ['avatar', 'name', 'fav', 'chat', 'create_date']) assert.deepEqual(after[key], before[key]);
                const history = await file(`_clv_${target.uid}.json`);
                const snapshot = history.snapshots.find(snapshot => snapshot.source === 'replacement_backup');
                assert.equal(sha(Buffer.from(snapshot.data._avatarImageData.split(',')[1], 'base64')), sha(beforePng));
                evidence.emptyNullPrepared = true;
                evidence.backup = { versionUid: target.uid, snapshotId: snapshot.id, oldPngSha256: sha(beforePng) };
            } else {
                assert.deepEqual(after, before, 'Failed replacement preserves the original card');
                assert.equal(sha(await png(targetAvatar)), sha(beforePng), 'Failed replacement preserves the original PNG bytes');
            }
            assert.equal(writesAdmitted, scenario.mode === 'book-root-null-failure' ? 2 : ['write-failure', '200-no-write'].includes(scenario.mode) ? 1 : 0);
            await page.screenshot({ path: join(output, `${scenario.name}-result.png`), fullPage: true });
            await page.locator('#datacatCharClose').click();
        }
        active = null;
        assert.deepEqual(await card(other.avatar), otherBefore, 'Unselected duplicate remains unchanged');
        assert.deepEqual(await post('/api/chats/get', { avatar_url: targetAvatar, file_name: target.chatName }), beforeChat);
        assert.deepEqual(await post('/api/images/list', { folder: target.folder }), beforeGallery);
        assert.deepEqual(await file('_cl_playlists.json'), beforePlaylist);
        assert.deepEqual(await page.evaluate(() => window.qaCore.getSetting('namePreferences')), beforePrefs);
        assert.equal(await page.evaluate(avatar => window.qaCore.getAllCharacters().filter(char => char.avatar === avatar).length, targetAvatar), 1);
        evidence.status = 'passed';
        evidence.writesAdmitted = writesAdmitted;
    } catch (error) {
        evidence.status = 'failed'; evidence.error = error.stack;
        process.exitCode = 1;
        await page.screenshot({ path: join(output, `${scenario.name}-failure.png`), fullPage: true }).catch(() => {});
    } finally {
        active = null; releaseCommit?.(); releaseCommit = null; admittedCommit = null;
        evidence.requests = report.requests.slice(evidence.requestStart);
        await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
        // A failure must not strand a modal or contaminate the following case.
        await boot();
    }
}

try {
    browser = await playwright[engine].launch({ headless: true });
    context = await browser.newContext({ viewport, ...(process.env.CL_TEST_MOBILE === '1' ? { isMobile: true, hasTouch: true } : {}) });
    headers = { 'X-CSRF-Token': (await (await context.request.get(base + '/csrf-token')).json()).token };
    const seeded = [];
    for (let index = 0; index < scenarios.length; index++) seeded.push(await seedScenario(scenarios[index], index + 1));
    const avatars = seeded.flatMap(scenario => scenario.pair.map(item => item.avatar));
    await uploadFile('_cl_playlists.json', { version: 1, order: ['qa-replacement'], playlists: {
        'qa-replacement': { name: `Replacement QA ${run}`, description: 'Protected membership', icon: '', color: '', created: run, modified: run, characters: avatars },
    } });
    page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) report.console.push({ type: message.type(), message: message.text(), scenario: active?.name }); });
    await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== base && !['data:', 'blob:', 'about:'].includes(url.protocol)) {
            report.blockedExternal.push(request.url());
            return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><p>Controlled external fixture</p>' });
        }
        if (url.pathname.includes('/dc-proxy/')) {
            report.requests.push({ type: 'remote-fixture', path: url.pathname, scenario: active?.name });
            const match = url.pathname.match(/\/characters\/([0-9a-f-]{36})(\/download)?$/i);
            if (match) {
                const record = records.get(match[1]);
                return route.fulfill(record ? { json: match[2] ? record.card : { character: record.character } }
                    : { status: 404, json: { code: 'NOT_FOUND' } });
            }
            return route.fulfill({ json: { characters: [], tags: [], total: 0, features: {} } });
        }
        if (/\/api\/plugins\/cl-helper\/dc-/.test(url.pathname)) return route.fulfill({ json: { success: true, valid: true, token: 'fixture-only', sessionToken: 'fixture-only' } });
        if (url.pathname.startsWith('/proxy/') || /\/api\/(horde|backends)\//.test(url.pathname)) return route.fulfill({ status: 503, json: { error: 'External service disabled in replacement fixtures' } });
        if (request.method() === 'POST' && url.pathname === '/api/characters/delete') {
            report.requests.push({ type: 'FORBIDDEN-delete', scenario: active?.name });
            return route.fulfill({ status: 500, body: 'Replacement must never delete a card' });
        }
        if (request.method() === 'POST' && url.pathname === '/api/characters/import') {
            report.requests.push({ type: 'FORBIDDEN-import', scenario: active?.name });
            return route.fulfill({ status: 500, body: 'Replacement must never import another card' });
        }
        if (active && request.method() === 'POST' && url.pathname === '/api/files/upload') {
            const body = request.postDataJSON();
            if (body.name === `_clv_${active.uid}.json`) {
                report.requests.push({ type: 'backup-upload', scenario: active.name, mode: active.mode });
                if (active.mode === 'backup-failure') return route.fulfill({ status: 503, body: 'Injected snapshot disk failure' });
                if (active.mode === 'backup-no-write') return route.fulfill({ json: { path: `user/files/${body.name}` } });
            }
        }
        if (active && request.method() === 'POST' && url.pathname === '/api/characters/merge-attributes'
            && request.postDataJSON().avatar === active.targetAvatar) {
            const ownedNullPreparation = request.postDataJSON().data?.character_book === '__@@UNSET@@__';
            writesAdmitted++;
            report.requests.push({ type: ownedNullPreparation ? 'owned-null-preflight' : 'local-commit', scenario: active.name, mode: active.mode });
            if (active.mode === 'write-failure') return route.fulfill({ status: 503, body: 'Injected character write failure' });
            if (active.mode === 'book-root-null-failure' && !ownedNullPreparation) return route.fulfill({ status: 503, body: 'Injected main write failure after verified empty-null preparation' });
            if (active.mode === '200-no-write') return route.fulfill({ status: 200, body: 'OK' });
            if (active.mode === 'ambiguous-commit') {
                const response = await route.fetch(); assert.ok(response.ok());
                return route.abort('failed');
            }
            if (active.mode === 'hold-commit') {
                admittedCommit?.();
                await new Promise(resolve => { releaseCommit = resolve; });
            }
        }
        return route.continue();
    });
    await boot();
    await page.evaluate(avatars => {
        window.qaCore.setSettings({ uniqueGalleryFolders: true, autoSnapshotOnEdit: false,
            namePreferences: Object.fromEntries(avatars.map(avatar => [avatar, 'chat_name'])) });
    }, avatars);
    for (const scenario of seeded) await exercise(scenario);
    await boot();
    const reloaded = await page.evaluate(avatars => ({ counts: avatars.map(avatar => ({ avatar,
        count: window.qaCore.getAllCharacters().filter(char => char.avatar === avatar).length })), prefs: window.qaCore.getSetting('namePreferences') }), avatars);
    assert.ok(reloaded.counts.every(item => item.count === 1), 'Reload must retain one entry per existing avatar');
    assert.ok(avatars.every(avatar => reloaded.prefs[avatar] === 'chat_name'), 'Name preferences must persist through reload');
    assert.equal(report.requests.filter(request => request.type.startsWith('FORBIDDEN')).length, 0);
    assert.deepEqual(report.pageErrors, []);
    report.reload = reloaded;
} catch (error) {
    report.fatal = error.stack; process.exitCode = 1;
} finally {
    releaseCommit?.();
    await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
    await browser?.close();
    console.log(JSON.stringify({ checks: report.checks.map(({ name, status, error }) => ({ name, status, error })), fatal: report.fatal, output }, null, 2));
}
