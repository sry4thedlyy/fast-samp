const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const videoIdPattern = /^[\w-]{11}$/;
const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtu.be', 'www.youtube-nocookie.com', 'youtube-nocookie.com']);

function youtubeId(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || !youtubeHosts.has(url.hostname)) return null;
  const segments = url.pathname.split('/');
  const id = url.hostname === 'youtu.be' ? segments[1] :
    ['embed', 'shorts', 'live'].includes(segments[1]) ? segments[2] :
    url.pathname === '/watch' ? url.searchParams.get('v') : null;
  return videoIdPattern.test(id ?? '') ? id : null;
}

function wavName(title) {
  const safeTitle = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ')
    .trim().slice(0, 100).replace(/[ .]+$/, '');
  return `${safeTitle || 'Sample'} - FAST-SAMP.wav`;
}

async function readWav(file) {
  const handle = await fs.open(file);
  try {
    const header = Buffer.alloc(12);
    await handle.read(header, 0, 12, 0);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8) !== 'WAVE') {
      throw new Error('Ожидался файл WAV.');
    }
    let offset = 12;
    let format;
    const section = Buffer.alloc(8);
    while ((await handle.read(section, 0, 8, offset)).bytesRead === 8) {
      const name = section.toString('ascii', 0, 4);
      const size = section.readUInt32LE(4);
      const start = offset + 8;
      if (name === 'fmt ' && size >= 16) {
        const info = Buffer.alloc(16);
        await handle.read(info, 0, 16, start);
        format = {
          channels: info.readUInt16LE(2), rate: info.readUInt32LE(4),
          bytesPerFrame: info.readUInt16LE(12), bits: info.readUInt16LE(14),
        };
      }
      if (name === 'data' && format?.bits === 16 && format.bytesPerFrame > 0) {
        const frames = Math.floor(size / format.bytesPerFrame);
        const peaks = [];
        const frameBytes = format.bytesPerFrame;
        const step = Math.max(1, Math.floor(frames / 112));
        const buffer = Buffer.alloc(Math.min(step, 1600) * frameBytes);
        for (let index = 0; index < 112; index++) {
          const frame = Math.floor(index * frames / 112);
          const count = Math.min(buffer.length, (frames - frame) * frameBytes);
          const { bytesRead } = await handle.read(buffer, 0, count, start + frame * frameBytes);
          let peak = 0;
          for (let byte = 0; byte + 1 < bytesRead; byte += 2) {
            peak = Math.max(peak, Math.abs(buffer.readInt16LE(byte)));
          }
          peaks.push(peak / 32768);
        }
        return { ...format, seconds: frames / format.rate, peaks };
      }
      offset = start + size + (size % 2);
    }
    throw new Error('Не удалось прочитать аудио в готовом WAV.');
  } finally {
    await handle.close();
  }
}

function runDownloader(command, args, runtime, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 240_000,
    });
    runtime.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let pending = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop();
      lines.forEach(onLine);
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-3000); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (pending) onLine(pending);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || (signal
        ? 'Подготовка WAV прервана. Попробуй ещё раз.'
        : `yt-dlp завершился с кодом ${code}.`)));
    });
  });
}

async function downloadWav({ id, directory, tools, proxy = '', runtime, report }) {
  const wav = path.join(directory, 'track.wav');
  let title = '';
  let artist = '';
  let length = 0;
  const args = [
    '--ignore-config', '--no-playlist', '--no-warnings', '--no-simulate',
    '--proxy', proxy,
    '--socket-timeout', '15', '--retries', '2', '--extractor-retries', '1',
    '--js-runtimes', `node:${process.execPath}`, '--encoding', 'utf-8',
    '--ffmpeg-location', tools.ffmpeg, '--format', 'bestaudio/best',
    '--extract-audio', '--audio-format', 'wav',
    '--postprocessor-args', 'ExtractAudio+ffmpeg_o:-ac 2',
    '--newline', '--progress',
    '--progress-template', 'download:PROGRESS %(progress._percent_str)s',
    '--print', 'before_dl:TRACK %(title)j %(uploader)j',
    '--print', 'before_dl:LENGTH %(duration)s',
    '--output', path.join(directory, 'track.%(ext)s'),
    '--', `https://www.youtube.com/watch?v=${id}`,
  ];
  await runDownloader(tools.ytdlp, args, runtime, (line) => {
    if (line.startsWith('TRACK ')) {
      const metadata = line.match(/^TRACK ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|null|NA)$/);
      if (metadata) {
        title = JSON.parse(metadata[1]);
        artist = metadata[2] === 'NA' ? '' : JSON.parse(metadata[2]) ?? '';
        report({ title, artist });
      }
    }
    if (line.startsWith('LENGTH ')) length = Number(line.slice(7)) || 0;
    if (line.startsWith('PROGRESS ')) {
      const progress = Number.parseFloat(line.slice(9));
      if (Number.isFinite(progress)) report({ progress, status: progress >= 100 ? 'converting' : 'downloading' });
    }
  });
  report({ status: 'converting' });
  return { wav, title, artist, length };
}

function downloadError(error) {
  const detail = error.message.split(/\r?\n/).find((line) => line.includes('ERROR:')) ?? error.message;
  if (/sign in|confirm you.re not a bot|HTTP Error 403|HTTP Error 429/i.test(detail)) {
    return { message: 'YouTube ограничил доступ к загрузке. Попробуй другой трек.', detail };
  }
  if (/unavailable|private video|copyright|age.restricted/i.test(detail)) {
    return { message: 'Этот трек недоступен для загрузки.', detail };
  }
  if (/time.?out|unable to download|connect|ENOTFOUND|getaddrinfo/i.test(detail)) {
    return { message: 'Не удалось загрузить аудио. Проверь соединение и повтори.', detail };
  }
  return { message: 'Не удалось подготовить WAV. Попробуй снова.', detail };
}

module.exports = { youtubeId, videoIdPattern, wavName, readWav, downloadWav, downloadError };
