function connectionSettings(value = {}) {
  const mode = value.mode || 'system';
  if (!['system', 'direct', 'custom'].includes(mode)) throw new Error('Выбери способ подключения.');
  if (mode !== 'custom') return { mode, proxy: '' };
  let url;
  try { url = new URL(value.proxy); } catch { throw new Error('Укажи адрес прокси, например http://127.0.0.1:8080.'); }
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol) || !url.hostname ||
    url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Поддерживается HTTP, HTTPS или SOCKS без логина и пароля.');
  }
  return { mode, proxy: url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin };
}

function downloaderProxy(resolved) {
  const first = resolved.split(';')[0].trim();
  if (first === 'DIRECT') return '';
  const match = first.match(/^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(\S+)$/);
  if (!match) throw new Error('Не удалось определить прокси для загрузчика.');
  const protocols = { PROXY: 'http', HTTPS: 'https', SOCKS: 'socks5', SOCKS4: 'socks4', SOCKS5: 'socks5' };
  return `${protocols[match[1]]}://${match[2]}`;
}

class NetworkConnection {
  constructor(browserSession, notify) {
    this.session = browserSession;
    this.notify = notify;
    this.settings = connectionSettings();
    this.result = { status: 'idle' };
    this.pending = null;
    this.checkedAt = 0;
  }

  async configure(value) {
    const config = connectionSettings(value);
    const proxy = config.mode === 'custom'
      ? { mode: 'fixed_servers', proxyRules: config.proxy }
      : { mode: config.mode };
    await this.session.setProxy(proxy);
    await this.session.closeAllConnections();
    this.settings = config;
    this.checkedAt = 0;
    this.result = { status: 'idle' };
    return config;
  }

  check({ refresh = false } = {}) {
    if (this.pending) return this.pending;
    if (!refresh && Date.now() - this.checkedAt < 5000) return Promise.resolve(this.result);
    this.pending = this.runCheck(refresh).finally(() => { this.pending = null; });
    return this.pending;
  }

  async runCheck(refresh) {
    this.result = { ...this.result, status: 'checking' };
    this.notify(this.result);
    const controller = new AbortController();
    let timeout;
    const deadline = new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('YouTube не ответил за 8 секунд.'));
      }, 8000);
    });
    let route = '';
    try {
      const request = async () => {
        if (refresh && this.settings.mode === 'system') await this.session.forceReloadProxyConfig();
        route = await this.session.resolveProxy('https://www.youtube.com/iframe_api');
        const proxy = downloaderProxy(route);
        const response = await this.session.fetch('https://www.youtube.com/iframe_api', {
          signal: controller.signal, cache: 'no-store',
        });
        const script = await response.text();
        if (!response.ok || !script.includes('YT')) throw new Error(`YouTube IFrame API returned HTTP ${response.status}`);
        return { status: 'ready', message: 'YouTube доступен.', route, proxy };
      };
      this.result = await Promise.race([request(), deadline]);
    } catch (error) {
      const message = route && route !== 'DIRECT'
        ? 'YouTube недоступен через выбранный прокси. Проверь его адрес и работу.'
        : 'YouTube недоступен в текущем подключении. Проверь, открывается ли он в браузере.';
      this.result = { status: 'error', message, route, detail: error.message };
    } finally {
      clearTimeout(timeout);
      this.checkedAt = Date.now();
      this.notify(this.result);
    }
    return this.result;
  }
}

module.exports = { connectionSettings, downloaderProxy, NetworkConnection };
