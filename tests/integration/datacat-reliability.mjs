// Real independent SillyTavern + production Character Library, with every external response replaced locally.
// ST_BASE_URL must identify a disposable profile. Optional CL_QA_IMPORTS=1 creates synthetic cards there.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const playwrightModule = process.env.PLAYWRIGHT_MODULE || new URL('../../../SillyTavern-WorldInfoDrawer/tests/mobile/node_modules/playwright/index.mjs', import.meta.url).href;
const { chromium, webkit } = await import(playwrightModule);
const base = new URL(process.env.ST_BASE_URL || 'http://127.0.0.1:8001').origin;
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'Use only the independent loopback server');
assert.equal(new URL(base).port, '8001', 'This harness is restricted to the independent test server on port 8001');
const root = process.env.CL_LIBRARY_ROOT || '/scripts/extensions/third-party/SillyTavern-CharacterLibrary';
const out = path.resolve(process.env.CL_QA_OUTPUT || '../datacat-validation/reliability');
const only = process.env.PROBE_ONLY || '';
const selectedCases = process.env.CL_QA_CASES?.split(',');
const chosenProfiles = process.env.CL_QA_PROFILES?.split(',');
const doImports = process.env.CL_QA_IMPORTS === '1';
await fs.mkdir(out, { recursive: true });
const profiles = [
    { name: 'chromium-desktop', engine: 'chromium', width: 1440, height: 1000 },
    { name: 'chromium-320', engine: 'chromium', width: 320, height: 568, mobile: true, cpu: 4 },
    { name: 'chromium-390', engine: 'chromium', width: 390, height: 844, mobile: true, cpu: 4 },
    { name: 'chromium-landscape', engine: 'chromium', width: 844, height: 390, mobile: true, cpu: 4 },
    { name: 'webkit-390', engine: 'webkit', width: 390, height: 844, mobile: true },
    { name: 'webkit-landscape', engine: 'webkit', width: 844, height: 390, mobile: true },
].filter(profile => !chosenProfiles || chosenProfiles.includes(profile.name));
const browsers = new Map();
const results = [];
const creatorId = 'aaaaaaaa-1111-2222-3333-444444444444';
const characterId = 'bbbbbbbb-1111-2222-3333-444444444444';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function until(predicate, timeout = 15000) {
    const deadline = performance.now() + timeout;
    while (!await predicate()) { assert.ok(performance.now() < deadline, 'Timed out waiting for fixture observation'); await pause(25); }
}
const row = (index = 0, overrides = {}) => ({ character_id: index === 0 ? characterId : `bbbbbbbb-1111-2222-3333-${String(index).padStart(12, '0')}`,
    name: `Reliability fixture ${index}`, creator_id: creatorId, creator_name: 'Synthetic Creator',
    primary_content_source_kind: 'janitor', total_tokens: 1200, created_at: new Date(1_760_000_000_000 - index * 1000).toISOString(),
    description: 'Local reliability fixture', ...overrides });
const smallTags = Array.from({ length: 8 }, (_, n) => ({ id: n + 1, name: `Synthetic tag ${n}`, slug: `synthetic-${n}`, count: 8 - n }));
const largeTags = { groups: Array.from({ length: 6 }, (_, n) => ({ id: n + 1, name: `Curated group ${n}`, display_order: n })),
    tags: Array.from({ length: 107884 }, (_, n) => ({ id: n + 1, name: `Synthetic tag ${String(n).padStart(6, '0')}`, slug: `synthetic-${n}`,
        groupId: n < 36 ? (n % 6) + 1 : null, count: 107884 - n })) };
const json = (route, value, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(value) });
const health = { ok: true, version: '1.13.2', pluginVersion: '1.13.2', capabilities: { datacatCancellation: true, datacatRequestGate: true } };
const basicPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const companionSource = await fs.readFile(new URL('../../extras/cl-datacat-bridge.user.js', import.meta.url), 'utf8');

