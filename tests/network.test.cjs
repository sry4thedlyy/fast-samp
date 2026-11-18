const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NetworkConnection, connectionSettings, downloaderProxy } = require('../app/network.cjs');

test('Chromium proxy routes produce explicit yt-dlp proxy arguments', () => {
  assert.equal(downloaderProxy('DIRECT'), '');
  assert.equal(downloaderProxy('PROXY localhost:10809; DIRECT'), 'http://localhost:10809');
  assert.equal(downloaderProxy('HTTPS proxy.example:443'), 'https://proxy.example:443');
  assert.equal(downloaderProxy('SOCKS5 [::1]:1080'), 'socks5://[::1]:1080');
  assert.throws(() => downloaderProxy('unexpected route'));
});

test('connection configuration validates proxies before changing the session', () => {
  assert.deepEqual(connectionSettings(), { mode: 'system', proxy: '' });
  assert.deepEqual(connectionSettings({ mode: 'direct', proxy: 'unused' }), { mode: 'direct', proxy: '' });
  assert.deepEqual(connectionSettings({ mode: 'custom', proxy: 'socks5://127.0.0.1:1080/' }),
    { mode: 'custom', proxy: 'socks5://127.0.0.1:1080' });
  for (const proxy of ['file:///tmp', 'http://proxy/path', 'http://user:password@proxy:8080', 'invalid']) {
    assert.throws(() => connectionSettings({ mode: 'custom', proxy }));
  }
});

test('simultaneous checks share a request and fail when the YouTube API cannot load', async () => {
  let requests = 0;
  let refreshed = 0;
  const updates = [];
  const browser = {
    setProxy: async () => {},
    closeAllConnections: async () => {},
    forceReloadProxyConfig: async () => { refreshed++; },
    resolveProxy: async () => 'PROXY 127.0.0.1:10809',
    fetch: async () => { requests++; throw new Error('ERR_PROXY_CONNECTION_FAILED'); },
  };
  const network = new NetworkConnection(browser, (result) => updates.push(result.status));
  const [first, second] = await Promise.all([network.check(), network.check()]);
  assert.equal(requests, 1);
  assert.equal(first, second);
  assert.equal(first.status, 'error');
  assert.match(first.message, /прокси/);
  assert.equal(first.detail, 'ERR_PROXY_CONNECTION_FAILED');
  assert.equal(await network.proxyFor('https://www.youtube.com/watch?v=aqz-KE-bpKQ'), 'http://127.0.0.1:10809');
  assert.deepEqual(updates, ['checking', 'error']);
  await network.check();
  assert.equal(requests, 1);
  await network.check({ refresh: true });
  assert.equal(requests, 2);
  assert.equal(refreshed, 1);
});

test('a valid API response recovers after changing the connection and records its route', async () => {
  const configurations = [];
  let available = false;
  const browser = {
    setProxy: async (value) => configurations.push(value),
    closeAllConnections: async () => {},
    resolveProxy: async () => 'DIRECT',
    fetch: async () => ({
      ok: available, status: available ? 200 : 503,
      text: async () => available ? 'var YT = {};' : 'Unavailable',
    }),
  };
  const network = new NetworkConnection(browser, () => {});
  assert.equal((await network.check()).status, 'error');
  available = true;
  await network.configure({ mode: 'direct' });
  const result = await network.check();
  assert.equal(result.status, 'ready');
  assert.equal(result.proxy, '');
  assert.deepEqual(configurations, [{ mode: 'direct' }]);
  await network.configure({ mode: 'custom', proxy: 'http://127.0.0.1:8080' });
  assert.deepEqual(configurations[1], { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:8080' });
});

test('an unresponsive system proxy resolver cannot leave the check pending indefinitely', async () => {
  const browser = { resolveProxy: () => new Promise(() => {}) };
  const network = new NetworkConnection(browser, () => {});
  const result = await network.check();
  assert.equal(result.status, 'error');
  assert.match(result.detail, /8 секунд/);
  assert.equal(network.pending, null);
});
