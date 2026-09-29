import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../modules/providers/', import.meta.url);
const id = '11111111-2222-4333-8444-555555555555';
const names = { chub: 'ChubProvider', chartavern: 'ChartavernProvider', pygmalion: 'PygmalionProvider',
    janny: 'JannyProvider', wyvern: 'WyvernProvider', botbooru: 'BotbooruProvider',
    saucepan: 'SaucepanProvider', janitorai: 'JanitoraiProvider', datacat: 'DatacatProvider' };
const strip = source => source.replace(/^import[\s\S]*?;\r?\n/gm, '')
    .replace(/^export (?:\{[\s\S]*?\}|\*)(?: from [^;]+)?;\r?\n/gm, '').replace(/^export /gm, '');
async function load(key, extra = {}) {
    const context = vm.createContext({ URL, URLSearchParams, Set, Map, Date,
        console: { error() {}, warn() {}, info() {}, log() {} },
        CoreAPI: { isUrlSafeForDownload: () => ({ ok: true }) },
        CL_HELPER_PLUGIN_BASE: '/plugins/cl-helper', window: {},
        ProviderBase: class { getListingName(row) { return row?.name || ''; } },
        slugify: s => s.toLowerCase().replace(/\s+/g, '-'), stripHtml: s => s, decodeHtmlEntities: s => s,
        ...extra,
    });
    const apiFile = key === 'datacat' ? 'datacat-contract.js' : `${key}-api.js`;
    vm.runInContext(strip(await readFile(new URL(`${key}/${apiFile}`, root), 'utf8')), context);
    const source = strip(await readFile(new URL(`${key}/${key}-provider.js`, root), 'utf8'));
    vm.runInContext(`${source.slice(0, source.indexOf(`const ${key}Provider =`))}\nglobalThis.provider = new ${names[key]}();`, context);
    return context;
}

for (const key of Object.keys(names)) {
    test(`${key}: link, public URL parsing and unlink round-trip without changing other namespaces`, async () => {
        const { provider } = await load(key);
        const char = { data: { extensions: { custom: { keep: true } } } };
        const record = { id: key === 'botbooru' ? 42 : id, fullPath: ['chub', 'chartavern'].includes(key) ? 'author/fixture' : id,
            slug: 'fixture', sourceKind: 'direct_upload', pageName: 'Listing', linkedAt: '2026-09-01T00:00:00.000Z' };
        provider.setLinkInfo(char, record);
        const link = provider.getLinkInfo(char);
        assert.equal(String(link.id), String(record.id));
        const url = provider.getCharacterUrl(link);
        assert.ok(url, 'public URL');
        assert.equal(provider.canHandleUrl(url), true);
        assert.equal(provider.parseUrl(url), link.fullPath);
        assert.equal(provider.canHandleUrl(url.replace(new URL(url).host, `${new URL(url).host}.invalid`)), false);
        provider.setLinkInfo(char, null);
        assert.equal(provider.getLinkInfo(char), null);
        assert.deepEqual(char.data.extensions.custom, { keep: true });
    });
}

test('Chub card conversion preserves authored fields, embedded lorebook and unrelated extensions', async () => {
    const ctx = await load('chub');
    const lorebook = { entries: [{ keys: ['fixture'], content: 'lore' }] };
    const card = await ctx.buildCharacterCardFromChub({ name: 'Listing', fullPath: 'author/fixture', topics: ['tag'],
        definition: { name: 'Name', personality: 'body', tavern_personality: 'traits', first_message: 'hello',
            alternate_greetings: ['second'], embedded_lorebook: lorebook, extensions: { custom: 42 } } });
    assert.equal(card.data.name, 'Name');
    assert.equal(card.data.description, 'body');
    assert.equal(card.data.personality, 'traits');
    assert.equal(card.data.first_mes, 'hello');
    assert.equal(card.data.alternate_greetings[0], 'second');
    assert.equal(card.data.character_book, lorebook);
    assert.equal(card.data.extensions.custom, 42);
});

