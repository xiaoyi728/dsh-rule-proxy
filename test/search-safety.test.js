import test from 'node:test';
import assert from 'node:assert/strict';
import { SearxSearchProvider } from '../src/search.js';

function fixture(content, { statusCode = 200, truncated = false } = {}) {
  const provider = new SearxSearchProvider(null, 'https://search.example/search');
  let calls = 0;
  provider.fetchProvider.fetch = async () => {
    calls++;
    return { statusCode, truncated, body: { content } };
  };
  return { provider, calls: () => calls };
}

test('search rejects malformed responses without reflecting response contents', async () => {
  const secret = 'fixture-response-secret';
  for (const content of [secret, `{ "results": ${secret} }`, 'null', '[]', '{"results":null}']) {
    const { provider } = fixture(content);
    await assert.rejects(provider.search({ query: 'query' }), error => {
      assert.ok(!error.message.includes(secret));
      return /^Invalid SearXNG (JSON )?response$/.test(error.message);
    });
  }
  for (const options of [{ statusCode: 401 }, { truncated: true }]) {
    await assert.rejects(fixture(secret, options).provider.search({ query: 'query' }), { message: 'SearXNG returned an incomplete or failed response' });
  }
});

test('search filters non-HTTP, credential-bearing and malformed source URLs before capping', async () => {
  const results = [
    { url: 'javascript:alert(1)', title: 'javascript' },
    { url: 'file:///etc/passwd', title: 'file' },
    { url: 'https://user:pass@example.com/', title: 'credentials' },
    { url: 'relative/path', title: 'relative' },
    null,
    { url: 'https://example.com/a', title: 'A', content: 'snippet' },
    { url: 'http://example.com/b', title: 'B' },
  ];
  const { provider } = fixture(JSON.stringify({ results }));
  assert.deepEqual(await provider.search({ query: 'q', maxResults: 1 }), {
    query: 'q', sources: [{ url: 'https://example.com/a', title: 'A', snippet: 'snippet' }], truncated: true,
  });
});

test('search validates query and cap before making any request', async () => {
  const { provider, calls } = fixture('{"results":[]}');
  for (const request of [{ query: '' }, { query: '   ' }, { query: null }, ...[0, -1, 1.5, 101, NaN, '8'].map(maxResults => ({ query: 'q', maxResults }))]) {
    await assert.rejects(provider.search(request));
  }
  assert.equal(calls(), 0);
  assert.deepEqual(await provider.search({ query: 'q', maxResults: 100 }), { query: 'q', sources: [], truncated: false });
});
