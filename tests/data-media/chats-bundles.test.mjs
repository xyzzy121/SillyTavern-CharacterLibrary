import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const chatSource = await readFile(new URL('../../modules/chats.js', import.meta.url), 'utf8');
const bundleSource = await readFile(new URL('../../modules/batch-transfer.js', import.meta.url), 'utf8');

for (const change of ['same-length message edit', 'earlier message edit', 'header edit', 'chat becomes active']) {
    test(`chat lore binding refuses a concurrent ${change}`, async () => {
        const original = [{ chat_metadata: { integrity: 'keep' } }, { mes: 'before' }, { mes: 'hello', send_date: 'today' }];
        const changed = structuredClone(original);
        if (change === 'same-length message edit') changed[2].mes = 'other';
        if (change === 'earlier message edit') changed[1].mes = 'new';
        if (change === 'header edit') changed[0].chat_metadata.other = 'preserve';
        let reads = 0, writes = 0, active = false;
        const context = vm.createContext({
            console,
            CoreAPI: {
                getHostWindow: () => ({ SillyTavern: { getContext: () => active
                    ? { characters: [{ avatar: 'a.png' }], characterId: 0, chatId: 'chat' } : {} } }),
                showToast() {},
                apiRequest: async () => {
                    reads++;
                    if (reads === 2 && change === 'chat becomes active') active = true;
                    return Response.json(reads === 1 ? original : changed);
                },
            },
            ENDPOINTS: { CHATS_GET: '/chats/get' },
            CHAT_LORE_KEY: 'world_info',
            saveChatToServer: async () => { writes++; return true; },
        });
        vm.runInContext(chatSource.slice(chatSource.indexOf('function chatSignature('), chatSource.indexOf('async function listCharacterChatsWithMeta(')), context);
        assert.equal(await context.setChatBoundWorld({ avatar: 'a.png', name: 'A' }, 'chat.jsonl', 'Book'), false);
        assert.equal(writes, 0);
    });
}

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function bundleContext() {
    const context = vm.createContext({ CoreAPI: { crc32 }, Blob, Response, TextEncoder, TextDecoder, DecompressionStream });
    vm.runInContext(bundleSource.slice(bundleSource.indexOf('const enc ='), bundleSource.indexOf('// MODAL SHELL'))
        + '\nglobalThis.makeZip = files => { const z = new ZipWriter(); for (const [n,b] of files) z.addFile(n,b); return z.finalize(); };', context);
    return context;
}

test('bundle ZIP round-trips UTF-8 filenames and binary contents', async () => {
    const context = bundleContext();
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const zip = await context.parseZip(context.makeZip([['gallery/日本語/image.png', bytes]]));
    assert.deepEqual(Array.from(await context.readZipEntry(zip, 'gallery/日本語/image.png')), Array.from(bytes));
});

for (const damage of ['content', 'size']) {
    test(`bundle ZIP rejects corrupt ${damage} before importing any entry`, async () => {
        const context = bundleContext();
        const zipBlob = context.makeZip([['card.png', new Uint8Array([0, 1, 2, 255])]]);
        const bytes = new Uint8Array(await zipBlob.arrayBuffer());
        if (damage === 'content') bytes[30 + 'card.png'.length] ^= 1;
        else {
            // Central directory's uncompressed size can disagree with the actual payload.
            new DataView(bytes.buffer).setUint32(30 + 'card.png'.length + 4 + 24, 100, true);
        }
        const zip = await context.parseZip(new Blob([bytes]));
        await assert.rejects(() => context.readZipEntry(zip, 'card.png'), /corrupt|checksum|size/i);
    });
}