// Served from the intercepted Datacat origin; nothing reaches that origin on the network.
const frameHtml = `<!doctype html><meta name="viewport" content="width=device-width"><script>
window.__qaBuildCalls=[];window.__qaPointerEvents=[];for(const type of ['pointerdown','pointerup','click'])addEventListener(type,event=>window.__qaPointerEvents.push({type,trusted:event.isTrusted,target:event.target?.textContent?.slice(0,80),x:event.clientX,y:event.clientY}),true);
const bytes=Uint8Array.from(atob('${basicPng.toString('base64')}'),c=>c.charCodeAt(0));
function crc(data){let value=0xffffffff;for(const byte of data){value^=byte;for(let n=0;n<8;n++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;}
function png(card){const value='chara\\0'+btoa(unescape(encodeURIComponent(JSON.stringify(card))));const text=Uint8Array.from(value,c=>c.charCodeAt(0));const chunk=new Uint8Array(12+text.length),view=new DataView(chunk.buffer);view.setUint32(0,text.length);chunk.set([116,69,88,116],4);chunk.set(text,8);view.setUint32(8+text.length,crc(chunk.subarray(4,8+text.length)));const output=new Uint8Array(bytes.length+chunk.length);output.set(bytes.subarray(0,bytes.length-12));output.set(chunk,bytes.length-12);output.set(bytes.subarray(bytes.length-12),bytes.length-12+chunk.length);return output.buffer;}
window.DatacatCharacterExport={getCurrentModalContext:()=>({characterId:location.pathname.split('/').at(-1),sourceKind:'janitor'}),buildPngPayload:async(characterId,name,creator,variant,source,options)=>{window.__qaBuildCalls.push(characterId);const card={spec:'chara_card_v2',spec_version:'2.0',data:{name:'Synthetic frame export',description:characterId,extensions:{datacat:{id:characterId,definitionSource:options.definitionSource}}}};return{pngBytes:png(card),cardData:card};}};
</script><body><script>${companionSource.replace(/<\/script>/gi, '<\\/script>')}</script></body>`;

