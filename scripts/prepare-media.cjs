const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { isFile, sha256, download, unpack } = require('../app/media-process.cjs');

const url =
  'https://github.com/GyanD/codexffmpeg/releases/download/7.1.1/ffmpeg-7.1.1-essentials_build.zip';
const archiveSha = '04861d3339c5ebe38b56c19a15cf2c0cc97f5de4fa8910e4d47e5e6404e4a2d4';
const files = {
  'ffmpeg.exe': 'b90225987bdd042cca09a1efb5e34e9848f2d1dbf5fbcd388753a44145522997',
  'ffprobe.exe': '05e8fa639450f8191635192871ae37a3ec3e4638fa12f3b7d49c6522ba16a8ed',
  LICENSE: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
};
const repo = path.join(__dirname, '..');
const target = path.join(repo, 'tools');
async function verified(folder, binSubdir = '') {
  if (!folder) return false;
  for (const [name, digest] of Object.entries(files)) {
    const file = path.join(folder, name === 'LICENSE' ? '' : binSubdir, name);
    if (!(await isFile(file)) || (await sha256(file)) !== digest) return false;
  }
  return true;
}

async function prepare() {
  await fs.mkdir(target, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cutting-edge-ffmpeg-'));
  try {
    if (!(await verified(target))) {
      let source =
        process.env.LOCALAPPDATA &&
        path.join(process.env.LOCALAPPDATA, 'ListenActive', 'tools', 'ffmpeg-7.1.1');
      let bin = '';
      if (!(await verified(source))) {
        const archive = path.join(temporary, 'ffmpeg.zip');
        console.log('Downloading FFmpeg 7.1.1 x64 from Gyan…');
        await download(url, archiveSha, archive);
        await unpack(archive, temporary);
        source = path.join(temporary, 'ffmpeg-7.1.1-essentials_build');
        bin = 'bin';
        if (!(await verified(source, bin))) throw new Error('Unexpected contents in FFmpeg archive.');
      }
      for (const name of Object.keys(files)) {
        await fs.copyFile(
          path.join(source, name === 'LICENSE' ? '' : bin, name),
          path.join(target, name),
        );
      }
    }
    await fs.copyFile(path.join(repo, 'docs', 'media-tools.md'), path.join(target, 'THIRD-PARTY.md'));
    console.log('Verified FFmpeg 7.1.1 and FFprobe for Windows x64 in ' + target);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
prepare().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
