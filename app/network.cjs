function downloaderProxy(resolved) {
  const first = resolved.split(';')[0].trim();
  if (first === 'DIRECT') return '';
  const match = first.match(/^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(\S+)$/);
  if (!match) throw new Error('Не удалось определить системный прокси.');
  const protocols = { PROXY: 'http', HTTPS: 'https', SOCKS: 'socks5', SOCKS4: 'socks4', SOCKS5: 'socks5' };
  return `${protocols[match[1]]}://${match[2]}`;
}

async function systemProxy(browserSession, url) {
  let timeout;
  try {
    const deadline = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Системный прокси не ответил за 8 секунд.')), 8000);
    });
    const route = await Promise.race([browserSession.resolveProxy(url), deadline]);
    return downloaderProxy(route);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { downloaderProxy, systemProxy };