async function scenario(name, profile, run, configure = () => {}) {
    if (only && !name.includes(only)) return;
    const label = `${profile.name}-${name}`;
    if (selectedCases && !selectedCases.includes(label)) return;
    const evidence = { label, name, profile, startedAt: new Date().toISOString(), requests: [], httpErrors: [], pageErrors: [], console: [], blockedExternal: [], syntheticFrames: [], observations: {} };
    let browser = browsers.get(profile.engine);
    if (!browser) { browser = await ({ chromium, webkit }[profile.engine]).launch({ headless: true }); browsers.set(profile.engine, browser); }
    const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, isMobile: !!profile.mobile, hasTouch: !!profile.mobile });
    const page = await context.newPage();
    const requests = new Map();
    const releases = [];
    const state = { page, context, evidence, handler: null, tags: { groups: [], tags: smallTags }, feed: { characters: [row()], total: 1, hasMore: false },
        hold() { const held = gate(); releases.push(held.release); return held; },
        async release(route, value, held) { await held.promise; try { await json(route, value); } catch { /* Browser cancellation is asserted through requestfailed. */ } } };
    page.on('request', request => {
        const url = new URL(request.url());
        if (!url.pathname.includes('/plugins/cl-helper/')) return;
        const entry = { path: url.pathname, query: Object.fromEntries(url.searchParams), method: request.method(), started: performance.now() };
        evidence.requests.push(entry); requests.set(request, entry);
    });
    page.on('requestfailed', request => { const entry = requests.get(request); if (entry) { entry.failed = request.failure()?.errorText; entry.finished = performance.now(); } });
    page.on('requestfinished', request => { const entry = requests.get(request); if (entry) entry.finished = performance.now(); });
    page.on('response', response => {
        const entry = requests.get(response.request()); if (entry) entry.status = response.status();
        if (response.status() >= 400) { const url = new URL(response.url()); evidence.httpErrors.push({ path: url.pathname, status: response.status() }); }
    });
    page.on('pageerror', error => evidence.pageErrors.push(error.stack || error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) evidence.console.push({ type: message.type(), text: message.text() }); });
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === 'https://datacat.run' && url.searchParams.has('cl_datacat_export')) {
            evidence.syntheticFrames.push(url.pathname);
            return route.fulfill({ contentType: 'text/html; charset=utf-8', body: frameHtml });
        }
        if (url.origin !== base && !['data:', 'blob:', 'about:'].includes(url.protocol)) {
            evidence.blockedExternal.push(url.origin + url.pathname);
            return route.abort('blockedbyclient');
        }
        const pathname = url.pathname;
        if (!pathname.includes('/plugins/cl-helper/')) return route.continue();
        if (state.handler && await state.handler(route, url, requests.get(route.request()))) return;
        if (pathname.endsWith('/health')) return json(route, health);
        if (pathname.endsWith('/dc-init')) return json(route, { ok: true, success: true, token: 'synthetic-reliability-token' });
        if (pathname.endsWith('/dc-set-token')) return json(route, { success: true });
        if (pathname.endsWith('/dc-validate')) return json(route, { valid: true });
        if (pathname.endsWith('/api/tags/faceted')) return json(route, state.tags);
        if (pathname.endsWith('/api/characters/recent-public')) return json(route, state.feed);
        if (pathname.includes('/api/characters/fresh')) return json(route, { windows: { last24h: state.feed, thisWeek: { characters: [], hasMore: false } } });
        if (pathname.endsWith('/api/features')) return json(route, { janitorRetrievalDisabledForViewer: false, saucepanRetrievalDisabledForViewer: false });
        if (pathname.includes('/api/characters/')) return json(route, { error: 'not_found', message: 'Not found' }, 404);
        if (pathname.includes('/dc-proxy/')) return json(route, { error: 'fixture_missing', message: 'No remote endpoint is allowed in this test' }, 503);
        return json(route, { ok: true, success: true });
    });
    try {
        await configure(state);
        const csrf = (await (await context.request.get(base + '/csrf-token')).json()).token;
        state.csrf = csrf;
        await page.goto(base + root + '/app/library.html?csrf=' + encodeURIComponent(csrf), { waitUntil: 'networkidle' });
        await page.waitForFunction(() => window.ModuleLoader?.initialized && !document.documentElement.classList.contains('cl-initial-loading'));
        await page.evaluate(() => {
            window.setSetting('disabledProviders', []); window.setSetting('providerOrder', ['datacat']);
            window.setSetting('datacatToken', null); window.setSetting('datacatFollowedCreators', []);
            window.setSetting('datacatPublicFeed', false); window.setSetting('datacatNsfw', false);
            window.setSetting('infiniteScroll', { datacat: true });
        });
        state.activate = async (wait = true) => {
            await page.evaluate(() => window.switchView('online'));
            await page.locator('#datacatGrid').waitFor({ state: 'attached' });
            if (wait) await page.locator('#datacatGrid .browse-card').first().waitFor();
        };
        state.follow = async () => {
            await page.evaluate(id => window.setSetting('datacatFollowedCreators', [{ id, name: 'Synthetic Creator', source: 'datacat' }]), creatorId);
            await page.locator('[data-datacat-view="following"]').click();
        };
        state.openTags = async () => {
            if (profile.mobile) {
                await page.locator('#mobileNavFiltersBtn').click();
                await page.locator('.mobile-settings-body .mobile-filter-chip:visible').filter({ hasText: /^\s*Tags\s*$/ }).click();
            } else await page.locator('#datacatTagsBtn').click();
            await page.locator('#datacatTagsList .browse-tag-filter-item').first().waitFor();
        };
        state.aborted = pathPart => evidence.requests.some(request => request.path.includes(pathPart) && !!request.failed);
        await run(state);
        const unexpected = evidence.pageErrors.filter(error => !/SpeechSynthesis/i.test(error));
        assert.deepEqual(unexpected, [], 'Unexpected browser page errors');
        evidence.status = 'passed';
    } catch (error) {
        evidence.status = 'failed'; evidence.error = error.stack || String(error); process.exitCode = 1;
        evidence.exportDiagnostic = await page.evaluate(() => ({ exports: window.__qaExports, received: window.__qaReceived,
            status: document.querySelector('#datacatExportPanel .dc-export-status')?.textContent })).catch(() => null);
        const frame = page.frames().find(frame => frame.url().startsWith('https://datacat.run'));
        if (frame) evidence.frameDiagnostic = await frame.evaluate(() => ({ path: location.pathname, calls: window.__qaBuildCalls,
            pointerEvents: window.__qaPointerEvents, dock: document.getElementById('cl-datacat-export-companion')?.textContent })).catch(() => null);
    }
    finally {
        for (const release of releases) release();
        await page.screenshot({ path: path.join(out, label + '.png'), fullPage: true }).catch(() => {});
        evidence.finishedAt = new Date().toISOString();
        await fs.writeFile(path.join(out, label + '.json'), JSON.stringify(evidence, null, 2));
        results.push(evidence);
        await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), base, root, cases: results }, null, 2));
        console.log(JSON.stringify({ label, status: evidence.status, observations: evidence.observations, error: evidence.error }));
        await context.close();
    }
}