test('Wyvern card conversion preserves advanced greetings and lorebook numeric zeros', async () => {
    const ctx = await load('wyvern');
    const card = ctx.buildCharacterCardFromWyvern({ id, name: 'Listing', chat_name: 'Name ', description: 'body',
        enable_advanced_greetings: true, greetings: [{ id: 'default', content: 'hello' }, { id: 'second', content: 'alternate' }],
        lorebooks: [{ scan_depth: 0, token_budget: 0, entries: [{ entry_id: 7, content: 'one' }, { entry_id: 0, insertion_order: 0, priority: 0, content: 'two' }] }] });
    assert.equal(card.data.name, 'Name');
    assert.equal(card.data.alternate_greetings.length, 1);
    assert.equal(card.data.alternate_greetings[0], 'alternate');
    assert.equal(card.data.character_book.scan_depth, 0);
    assert.equal(card.data.character_book.token_budget, 0);
    assert.equal(card.data.character_book.entries[1].id, 0);
    assert.equal(card.data.character_book.entries[1].insertion_order, 0);
    assert.equal(card.data.character_book.entries[1].priority, 0);
});

test('Pygmalion and Janny card conversions map definition and greeting fields without treating listing blurbs as definitions', async () => {
    const pyg = await load('pygmalion');
    const pygCard = pyg.buildV2FromDetail({ id, displayName: 'Listing', description: 'blurb',
        personality: { name: 'Name', persona: 'body', greeting: 'hello', alternateGreetings: ['second'], characterNotes: 'notes' } });
    assert.equal(pygCard.data.description, 'body');
    assert.equal(pygCard.data.creator_notes, 'notes');
    assert.equal(pygCard.data.extensions.pygmalion.tagline, 'blurb');
    assert.equal(pygCard.data.alternate_greetings[0], 'second');
    const janny = await load('janny');
    const jannyCard = janny.buildV2FromDetails({ character: { id, name: 'Name', personality: 'body', description: 'blurb', firstMessage: 'hello' } });
    assert.equal(jannyCard.data.description, 'body');
    assert.equal(jannyCard.data.creator_notes, 'blurb');
    assert.equal(jannyCard.data.first_mes, 'hello');
});

test('Saucepan conversion retains all extracted sections and greetings', async () => {
    const ctx = await load('saucepan');
    const card = ctx.buildV2FromSaucepan({ id, name: 'Name', display_name: 'Listing', tags: ['tag'] }, {
        assembled: { 'Companion Core': 'body', 'Example Dialogue': 'example', 'Advanced Prompt': 'system', 'Response Formatting Instructions': 'post' },
        greetings: [{ text: 'hello' }, { text: 'second' }], profileDescription: 'notes',
    });
    assert.equal(card.data.description, 'body');
    assert.equal(card.data.mes_example, 'example');
    assert.equal(card.data.system_prompt, 'system');
    assert.equal(card.data.post_history_instructions, 'post');
    assert.equal(card.data.first_mes, 'hello');
    assert.equal(card.data.alternate_greetings[0], 'second');
    assert.equal(card.data.creator_notes, 'notes');
});

test('Botbooru imports strip foreign provider links while retaining unrelated extensions', async () => {
    const ctx = await load('botbooru');
    const card = { data: { name: 'Name', extensions: { chub: { id: 9 }, datacat: { id }, custom: 42 } } };
    ctx.stripForeignProviderNamespaces(card);
    assert.deepEqual(card.data.extensions, { custom: 42 });
});

test('JanitorAI card conversion retains definition, greeting, scenario and example fields', async () => {
    const ctx = await load('janitorai');
    const card = ctx.buildV2FromJanitorai({ id, name: 'Name', personality: 'body', first_message: 'hello', scenario: 'scene', example_dialogs: 'example' });
    assert.equal(card.data.description, 'body');
    assert.equal(card.data.first_mes, 'hello');
    assert.equal(card.data.scenario, 'scene');
    assert.equal(card.data.mes_example, 'example');
});

test('Chub unavailable linked lorebook remains unknown rather than becoming a deletion', async () => {
    const ctx = await load('chub', { fetch: async () => { throw new Error('fixture network outage'); } });
    const card = await ctx.buildCharacterCardFromChub({ id: 42, name: 'Name', definition: { personality: 'body' }, related_lorebooks: [123] });
    assert.equal(card._lorebookUnavailable, true);
});

test('CharacterTavern conversion preserves authored fields and supplied alternate greetings', async () => {
    const ctx = await load('chartavern');
    const card = ctx.buildV2FromDetail({ id: 42, name: 'Listing', inChatName: 'Name', definition_character_description: 'body',
        definition_first_message: 'hello', definition_system_prompt: 'system', definition_post_history_prompt: 'post' }, 'author', ['second']);
    assert.equal(card.data.name, 'Name');
    assert.equal(card.data.description, 'body');
    assert.equal(card.data.first_mes, 'hello');
    assert.equal(card.data.system_prompt, 'system');
    assert.equal(card.data.post_history_instructions, 'post');
    assert.equal(card.data.alternate_greetings[0], 'second');
});
