const { test } = require('node:test');
const assert = require('node:assert/strict');
const { downloaderProxy, systemProxy } = require('../app/network.cjs');
const { downloadError } = require('../app/audio.cjs');

test('system routes are passed to yt-dlp explicitly, including direct connections', () => {
  assert.equal(downloaderProxy('DIRECT'), '');
  assert.equal(downloaderProxy('PROXY localhost:10809; DIRECT'), 'http://localhost:10809');
  assert.equal(downloaderProxy('HTTPS proxy.example:443'), 'https://proxy.example:443');
  assert.equal(downloaderProxy('SOCKS5 [::1]:1080'), 'socks5://[::1]:1080');
  assert.throws(() => downloaderProxy('unexpected route'));
});

test('the downloader resolves the proxy for the requested video URL', async () => {
  const url = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
  const browser = { resolveProxy: async (requested) => {
    assert.equal(requested, url);
    return 'PROXY localhost:10809';
  } };
  assert.equal(await systemProxy(browser, url), 'http://localhost:10809');
});

test('connection errors give a short actionable message and retain technical details', () => {
  const proxy = downloadError(new Error('ERROR: [youtube] ProxyError: Connection refused'));
  assert.match(proxy.message, /прокси.*VPN/);
  assert.match(proxy.detail, /ProxyError/);
  const timeout = downloadError(new Error('ERROR: [youtube] Read timed out. (read timeout=10.0)'));
  assert.match(timeout.message, /Нет соединения с YouTube/);
});

test('an unresponsive system proxy resolver is bounded', async () => {
  const browser = { resolveProxy: () => new Promise(() => {}) };
  await assert.rejects(systemProxy(browser, 'https://www.youtube.com/'), /8 секунд/);
});