const desktop = profiles.find(profile => profile.name === 'chromium-desktop');
try {
if (desktop) {
    await scenario('following-progressive', desktop, async state => {
        const { page, evidence } = state; const second = state.hold(); let count = 0;
        state.handler = async (route, url) => {
            if (!/\/api\/creators\/[^/]+\/characters$/.test(url.pathname)) return false;
            const offset = Number(url.searchParams.get('offset')); count++;
            assert.equal(Number(url.searchParams.get('limit')), 50);
            if (count === 2) await second.promise;
            await json(route, { list: Array.from({ length: 50 }, (_, n) => row(offset + n)), total: 10000, hasMore: true, nextOffset: offset + 50 }); return true;
        };
        await state.activate(); const start = performance.now(); await state.follow();
        await until(() => count === 2); await page.waitForFunction(() => document.querySelectorAll('#datacatFollowingGrid .browse-card').length === 50);
        evidence.observations.firstPaint = { requests: count, cards: 50, elapsedMs: performance.now() - start };
        second.release(); await page.locator('#datacatFollowingNetworkMoreBtn').waitFor(); await until(() => page.locator('#datacatFollowingNetworkMoreBtn').isEnabled());
        assert.equal(count, 2); assert.match(await page.locator('#datacatFollowingStatus').innerText(), /sorted among loaded/i);
        await page.evaluate(() => { const element = document.querySelector('.gallery-content'); element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
        await pause(400); assert.equal(count, 2, 'infinite scroll must only reveal cached cards');
        for (const sort of ['name_asc', 'name_desc', 'oldest', 'chat_count', 'newest']) await page.locator('#datacatFollowingSortSelect').selectOption(sort, { force: true });
        assert.equal(count, 2, 'all five sorts reuse fetched cards');
        await page.locator('#datacatFollowingNetworkMoreBtn').click(); await until(() => page.locator('#datacatFollowingNetworkMoreBtn').isEnabled());
        assert.equal(count, 4); evidence.observations.requestsAfterExplicitMore = count;
    });
    await scenario('following-budget', desktop, async state => {
        const { page, evidence } = state; let count = 0;
        state.handler = async (route, url) => {
            if (!/\/api\/creators\/[^/]+\/characters$/.test(url.pathname)) return false;
            const offset = Number(url.searchParams.get('offset')); count++;
            await json(route, { list: Array.from({ length: 50 }, (_, n) => row(offset + n, { is_nsfw: true, isNsfw: true })), hasMore: true, nextOffset: offset + 50 }); return true;
        };
        await state.activate(); await state.follow(); await until(() => count === 12);
        await until(() => page.locator('#datacatFollowingNetworkMoreBtn').isEnabled());
        assert.equal(await page.locator('#datacatFollowingGrid .browse-card').count(), 0);
        await page.evaluate(() => { const element = document.querySelector('.gallery-content'); element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
        await pause(450); assert.equal(count, 12);
        await page.locator('#datacatFollowingNetworkMoreBtn').click(); await until(() => count === 24);
        await until(() => page.locator('#datacatFollowingNetworkMoreBtn').isEnabled());
        assert.equal(count, 24); evidence.observations = { requestsPerAction: [12, 12], mountedMatchingCards: await page.locator('#datacatFollowingGrid .browse-card').count() };
    });
    await scenario('following-partial-retry', desktop, async state => {
        const { page, evidence } = state; const offsets = []; let outage = true;
        state.handler = async (route, url) => {
            if (!/\/api\/creators\/[^/]+\/characters$/.test(url.pathname)) return false;
            const offset = Number(url.searchParams.get('offset')); offsets.push(offset);
            if (offset === 50 && outage) { outage = false; await json(route, { error: 'service_unavailable', message: 'Synthetic outage' }, 503); }
            else await json(route, { list: Array.from({ length: 50 }, (_, n) => row(offset + n)), total: 100, hasMore: offset === 0, nextOffset: offset + 50 });
            return true;
        };
        await state.activate(); await state.follow(); await page.locator('#datacatFollowingRetryBtn').waitFor();
        await until(() => page.locator('#datacatFollowingRetryBtn').isEnabled());
        assert.match(await page.locator('#datacatFollowingErrors').innerText(), /incomplete/i);
        assert.equal(await page.locator('#datacatFollowingGrid .browse-card').count(), 50);
        await page.locator('#datacatFollowingRetryBtn').click(); await page.locator('#datacatFollowingErrors').waitFor({ state: 'hidden' });
        assert.deepEqual(offsets, [0, 50, 50]); evidence.observations.offsets = offsets;
    });
    for (const kind of ['browse', 'following', 'following-mode', 'detail', 'initialization']) await scenario(`${kind}-cancellation`, desktop, async state => {
        const { page, evidence } = state; const held = state.hold(); let pendingPath = ''; let admitted = 0;
        if (kind !== 'initialization') await state.activate();
        state.handler = async (route, url) => {
            const target = kind === 'initialization' ? url.pathname.endsWith('/health')
                : kind === 'browse' ? url.pathname.endsWith('/api/characters/recent-public')
                    : kind.startsWith('following') ? /\/api\/creators\/[^/]+\/characters$/.test(url.pathname)
                        : url.pathname.endsWith(`/api/characters/${characterId}`);
            if (!target) return false;
            pendingPath = url.pathname; admitted++;
            await state.release(route, kind === 'initialization' ? health : kind === 'detail' ? { character: row() } : kind.startsWith('following') ? { list: [row()], total: 1, hasMore: false } : state.feed, held);
            return true;
        };
        if (kind === 'browse') { await page.locator('#datacatSearchInput').fill('pending fixture'); await page.locator('#datacatSearchInput').press('Enter'); }
        else if (kind.startsWith('following')) await state.follow();
        else if (kind === 'detail') await page.locator('#datacatGrid .browse-card').first().click();
        else await state.activate(false);
        await until(() => admitted > 0);
        const before = evidence.requests.length;
        if (kind === 'detail') await page.locator('#datacatCharClose').click();
        else if (kind === 'following-mode') await page.locator('[data-datacat-view="browse"]').click();
        else await page.evaluate(() => window.switchView('characters'));
        await until(() => state.aborted(pendingPath));
        held.release(); await pause(300);
        if (kind === 'detail') assert.equal(await page.locator('#datacatCharModal').evaluate(element => element.classList.contains('hidden')), true);
        else if (kind === 'following-mode') { assert.equal(await page.evaluate(() => window.getCurrentView()), 'online'); await page.locator('#datacatFollowingSection').waitFor({ state: 'hidden' }); }
        else assert.equal(await page.evaluate(() => window.getCurrentView()), 'characters');
        if (kind === 'initialization') assert.equal(evidence.requests.slice(before).filter(request => /dc-init|recent-public/.test(request.path)).length, 0);
        evidence.observations = { aborted: true, pendingPath, admitted, currentView: await page.evaluate(() => window.getCurrentView()) };
    });
    await scenario('reverse-facets', desktop, async state => {
        const { page, evidence } = state; await state.activate(); await state.openTags();
        const older = state.hold(); const newer = state.hold(); let count = 0;
        state.handler = async (route, url) => {
            if (!url.pathname.endsWith('/api/tags/faceted')) return false;
            const number = ++count;
            await state.release(route, { groups: [], tags: smallTags.map(tag => ({ ...tag, count: number === 1 ? 111 : 222 })) }, number === 1 ? older : newer);
            return true;
        };
        await page.locator('#datacatTagsList [data-tag-id="1"] button').click(); await until(() => count === 1);
        await page.locator('#datacatTagsList [data-tag-id="2"] button').click(); await until(() => count === 2);
        newer.release(); await page.waitForFunction(() => document.getElementById('datacatTagsList').textContent.includes('(222)'));
        older.release(); await pause(300);
        const text = await page.locator('#datacatTagsList').innerText(); assert.match(text, /\(222\)/); assert.doesNotMatch(text, /\(111\)/);
        assert.equal(await page.locator('#datacatTagsList .state-include').count(), 2);
        evidence.observations = { admittedFacetRequests: count, olderRequestAborted: state.aborted('/api/tags/faceted'), newestCountsRetained: true };
    });
}

for (const profile of profiles) {
    await scenario('tags-focus-and-catalog', profile, async state => {
        const { page, context, evidence } = state;
        if (profile.cpu) { const cdp = await context.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu }); }
        await page.evaluate(() => { window.__qaLongTasks = []; try { new PerformanceObserver(list => window.__qaLongTasks.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask', buffered: true }); } catch {} });
        const start = performance.now(); await state.activate(); await state.openTags();
        evidence.observations.activationToTagsReadyMs = performance.now() - start;
        if (profile.mobile) {
            const tappedAt = performance.now(); await page.locator('#datacatTagsSearchInput').tap();
            assert.equal(await page.evaluate(() => document.activeElement?.id), 'datacatTagsSearchInput', 'a deliberate tap retains input focus after opening');
            evidence.observations.deliberateSearchTap = { retainedFocus: true, actionMs: performance.now() - tappedAt };
        }
        evidence.observations.catalogSize = 107884; evidence.observations.groups = 6;
        const mounted = await page.locator('#datacatTagsList .browse-tag-filter-item').count(); assert.ok(mounted < 600, 'tag DOM remains chunked');
        evidence.observations.initialMountedRows = mounted;
        // Three repetitions distinguish noisy paint scheduling from synchronous input-handler cost.
        evidence.observations.inputSamples = await page.evaluate(async () => {
            const input = document.getElementById('datacatTagsSearchInput'); const samples = [];
            for (let repeat = 0; repeat < 3; repeat++) for (const query of ['synthetic tag 107883', 'no-matching-fixture', '']) {
                const started = performance.now(); input.value = query; input.dispatchEvent(new Event('input', { bubbles: true })); const syncMs = performance.now() - started;
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                samples.push({ repeat, query, syncMs, paintMs: performance.now() - started, mountedRows: document.querySelectorAll('#datacatTagsList .browse-tag-filter-item').length });
            }
            return samples;
        });
        evidence.observations.openScreenshot = `${profile.name}-tags-open.png`;
        await page.screenshot({ path: path.join(out, evidence.observations.openScreenshot), fullPage: true });
        if (profile.mobile) {
            await pause(450); await page.locator('#datacatTagsSearchInput').tap();
            const close = page.locator('#datacatTagsCloseBtn'); const box = await close.boundingBox();
            assert.ok(box.width >= 44 && box.height >= 44, 'manual close target is at least 44px');
            await close.focus(); await page.keyboard.press('Shift+Tab');
            assert.ok(await page.evaluate(() => !!document.activeElement?.closest('#datacatTagsDropdown')), 'reverse Tab wraps within the tag dialog');
            await page.keyboard.press('Tab');
            assert.equal(await page.evaluate(() => document.activeElement?.id), 'datacatTagsCloseBtn', 'last tag wraps to the close button');
            for (let n = 0; n < 15; n++) { await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => !!document.activeElement?.closest('#datacatTagsDropdown')), 'tag focus stays in dialog'); }
            await page.keyboard.press('Escape'); await page.locator('#datacatTagsDropdown').waitFor({ state: 'hidden' });
            evidence.observations.focusAfterEscape = await page.evaluate(() => ({ id: document.activeElement?.id, tag: document.activeElement?.tagName, tabIndex: document.activeElement?.tabIndex }));
            assert.equal(await page.evaluate(() => document.activeElement?.id), 'mobileNavFiltersBtn', 'Escape restores a visible mobile filter opener');
            await state.openTags(); await close.tap(); await page.locator('#datacatTagsDropdown').waitFor({ state: 'hidden' });
            assert.equal(await page.evaluate(() => document.activeElement?.id), 'mobileNavFiltersBtn', 'manual close restores the visible opener');
            await state.openTags(); await page.goBack({ waitUntil: 'commit', timeout: 3000 }).catch(() => {});
            await page.locator('#datacatTagsDropdown').waitFor({ state: 'hidden' });
            assert.ok(page.url().startsWith(base + root), 'Back dismisses the overlay without leaving the library');
            assert.equal(await page.evaluate(() => document.activeElement?.id), 'mobileNavFiltersBtn', 'Back restores the visible opener');
            evidence.observations.dismissal = { escape: true, manualTap: true, back: true, closeTarget: box };
        } else await page.keyboard.press('Escape');
        evidence.observations.longTasks = await page.evaluate(() => window.__qaLongTasks);
    }, state => { state.tags = largeTags; });

    await scenario('export-focus-serial-iframe', profile, async state => {
        const { page, evidence } = state; await state.activate();
        const ready = async id => {
            await page.waitForFunction(id => document.querySelector('#datacatExportPanel .dc-export-status')?.textContent.startsWith('Ready.')
                && document.querySelector('#datacatExportPanel iframe')?.getAttribute('src')?.includes(id), id);
            const expectedUrl = await page.locator('#datacatExportPanel iframe').getAttribute('src');
            await until(() => page.frames().some(frame => frame.url() === expectedUrl));
            (evidence.observations.committedFrames ||= []).push({ id, path: new URL(expectedUrl).pathname, expectedNonceCommitted: true });
        };
        const opener = profile.mobile ? '#mobileNavFiltersBtn' : '#datacatSearchInput';
        await page.locator(opener).focus();
        await page.evaluate(async ({ root, characterId }) => {
            window.__qaBridge = await import(root + '/modules/providers/datacat/datacat-export-bridge.js');
            window.__qaExports = [];
            window.__qaReceived = [];
            addEventListener('message', event => { if (event.data?.protocol === 'cl-datacat-export-v1') window.__qaReceived.push({ type: event.data.type, id: event.data.metadata?.characterId, frameMatches: event.source === document.querySelector('#datacatExportPanel iframe')?.contentWindow }); });
            window.__qaStartExport = id => window.__qaBridge.requestDatacatBrowserExport({ characterId: id, sourceKind: 'janitor', definitionSource: 'source', reusePanel: true })
                .then(value => window.__qaExports.push({ success: true, id: value.card.data.description }), error => window.__qaExports.push({ success: false, error: error.name }));
            void window.__qaStartExport(characterId);
        }, { root, characterId });
        await page.locator('#datacatExportPanel iframe').waitFor();
        await ready(characterId);
        await page.screenshot({ path: path.join(out, `${profile.name}-export-open.png`), fullPage: true });
        await page.evaluate(() => { window.__qaFirstPanel = document.getElementById('datacatExportPanel'); });
        for (let n = 0; n < 18; n++) { await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => !!document.activeElement?.closest('#datacatExportPanel')), 'focus stays inside export, including cross-origin iframe'); }
        const exportButton = page.frameLocator('#datacatExportPanel iframe').getByRole('button', { name: 'Export to Character Library', exact: true });
        if (profile.mobile) await exportButton.tap(); else await exportButton.click();
        await page.waitForFunction(() => window.__qaExports.length === 1);
        assert.deepEqual(await page.evaluate(() => window.__qaExports[0]), { success: true, id: characterId });
        await page.evaluate(id => { void window.__qaStartExport(id); }, row(1).character_id);
        await ready(row(1).character_id);
        assert.equal(await page.evaluate(() => window.__qaFirstPanel === document.getElementById('datacatExportPanel')), true, 'serial requests reuse the modal');
        if (profile.mobile) await exportButton.tap(); else await exportButton.click();
        await page.waitForFunction(() => window.__qaExports.length === 2);
        await page.evaluate(id => { void window.__qaStartExport(id); }, row(2).character_id);
        await ready(row(2).character_id);
        await page.frameLocator('#datacatExportPanel iframe').getByRole('button', { name: 'Cancel', exact: true }).focus();
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => window.__qaExports.length === 3);
        assert.deepEqual(await page.evaluate(() => window.__qaExports[2]), { success: false, error: 'AbortError' }, 'companion-style iframe Escape cancels the current request');
        await page.locator('#datacatExportPanel .dc-export-close').focus();
        await page.keyboard.press('Escape'); await page.locator('#datacatExportPanel').waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(selector => document.activeElement === document.querySelector(selector), opener), true, 'serial panel restores original opener');
        Object.assign(evidence.observations, { exports: await page.evaluate(() => window.__qaExports), focusContainment: true, focusRestored: true, reusedPanel: true });
    });

    if (doImports) await scenario('real-import-canvas-fallback', profile, async state => {
        const { page, context, evidence, csrf } = state; await state.activate();
        await page.evaluate(() => { Object.defineProperty(globalThis, 'OffscreenCanvas', { value: undefined, configurable: true }); });
        const imported = [];
        for (const validAvatar of [false, true]) {
            const id = crypto.randomUUID(); const name = `DataCat reliability ${Date.now()} ${profile.name} ${validAvatar ? 'avatar' : 'fallback'}`;
            const character = row(0, { character_id: id, name, has_source_definition: true, ...(validAvatar ? { avatar: base + '/img/ai4.png' } : {}) });
            const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name, description: `Persisted fallback body ${id}`, personality: 'Keep personality', scenario: 'Synthetic QA', first_mes: 'Hello', creator: 'QA', alternate_greetings: ['Alternative'], tags: ['qa'],
                character_book: { name: 'QA lore', entries: [{ id: 1, keys: ['qa'], content: 'Keep lore', enabled: true, insertion_order: 1 }] },
                extensions: { customQa: { preserved: true }, datacat: { id, sourceKind: 'janitor', definitionSource: 'source' } } } };
            state.handler = async (route, url) => {
                if (url.pathname.endsWith(`/api/characters/${id}/download`)) { await json(route, card); return true; }
                if (url.pathname.endsWith(`/api/characters/${id}`)) { await json(route, { character }); return true; }
                return false;
            };
            await page.evaluate(character => window.ProviderRegistry.getProvider('datacat').openPreview(character), character);
            await page.waitForFunction(id => document.querySelector('#datacatCharDescription')?.dataset.fullContent?.includes(id), id);
            await page.waitForFunction(() => { const button = document.getElementById('datacatImportBtn'); return button && !button.disabled && button.textContent.trim() === 'Import'; });
            const button = profile.mobile ? page.locator('#datacatCharModal .mobile-quick-import-btn') : page.locator('#datacatImportBtn');
            const hitbox = await button.boundingBox();
            if (profile.mobile) assert.ok(hitbox && hitbox.width >= 44 && hitbox.height >= 44, 'visible quick-import target is at least 44px');
            await page.screenshot({ path: path.join(out, `${profile.name}-import-${validAvatar ? 'avatar' : 'fallback'}-preview.png`), fullPage: true });
            const responsePromise = page.waitForResponse(response => response.url() === base + '/api/characters/import' && response.request().method() === 'POST');
            if (profile.mobile) await button.tap(); else await button.click();
            const response = await responsePromise; assert.equal(response.status(), 200); const result = await response.json(); assert.ok(result.file_name);
            const avatar = result.file_name + '.png';
            const savedResponse = await context.request.post(base + '/api/characters/get', { headers: { 'X-CSRF-Token': csrf }, data: { avatar_url: avatar } });
            assert.equal(savedResponse.status(), 200); const saved = await savedResponse.json();
            assert.equal(saved.data.description, card.data.description); assert.equal(saved.data.extensions.customQa.preserved, true);
            assert.equal(saved.data.character_book.entries[0].content, 'Keep lore'); assert.deepEqual(saved.data.alternate_greetings, ['Alternative']);
            imported.push({ id, avatar, validAvatar, hitbox, persisted: true }); await page.locator('#datacatCharModal').waitFor({ state: 'hidden' });
        }
        await page.reload(); await page.waitForFunction(() => window.ModuleLoader?.initialized && !document.documentElement.classList.contains('cl-initial-loading'));
        const avatars = await page.evaluate(() => window.getAllCharacters().map(character => character.avatar));
        for (const card of imported) assert.ok(avatars.includes(card.avatar), 'import survives reload');
        evidence.observations = { offscreenCanvasForcedUnavailable: true, imported, survivesReload: true };
    });
}
} finally { for (const browser of browsers.values()) await browser.close(); }
console.log(JSON.stringify({ passed: results.filter(result => result.status === 'passed').length, failed: results.filter(result => result.status !== 'passed').length, output: out }));
