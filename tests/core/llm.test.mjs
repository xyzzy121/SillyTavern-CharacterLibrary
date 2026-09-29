import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../app/library.js', import.meta.url), 'utf8');
const llmSource = source.slice(source.indexOf('function flattenContentBlocks('), source.indexOf('// Fire-and-forget; 3s timeout.'));
const messages = [{ role: 'user', content: 'Hello' }];
const opts = { activeSource: 'openai', activeModel: 'fixture-model' };
function harness(overrides = {}) {
    const requests = [];
    const context = vm.createContext({
        console: { warn() {}, error() {} }, debugLog() {}, URL,
        resolveProxyForProfile: async () => null,
        apiRequest: async (...args) => { requests.push(args); return Response.json({ choices: [{ message: { content: 'fixture answer' } }] }); },
        ...overrides,
    });
    vm.runInContext(llmSource, context);
    return { context, requests };
}

for (const [name, data, expected] of [
    ['OpenAI message', { choices: [{ message: { content: 'text' } }] }, 'text'],
    ['OpenAI text blocks', { choices: [{ message: { content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] } }] }, 'onetwo'],
    ['Anthropic blocks', { content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'answer' }] }, 'answer'],
    ['legacy text completion', { choices: [{ text: 'text' }] }, 'text'],
    ['null tool-call content', { choices: [{ message: { content: null }, text: 'wrong fallback' }] }, ''],
    ['delta content', { choices: [{ delta: { content: 'delta' } }] }, 'delta'],
    ['root response', { response: 'response' }, 'response'],
]) {
    test(`LLM parser handles ${name}`, () => assert.equal(harness().context.extractLlmContent(data), expected));
}

test('LLM parser rejects provider errors and truncated structured output', () => {
    const { context } = harness();
    assert.throws(() => context.extractLlmContent({ error: { message: 'denied' } }), /denied/);
    assert.throws(() => context.extractLlmContent({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }, { checkFinishReason: true }), /truncated/);
    assert.throws(() => context.extractLlmContent({ unexpected: true }), /Unexpected API response/);
});

test('ST LLM request includes selected profile, secret, named proxy, limits and cancellation signal', async () => {
    const { context, requests } = harness({ resolveProxyForProfile: async () => ({ url: 'https://proxy.example', password: 'fixture-password' }) });
    const controller = new AbortController();
    const result = await context.callLLM(messages, { ...opts,
        profile: { api: 'custom', model: 'profile-model', 'secret-id': 'fixture-secret', 'api-url': 'https://custom.example/v1' },
        signal: controller.signal, temperature: 0.2, maxTokens: 100,
    });
    const [endpoint, method, body, extra] = requests[0];
    assert.equal(result, 'fixture answer');
    assert.equal(endpoint, '/backends/chat-completions/generate');
    assert.equal(method, 'POST');
    assert.equal(body.chat_completion_source, 'custom');
    assert.equal(body.model, 'profile-model');
    assert.equal(body.secret_id, 'fixture-secret');
    assert.equal(body.custom_url, 'https://custom.example/v1');
    assert.equal(body.reverse_proxy, 'https://proxy.example');
    assert.equal(body.proxy_password, 'fixture-password');
    assert.equal(body.max_tokens, 100);
    assert.equal(extra.signal, controller.signal);
});

test('missing modern ST route falls back once to the legacy route', async () => {
    const paths = [];
    const { context } = harness({ apiRequest: async path => {
        paths.push(path);
        return paths.length === 1 ? new Response('missing', { status: 404 }) : Response.json({ choices: [{ text: 'legacy' }] });
    } });
    assert.equal(await context.callLLM(messages, opts), 'legacy');
    assert.deepEqual(paths, ['/backends/chat-completions/generate', '/openai/generate']);
});

test('rate limits do not trigger a second generation endpoint', async () => {
    let attempts = 0;
    const { context } = harness({ apiRequest: async () => { attempts++; return new Response('limit', { status: 429 }); } });
    await assert.rejects(() => context.callLLM(messages, opts), /429/);
    assert.equal(attempts, 1);
});

test('ST authentication envelopes suggest refreshing profile credentials', async () => {
    const { context } = harness({ apiRequest: async () => Response.json({ error: { message: 'Invalid API key' } }) });
    await assert.rejects(() => context.callLLM(messages, opts), /Authentication failed.*Connection Manager/);
});

test('ST generation abort does not retry a legacy endpoint', async () => {
    let attempts = 0;
    const { context } = harness({ apiRequest: async () => { attempts++; throw new DOMException('Aborted', 'AbortError'); } });
    await assert.rejects(() => context.callLLM(messages, opts), e => e.isCancelled === true);
    assert.equal(attempts, 1);
});

test('abort while reading an HTTP failure remains cancellation', async () => {
    const { context } = harness({ apiRequest: async () => ({ ok: false, status: 500,
        text: async () => { throw new DOMException('Aborted', 'AbortError'); },
    }) });
    await assert.rejects(() => context.callLLM(messages, opts), e => e.isCancelled === true);
});

test('custom API preserves endpoint query parameters and an existing completions path', async () => {
    const { context } = harness();
    assert.equal(context.resolveCustomEndpoint('https://api.example/v1/chat/completions?api-version=2026-01'), 'https://api.example/v1/chat/completions?api-version=2026-01');
    assert.equal(context.resolveCustomEndpoint('https://api.example/v1?key=fixture'), 'https://api.example/v1/chat/completions?key=fixture');
});

test('custom API sends bearer authentication without forwarding ST profile secrets', async () => {
    let sent;
    const { context } = harness({ fetch: async (url, options) => { sent = { url, options }; return Response.json({ content: 'custom result' }); } });
    assert.equal(await context.callCustomLLM(messages, { url: 'https://custom.example/v1/', apiKey: 'fixture-key', model: 'fixture-model' }), 'custom result');
    assert.equal(sent.url, 'https://custom.example/v1/chat/completions');
    assert.equal(sent.options.headers.Authorization, 'Bearer fixture-key');
    assert.equal(JSON.parse(sent.options.body).secret_id, undefined);
});

test('optional surrogate cleanup retains valid Unicode pairs', () => {
    const { context } = harness();
    assert.equal(context.stripLlmSurrogates('A\ud800B\udfffC 😀'), 'ABC 😀');
});
