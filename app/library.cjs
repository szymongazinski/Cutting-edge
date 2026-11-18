'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { constants } = require('node:fs');
const { filename, readJson, writeJson, categories } = require('./workspace.cjs');
const { archiveRetiredStickers, findArchivedSticker, replacementId } = require('./retired-stickers.cjs');
const mediaExt = new Set(
  'mp4 mov mkv webm avi m4v mts m2ts ts mxf wmv flv mpg mpeg 3gp ogv gif apng png jpg jpeg webp bmp tif tiff avif mp3 wav m4a aac flac ogg opus aif aiff wma m4v'.split(
    ' ',
  ),
);
const ext = (file) => path.extname(file).slice(1).toLowerCase();
const isMedia = (file) => mediaExt.has(ext(file));
const idFor = (s) => createHash('sha256').update(s).digest('hex').slice(0, 24);
function ff(exe, args, onData) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
      windowsHide: true,
      stdio: ['ignore', onData ? 'pipe' : 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-1500);
    });
    if (onData) child.stdout.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(Error(err || 'Media preview failed'))));
  });
}
function needsProxy(m, file, size) {
  if (m.kind === 'image') return !['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif'].includes(ext(file));
  if (m.kind === 'audio') return !['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'].includes(ext(file));
  // The preview's ImageDecoder preserves GIF frame delays and transparent pixels.
  // Larger animations use a streaming proxy to bound the renderer's memory use.
  if (
    ext(file) === 'gif' && m.videoCodec === 'gif' && size <= 8 * 1024 * 1024 &&
    m.width <= 1024 && m.height <= 1024 && m.duration <= 30
  ) return false;
  return !(
    ['mp4', 'm4v', 'webm', 'mov'].includes(ext(file)) &&
    ['h264', 'vp8', 'vp9', 'av1'].includes(m.videoCodec) &&
    (!m.hasAudio || ['aac', 'mp3', 'opus', 'vorbis'].includes(m.audioCodec))
  );
}
class Library {
  constructor(workspace, engine) {
    this.ws = workspace;
    this.engine = engine;
    this.cacheDir = path.join(workspace.data, 'Previews');
    this.allowed = new Set();
    this.pending = new Map();
  }
  allow(asset) {
    for (const p of [asset.path, asset.previewPath, asset.thumbnail])
      if (p && isMedia(p) && path.isAbsolute(p)) this.allowed.add(path.resolve(p).toLowerCase());
  }
  async init() {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const stock = path.join(this.ws.bundled, 'library');
    try {
      await fs.cp(stock, this.ws.libraryDir, { recursive: true, force: false, errorOnExist: false });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await archiveRetiredStickers(this.ws);
  }
  folder(category, group) {
    if (!categories.includes(category)) throw Error('Unknown library');
    const root = path.join(this.ws.libraryDir, category);
    return group && category === 'sticker' ? path.join(root, filename(group)) : root;
  }
  async inspect(file, category = 'media', group) {
    file = path.resolve(file);
    if (!isMedia(file)) throw Error('Unsupported media / Nieobsługiwane media: ' + path.basename(file));
    const stat = await fs.stat(file);
    const revision = ext(file) === 'gif' ? 6 : 5;
    const key = idFor(file.toLowerCase() + '|' + stat.size + '|' + stat.mtimeMs + '|' + revision);
    let promise = this.pending.get(key);
    if (!promise) {
      promise = this.describe(file, key, stat.size).finally(() => this.pending.delete(key));
      this.pending.set(key, promise);
    }
    const [meta, archive] = await Promise.all([promise, findArchivedSticker(file, this.ws)]);
    const asset = {
      ...meta,
      id: archive ? replacementId(category, file) : idFor(category + '|' + file.toLowerCase()),
      path: file,
      name: path.basename(file),
      category,
    };
    if (archive) asset.reusedStickerPath = true;
    if (category === 'sticker') {
      asset.group = group || path.basename(file, path.extname(file));
      asset.variant = path.basename(file, path.extname(file));
    }
    this.allow(asset);
    return asset;
  }
  async describe(file, key, size) {
    const base = path.join(this.cacheDir, key);
    const cached = await readJson(base + '.json', null);
    if (cached) {
      const files = [cached.previewPath, cached.thumbnail].filter(Boolean);
      const present = await Promise.all(
        files.map((p) =>
          fs.access(p).then(
            () => true,
            () => false,
          ),
        ),
      );
      if (present.every(Boolean)) return cached;
    }
    const meta = await this.engine.probeAsset(file);
    const { ffmpeg } = await this.engine.getBinaries();
    if (needsProxy(meta, file, size)) {
      const alpha =
        ['gif', 'apng', 'qtrle', 'prores', 'png', 'vp9', 'webp'].includes(meta.videoCodec) ||
        ['gif', 'apng'].includes(ext(file));
      const target =
        base +
        (meta.kind === 'audio' ? '.m4a' : meta.kind === 'image' ? '.png' : alpha ? '.webm' : '.mp4');
      const args =
        meta.kind === 'audio'
          ? ['-vn', '-c:a', 'aac', '-b:a', '160k']
          : meta.kind === 'image'
            ? ['-frames:v', '1']
            : alpha
              ? [
                  '-vf',
                  'scale=w=min(1280\\,iw):h=-2',
                  '-c:v',
                  'libvpx-vp9',
                  '-pix_fmt',
                  'yuva420p',
                  '-auto-alt-ref',
                  '0',
                  '-deadline',
                  'realtime',
                  '-cpu-used',
                  '6',
                  '-b:v',
                  '0',
                  '-crf',
                  '30',
                  '-c:a',
                  'libopus',
                ]
              : [
                  '-vf',
                  'scale=w=min(1280\\,iw):h=-2',
                  '-c:v',
                  'libx264',
                  '-preset',
                  'veryfast',
                  '-crf',
                  '23',
                  '-pix_fmt',
                  'yuv420p',
                  '-c:a',
                  'aac',
                  '-movflags',
                  '+faststart',
                ];
      await ff(ffmpeg, ['-y', '-i', file, ...args, target]);
      meta.previewPath = target;
    }
    if (meta.kind !== 'audio') {
      const jpg = base + '.jpg';
      try {
        await ff(ffmpeg, [
          '-y',
          '-ss',
          String(Math.min(0.2, (meta.duration || 1) / 4)),
          '-i',
          file,
          '-frames:v',
          '1',
          '-vf',
          'scale=320:180:force_original_aspect_ratio=decrease',
          '-q:v',
          '4',
          jpg,
        ]);
        await fs.access(jpg);
        meta.thumbnail = jpg;
      } catch {
        if (meta.kind === 'image') meta.thumbnail = meta.previewPath || file;
      }
    }
    if (meta.hasAudio) {
      const sampleTime = meta.duration || 1;
      const wave = new Array(Math.max(80, Math.min(4096, Math.ceil(sampleTime * 15)))).fill(0);
      let index = 0;
      let carry = Buffer.alloc(0);
      try {
        await ff(
          ffmpeg,
          [
            '-i',
            file,
            '-t',
            String(sampleTime),
            '-vn',
            '-ac',
            '1',
            '-af',
            'aresample=8000',
            '-f',
            's16le',
            'pipe:1',
          ],
          (chunk) => {
            const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
            for (let j = 0; j + 1 < bytes.length; j += 2) {
              const bin = Math.min(
                wave.length - 1,
                Math.floor((index++ * wave.length) / (sampleTime * 8000)),
              );
              wave[bin] = Math.max(wave[bin], Math.abs(bytes.readInt16LE(j)) / 32768);
            }
            carry = bytes.subarray(bytes.length - (bytes.length % 2));
          },
        );
        meta.waveform = wave;
        meta.waveformDuration = sampleTime;
      } catch {}
    }
    await writeJson(base + '.json', meta);
    return meta;
  }
  async import(file, category = 'media', group) {
    if (!isMedia(file)) throw Error('Unsupported media: ' + path.basename(file));
    if (category === 'media') return this.inspect(file, 'media');
    const folder = this.folder(category, group);
    await fs.mkdir(folder, { recursive: true });
    let dest = path.join(folder, path.basename(file));
    const copying = path.resolve(dest).toLowerCase() !== path.resolve(file).toLowerCase();
    if (copying) {
      try {
        await fs.copyFile(file, dest, constants.COPYFILE_EXCL);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        dest = path.join(
          folder,
          path.parse(file).name + '-' + randomUUID().slice(0, 6) + path.extname(file),
        );
        await fs.copyFile(file, dest, constants.COPYFILE_EXCL);
      }
    }
    try {
      return await this.inspect(dest, category, group);
    } catch (error) {
      if (copying) await fs.rm(dest, { force: true });
      throw error;
    }
  }
  async scan(category) {
    const folder = this.folder(category),
      assets = [],
      errors = [];
    const visit = async (dir, group, depth) => {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, item.name);
        if (item.isDirectory() && depth < 4) {
          await visit(file, group || item.name, depth + 1);
          continue;
        }
        if (!item.isFile() || !isMedia(file)) continue;
        try {
          assets.push(await this.inspect(file, category, group));
        } catch (err) {
          errors.push(item.name + ': ' + err.message);
        }
      }
    };
    await visit(folder, undefined, 0);
    return { assets, errors };
  }
}
module.exports = { Library, isMedia, mediaExt };
