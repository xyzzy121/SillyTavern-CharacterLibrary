import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../app/library.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('async function linkToProviderUrl('), source.indexOf('async function unlinkFromProvider('));
const id = '11111111-2222-3333-4444-555555555555';

for (const sourceKind of ['direct', 'sauce']) {
    test(`URL link UI retains the original ${sourceKind} source through metadata lookup and save`, async () => {
        const requests = [], writes = [], toasts = [];
        const button = { disabled: false, innerHTML: '' };
        const provider = {
            name: 'Datacat', parseUrl: () => id,
            fetchMetadata: async (...args) => { requests.push(args); return null; },
        };
        const context = vm.createContext({
            activeChar: { avatar: 'local.png' }, document: { getElementById: () => button },
            window: { ProviderRegistry: { getProviderForUrl: () => provider } },
            saveProviderLink: async (...args) => writes.push(args),
            showToast: (...args) => toasts.push(args), updateProviderLinkIndicator() {}, hideModal() {}, console,
        });
        vm.runInContext(handler, context);
        const url = `https://datacat.run/characters/recent/${sourceKind}/${id}`;
        await context.linkToProviderUrl(url);
        assert.equal(requests[0][0], id);
        assert.equal(requests[0][1]?.sourceUrl, url);
        assert.equal(writes[0][2].fullPath, id);
        assert.equal(writes[0][2].sourceUrl, url);
        assert.equal(toasts[0][1], 'success');
        assert.equal(button.disabled, false);
    });
}

test('URL linking keeps numeric identifiers and listing names for other providers', async () => {
    let saved;
    const provider = {
        name: 'Other provider', parseUrl: () => 'creator/card',
        fetchMetadata: async () => ({ id: 1234, name: 'Listing' }), getListingName: data => data.name,
    };
    const context = vm.createContext({
        activeChar: {}, document: { getElementById: () => null },
        window: { ProviderRegistry: { getProviderForUrl: () => provider } },
        saveProviderLink: async (_char, _provider, link) => { saved = link; },
        showToast() {}, updateProviderLinkIndicator() {}, hideModal() {}, console,
    });
    vm.runInContext(handler, context);
    await context.linkToProviderUrl('https://example.test/creator/card');
    assert.equal(saved.id, 1234);
    assert.equal(saved.fullPath, 'creator/card');
    assert.equal(saved.pageName, 'Listing');
});

test('a source-less URL relink saves the newly resolved source instead of inheriting the old one', async () => {
    let saved;
    const provider = {
        name: 'Datacat', parseUrl: () => id,
        fetchMetadata: async () => ({ id, name: 'Janitor listing', sourceKind: 'janitor' }),
        getListingName: metadata => metadata.name,
    };
    const context = vm.createContext({
        activeChar: { data: { extensions: { datacat: { id: 'old-id', sourceKind: 'saucepan' } } } },
        document: { getElementById: () => null },
        window: { ProviderRegistry: { getProviderForUrl: () => provider } },
        saveProviderLink: async (_char, _provider, link) => { saved = link; },
        showToast() {}, updateProviderLinkIndicator() {}, hideModal() {}, console,
    });
    vm.runInContext(handler, context);
    await context.linkToProviderUrl(`https://datacat.run/characters/${id}`);
    assert.equal(saved.sourceKind, 'janitor');
    assert.equal(saved.id, id);
});
