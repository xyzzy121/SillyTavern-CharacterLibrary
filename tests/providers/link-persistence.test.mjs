import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../app/library.js', import.meta.url), 'utf8');
const extract = (name, next) => source.slice(source.indexOf(`async function ${name}(`), source.indexOf(`${next}(`, source.indexOf(`async function ${name}(`)));
const save = extract('saveProviderLink', 'function isUpdateLocked');
const urlHandler = extract('linkToProviderUrl', 'async function unlinkFromProvider');
const searchHandler = extract('linkToSearchResult', 'async function linkToProviderUrl');
const unlink = extract('unlinkFromProvider', 'async function viewOnLinkedProvider');
const fixture = () => ({ avatar: 'fixture.png', data: { extensions: { chub: { full_path: 'old/card', extra: 42 }, cl: { pageName: 'Old listing' }, custom: 123 } } });
const provider = { id: 'chub', name: 'Chub', setLinkInfo(char, info) {
    if (info) char.data.extensions.chub = { ...char.data.extensions.chub, full_path: info.fullPath };
    else delete char.data.extensions.chub;
} };

function contextFor(char, extra = {}) {
    return vm.createContext({ structuredClone, console: { error() {} }, activeChar: char, allCharacters: [char],
        ST_UNSET_SENTINEL: '__delete__', window: {}, hydrateCharacter: async () => {}, extensionsReady: () => true,
        getListingNameFromExtensions: () => '', getDisplayTagline: () => '', getSTContext: () => null,
        notifySTCharacterEdited: async () => {}, showToast() {}, updateProviderLinkIndicator() {}, hideModal() {},
        document: { getElementById: () => null }, ...extra });
}

test('failed provider link writes leave the existing link, display fallback and other extensions untouched', async () => {
    const char = fixture();
    const before = structuredClone(char);
    const context = contextFor(char, { writeCardFields: async () => ({ ok: false }) });
    vm.runInContext(save, context);
    await assert.rejects(context.saveProviderLink(char, provider, { fullPath: 'new/card' }), /Failed to save/);
    assert.deepEqual(char, before);
});

test('link writes hydrate before staging and send the exact provider namespace explicitly', async () => {
    const char = fixture();
    char._slim = true;
    let request;
    const context = contextFor(char, { hydrateCharacter: async target => {
        target.data.extensions.chub = { full_path: 'hydrated/card', recovered: true };
        target._slim = false;
    }, writeCardFields: async (target, updates, options) => {
        request = { target, updates, options };
        assert.equal(target.data.extensions.chub.full_path, 'hydrated/card', 'live object has not been modified before persistence');
        target.data.extensions.chub = updates['extensions.chub'];
        delete target.data.extensions.cl;
        return { ok: true };
    } });
    vm.runInContext(save, context);
    await context.saveProviderLink(char, provider, { fullPath: 'new/card' });
    assert.equal(request.updates['extensions.chub'].recovered, true);
    assert.equal(request.updates['extensions.chub'].full_path, 'new/card');
    assert.equal(request.updates['extensions.cl'], '__delete__');
    assert.equal(request.options.surgical, true);
    assert.equal(char.data.extensions.custom, 123);
});

for (const kind of ['URL', 'search']) {
    test(`${kind} linking applies to the originally selected card and leaves a newer preview open`, async () => {
        const first = fixture(), second = { avatar: 'second.png', data: {} };
        let finish, saved, repaints = 0;
        const remote = { ...provider, parseUrl: () => 'author/card', fetchMetadata: () => new Promise(resolve => { finish = resolve; }), getListingName: data => data.name };
        const context = contextFor(first, { window: { ProviderRegistry: { getProviderForUrl: () => remote, getProvider: () => remote } },
            saveProviderLink: async target => { saved = target; },
            updateProviderLinkIndicator: () => repaints++, hideModal: () => repaints++,
        });
        vm.runInContext(kind === 'URL' ? urlHandler : searchHandler, context);
        const button = { closest: () => ({ dataset: { fullpath: 'author/card', providerId: 'chub', id: '' } }) };
        const pending = kind === 'URL' ? context.linkToProviderUrl('https://chub.ai/characters/author/card') : context.linkToSearchResult(button);
        context.activeChar = second;
        finish({ id: 42, name: 'Listing' });
        await pending;
        assert.equal(saved, first);
        assert.equal(repaints, 0);
    });
}

test('failed unlink never removes the existing live provider namespace', async () => {
    const char = fixture();
    const before = structuredClone(char);
    const context = contextFor(char, { linkModalActiveProvider: { provider }, writeCardFields: async () => ({ ok: false }) });
    vm.runInContext(unlink, context);
    await context.unlinkFromProvider();
    assert.deepEqual(char, before);
});

test('unlink captures its target before hydration and does not repaint a newer preview', async () => {
    const char = fixture();
    let finish, target, repaints = 0;
    const context = contextFor(char, { linkModalActiveProvider: { provider },
        hydrateCharacter: () => new Promise(resolve => { finish = resolve; }),
        writeCardFields: async (savedChar, updates) => { target = savedChar; assert.equal(updates['extensions.chub'], '__delete__'); return { ok: true }; },
        updateProviderLinkIndicator: () => repaints++, openProviderLinkModal: () => repaints++,
    });
    vm.runInContext(unlink, context);
    const pending = context.unlinkFromProvider();
    context.activeChar = { avatar: 'new-preview.png' };
    finish();
    await pending;
    assert.equal(target, char);
    assert.equal(repaints, 0);
});
