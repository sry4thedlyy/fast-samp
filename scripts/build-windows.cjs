const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Build this package with x64 Node.js on Windows.');
}

const root = path.resolve(__dirname, '..');
const release = process.argv.includes('--release');
const tools = ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe', 'FFmpeg-LICENSE.txt'];
if (!release && tools.some((file) => !fs.existsSync(path.join(root, 'tools', file)))) {
  throw new Error('Run npm run setup:audio before building.');
}

const electron = require('electron');
const output = path.join(root, 'dist', ...(release ? ['release'] : []), 'FAST-SAMP');
const appTarget = path.join(output, 'resources', 'app');
const toolTarget = path.join(output, 'resources', 'tools');
fs.mkdirSync(output, { recursive: true });
for (const entry of fs.readdirSync(path.dirname(electron))) {
  const fileName = entry === 'electron.exe' ? 'FAST-SAMP.exe' : entry;
  fs.cpSync(path.join(path.dirname(electron), entry), path.join(output, fileName), { recursive: true });
}
fs.mkdirSync(appTarget, { recursive: true });
fs.cpSync(path.join(root, 'app'), path.join(appTarget, 'app'), { recursive: true });
fs.copyFileSync(path.join(root, 'package.json'), path.join(appTarget, 'package.json'));
if (release) {
  const archive = path.join(path.dirname(output), 'FAST-SAMP-windows-x64.zip');
  execFileSync('tar.exe', ['-acf', archive, '-C', path.dirname(output), path.basename(output)], { stdio: 'inherit' });
  console.log(archive);
} else {
  fs.mkdirSync(toolTarget, { recursive: true });
  for (const file of tools) fs.copyFileSync(path.join(root, 'tools', file), path.join(toolTarget, file));
  console.log(path.join(output, 'FAST-SAMP.exe'));
}
