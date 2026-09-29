import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../modules/providers/', import.meta.url);
const providerNames = {
    chub: 'ChubProvider', chartavern: 'ChartavernProvider', pygmalion: 'PygmalionProvider',
    janny: 'JannyProvider', wyvern: 'WyvernProvider', botbooru: 'BotbooruProvider',
    saucepan: 'SaucepanProvider', janitorai: 'JanitoraiProvider',
};

async function loadProvider(id, mocks = {}) {
    const source = await readFile(new URL(`${id}/${id}-provider.js`, root), 'utf8');
    const name = providerNames[id];
    const body = source.slice(source.indexOf(`class ${name} extends`), source.indexOf(`const ${id}Provider =`));
    const context = vm.createContext({
        console: { error() {}, warn() {} }, Set, Map,
        ProviderBase: class { getListingName(node) { return node?.name || ''; } },
        api: { getSetting: () => false, debugLog() {} }, _refreshedRemotes: new Map(),
        slugify: () => 'character', saucepanCompanionUrl: () => 'https://saucepan.ai/companion/fixture',
        getCardPngUrl: () => 'https://cards.character-tavern.com/author/fixture.png',
        ...mocks,
    });
    vm.runInContext(`${body}\nglobalThis.provider = new ${name}();`, context);
    return context.provider;
}

const dependencies = {
    chub: ['fetchChubMetadata'], chartavern: ['fetchWithProxy', 'fetchCharacterDetail'],
    pygmalion: ['fetchCharacterDetail'], janny: ['fetchCharacterDetails'], wyvern: ['fetchWyvernMetadata'],
    botbooru: ['fetchBotbooruCard'], saucepan: ['fetchSaucepanCompanion'], janitorai: ['fetchJanitoraiCharacter'],
};

for (const id of Object.keys(providerNames)) {
    test(`${id}: auth, rate limits, service failures and cancellation cannot mark a card removed`, async () => {
        for (const status of [401, 403, 429, 503, 0]) {
            const failure = Object.assign(new Error(`fixture failure ${status}`), { status });
            if (!status) failure.name = 'AbortError';
            const mocks = Object.fromEntries(dependencies[id].map(key => [key, async () => { throw failure; }]));
            const provider = await loadProvider(id, mocks);
            await assert.rejects(provider.fetchRemoteCard({ id: 'fixture', fullPath: 'author/fixture' }), error => error === failure);
        }
    });
}

test('Saucepan: a locked definition reports its reason instead of Removed / Private', async () => {
    const provider = await loadProvider('saucepan', {
        fetchSaucepanCompanion: async () => ({ id: 'fixture' }), hitFromCompanion: x => x,
        submitSaucepanExtraction: async () => ({ success: false, error: 'Creator locked this definition', locked: true }),
    });
    await assert.rejects(provider.fetchRemoteCard({ id: 'fixture' }), /Creator locked this definition/);
});

test('CharacterTavern detail fallback does not propose deleting greetings and lorebooks it cannot read', async () => {
    const provider = await loadProvider('chartavern', {
        fetchWithProxy: async () => { throw new Error('CDN unavailable'); },
        fetchCharacterDetail: async () => ({ card: { name: 'Fixture' } }),
        buildV2FromDetail: () => ({ spec: 'chara_card_v2', data: { name: 'Fixture', alternate_greetings: [] } }),
    });
    const card = await provider.fetchRemoteCard({ fullPath: 'author/fixture' });
    assert.equal(card._unavailableFields?.has('alternate_greetings'), true);
    assert.equal(card._lorebookUnavailable, true);
});

for (const id of ['pygmalion', 'chartavern', 'janny']) {
    test(`${id}: a successful malformed detail cannot become an empty or removed card`, async () => {
        const mocks = Object.fromEntries(dependencies[id].map(key => [key, async () => ({})]));
        mocks.fetchWithProxy = async () => { throw new Error('CDN unavailable'); };
        const provider = await loadProvider(id, mocks);
        await assert.rejects(provider.fetchRemoteCard({ id: 'fixture', fullPath: 'author/fixture' }), /invalid|malformed|missing|unavailable/i);
    });
}

test('Pygmalion metadata without an accessible personality cannot overwrite a complete local card', async () => {
    const provider = await loadProvider('pygmalion', { fetchCharacterDetail: async () => ({ character: { id: 'fixture', displayName: 'Name' } }) });
    await assert.rejects(provider.fetchRemoteCard({ id: 'fixture' }), /invalid/i);
});

test('Botbooru missing enrichment preserves local writer credit and tagline', async () => {
    const provider = await loadProvider('botbooru', {
        fetchBotbooruCard: async () => ({ spec: 'chara_card_v2', data: { name: 'Name', creator: 'old upload credit' } }),
        fetchBotbooruPost: async () => null,
        stripForeignProviderNamespaces() {},
    });
    const card = await provider.fetchRemoteCard({ id: 42 });
    assert.equal(card._unavailableFields.has('creator'), true);
    assert.equal(card._unavailableFields.has('extensions.botbooru.tagline'), true);
});
