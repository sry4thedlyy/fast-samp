const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createReadStream, existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const ytDlpRelease = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const ffmpegRelease = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.7z';

function toolPaths(directory) {
  return { ytdlp: path.join(directory, 'yt-dlp.exe'), ffmpeg: directory };
}

function audioToolsReady(directory) {
  return ['yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe'].every((name) => existsSync(path.join(directory, name)));
}

function windowsTool(name, args, timeout = 30_000) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name);
  return exec(executable, args, { windowsHide: true, timeout });
}

async function download(url, target) {
  await windowsTool('curl.exe', [
    '--fail', '--silent', '--show-error', '--location', '--proto', '=https',
    '--retry', '2', '--connect-timeout', '15', '--max-time', '150', '--output', target, url,
  ], 170_000);
}

async function verify(file, expected) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (!expected || hash.digest('hex') !== expected.toLowerCase()) {
    throw new Error(`Checksum mismatch for ${path.basename(file)}`);
  }
}

async function setupAudio(directory, { update = false } = {}) {
  if (audioToolsReady(directory) && !update) return;
  await fs.mkdir(directory, { recursive: true });
  const staging = await fs.mkdtemp(path.join(directory, 'download-'));
  try {
    const ytDlp = path.join(directory, 'yt-dlp.exe');
    if (update || !existsSync(ytDlp)) {
      const binary = path.join(staging, 'yt-dlp.exe');
      const sums = path.join(staging, 'SHA2-256SUMS');
      await download(`${ytDlpRelease}/SHA2-256SUMS`, sums);
      await download(`${ytDlpRelease}/yt-dlp.exe`, binary);
      const expected = (await fs.readFile(sums, 'utf8')).match(/^([a-f0-9]{64})\s+\*?yt-dlp\.exe\s*$/im)?.[1];
      await verify(binary, expected);
      await fs.rename(binary, ytDlp);
    }
    if (!audioToolsReady(directory)) {
      const archive = path.join(staging, 'ffmpeg.7z');
      const checksum = path.join(staging, 'ffmpeg.sha256');
      await download(`${ffmpegRelease}.sha256`, checksum);
      await download(ffmpegRelease, archive);
      await verify(archive, (await fs.readFile(checksum, 'utf8')).match(/[a-f0-9]{64}/i)?.[0]);
      await windowsTool('tar.exe', [
        '-xf', archive, '-C', staging, '--include', '*/bin/ffmpeg.exe', '--include', '*/bin/ffprobe.exe', '--include', '*/LICENSE',
      ], 90_000);
      const build = (await fs.readdir(staging, { withFileTypes: true }))
        .find((entry) => entry.isDirectory() && /^ffmpeg-.+-essentials_build$/.test(entry.name));
      if (!build) throw new Error('FFmpeg archive has an unexpected layout');
      const bundle = path.join(staging, build.name);
      await fs.rename(path.join(bundle, 'LICENSE'), path.join(directory, 'FFmpeg-LICENSE.txt'));
      for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
        await fs.rename(path.join(bundle, 'bin', name), path.join(directory, name));
      }
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(console.warn);
  }
}

if (require.main === module) {
  const directory = path.resolve(__dirname, '..', 'tools');
  setupAudio(directory, { update: process.argv.includes('--update') })
    .then(() => console.log(`Audio tools are ready in ${directory}`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { audioToolsReady, setupAudio, toolPaths };
