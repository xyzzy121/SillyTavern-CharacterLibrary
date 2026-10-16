import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../app/library.js', import.meta.url), 'utf8');

test('replacement surgical writes clean only their owned null namespace', async () => {
    const requests = [];
    const char = { avatar: 'existing.png', data: { name: 'Local', extensions: { datacat: null, unrelated: null, gallery_id: 'local' } } };
    const context = vm.createContext({ console, allCharacters: [char], ST_UNSET_SENTINEL: '__@@UNSET@@__',
        _extensionsCache: new Map(), TOKEN_ESTIMATE_FIELDS: [],
        extensionsReady: () => true, hydrateCharacter: async () => {},
        getExtensionDeleteValue: async () => '__@@UNSET@@__',
        apiRequest: async (path, method, body) => { requests.push({ path, method, body }); return new Response('OK'); },
        window: {},
    });
    const start = source.indexOf('async function writeCardFields(');
    const end = source.indexOf('/**\n * Convenience wrapper', start);
    vm.runInContext(source.slice(start, end), context);
    const result = await context.writeCardFields(char, { description: 'New', 'extensions.datacat.id': 'new-id' },
        { surgical: true, extensionCleanupNamespaces: ['datacat'] });
    assert.equal(result.ok, true);
    assert.equal(requests.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(requests[0].body.data.extensions)), { datacat: '__@@UNSET@@__' });
    assert.deepEqual(JSON.parse(JSON.stringify(requests[1].body.data)), { description: 'New', extensions: { datacat: { id: 'new-id' } } });
    assert.equal(char.data.extensions.unrelated, null);
    assert.equal(char.data.extensions.gallery_id, 'local');
});

function dialogHarness() {
    const nodes = new Map();
    const make = () => ({ innerHTML: '', textContent: '', children: [], appendChild(node) { this.children.push(node); }, querySelector() { return this; },
        classList: { add() {}, remove() {} } });
    for (const id of ['preImportDuplicateModal', 'preImportDuplicateInfo', 'preImportDuplicateMatches']) nodes.set(id, make());
    const context = vm.createContext({ console, Promise,
        document: { getElementById: id => nodes.get(id), createElement: make,
            querySelector: () => ({ value: 'second.png' }) },
        hydrateCharacter: async () => {}, getCharField: (char, field) => char.data[field],
        getCharacterAvatarStThumbUrl: avatar => avatar, estimateTokens: () => 20,
        escapeHtml: value => String(value).replaceAll('"', '&quot;'),
        window: { ProviderRegistry: { getCharacterProvider: () => null } },
    });
    const start = source.indexOf('let preImportPendingChar =');
    const end = source.indexOf('// Pre-Import Modal Event Listeners', start);
    vm.runInContext(source.slice(start, end), context);
    return { context, nodes };
}
const matches = ['first', 'second'].map(name => ({ char: { avatar: `${name}.png`, data: { name, creator: 'Creator' } }, score: 90 }));

test('DataCat duplicate warning returns the explicitly selected avatar and describes preservation', async () => {
    const h = dialogHarness();
    const pending = h.context.showPreImportDuplicateWarning({ name: 'Remote' }, matches, { selectReplacementTarget: true });
    await new Promise(setImmediate);
    assert.match(h.nodes.get('preImportDuplicateMatches').innerHTML, /name="preImportReplacementTarget"/);
    assert.match(h.nodes.get('preImportDuplicateMatches').innerHTML, /Replace second \(second.png\)/);
    assert.match(h.nodes.get('preImportDuplicateInfo').children[0].textContent, /local name, artwork, chats, and settings/);
    h.context.resolvePreImportChoice('replace');
    assert.equal((await pending).targetAvatar, 'second.png');
});

test('ordinary provider duplicate dialogs do not gain DataCat replacement controls', async () => {
    const h = dialogHarness();
    const pending = h.context.showPreImportDuplicateWarning({ name: 'Remote' }, matches);
    await new Promise(setImmediate);
    assert.doesNotMatch(h.nodes.get('preImportDuplicateMatches').innerHTML, /preImportReplacementTarget/);
    assert.equal(h.nodes.get('preImportDuplicateInfo').children.length, 0);
    h.context.resolvePreImportChoice('skip');
    assert.equal((await pending).choice, 'skip');
});

test('overlay Escape/Back close resolves the pending duplicate choice as cancellation', async () => {
    const h = dialogHarness();
    let registration;
    h.context.window.registerOverlay = value => { registration = value; };
    const registrationLine = source.split('\n').find(line => line.includes("id: 'preImportDuplicateModal'"));
    vm.runInContext(registrationLine, h.context);
    const pending = h.context.showPreImportDuplicateWarning({ name: 'Remote' }, matches);
    await new Promise(setImmediate);
    registration.close();
    assert.equal((await pending).choice, 'skip');
});
