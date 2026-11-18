'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const legacy = require('./stock-1.0.0.json');

const archiveDir = (ws) => path.join(ws.data, 'Archived stickers', '1.0.0');
const oldNoticeHash = '3b2a5ccdeb07b13b106665959a39f49739c2037149e170ff6c42e838d5ecf7d6';

async function info(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

async function matches(file, item) {
  const stat = await info(file);
  if (!stat?.isFile() || stat.size !== item.size) return false;
  return createHash('sha256').update(await fs.readFile(file)).digest('hex') === item.sha256;
}

async function archiveCopy(source, target, item) {
  if (await info(target)) return matches(target, item);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    await fs.copyFile(source, temporary);
    if (!(await matches(temporary, item))) return false;
    await fs.rename(temporary, target);
    return true;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

// Keep the original bytes available to any project, including files outside the recent list.
async function archiveRetiredStickers(ws, catalog = legacy) {
  const archive = archiveDir(ws);
  const done = path.join(archive, 'complete');
  if (await info(done)) return;
  await fs.mkdir(archive, { recursive: true });
  const root = path.join(ws.libraryDir, 'sticker');
  if (!(await info(root))?.isDirectory()) return;
  const movedFrom = new Set();
  let retry = false;
  for (const [relative, item] of Object.entries(catalog)) {
    const source = path.join(root, relative);
    const group = path.dirname(source);
    try {
      if (!(await info(group))?.isDirectory() || !(await matches(source, item))) continue;
      const target = path.join(archive, relative);
      if (!(await archiveCopy(source, target, item))) throw Error('Archive checksum mismatch: ' + relative);
      if (await matches(source, item)) {
        await fs.unlink(source);
        movedFrom.add(group);
      }
    } catch (error) {
      // A busy file can still serve existing projects. Try it again on the next launch.
      console.warn('[Cutting edge] Sticker migration:', error.message);
      retry = true;
    }
  }
  for (const group of movedFrom) {
    try {
      await fs.rmdir(group);
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) console.warn(error.message);
    }
  }
  try {
    const notice = path.join(ws.libraryDir, 'NOTICE.md');
    const noticeInfo = await info(notice);
    if (ws.bundled && noticeInfo?.isFile() && noticeInfo.size < 1024) {
      const previous = (await fs.readFile(notice, 'utf8')).replace(/\r\n/g, '\n');
      if (createHash('sha256').update(previous).digest('hex') === oldNoticeHash) {
        await fs.copyFile(path.join(ws.bundled, 'library', 'NOTICE.md'), notice);
      }
    }
  } catch (error) {
    console.warn('[Cutting edge] Library notice:', error.message);
    retry = true;
  }
  if (!retry) await fs.writeFile(done, '');
}

const installLibrary = path.join(path.dirname(process.execPath), 'Library');
async function findArchivedSticker(file, ws, libraryAlias = installLibrary, catalog = legacy) {
  for (const library of [ws.libraryDir, libraryAlias].filter(Boolean)) {
    const relative = path.relative(path.join(library, 'sticker'), file).split(path.sep).join('/');
    if (relative.startsWith('../') || path.isAbsolute(relative)) continue;
    let key = relative;
    if (!Object.hasOwn(catalog, key)) {
      if (process.platform !== 'win32') continue;
      key = Object.keys(catalog).find((name) => name.toLowerCase() === relative.toLowerCase());
    }
    if (!key) continue;
    const archived = path.join(archiveDir(ws), key);
    if (await matches(archived, catalog[key])) return archived;
  }
  return null;
}

// Two clips in one project may refer to the old stock GIF and a later import
// that reused its filename. Give the replacement a separate stable asset ID.
function replacementId(category, file) {
  return createHash('sha256').update('after-stock-1.0.0|' + category + '|' + file.toLowerCase())
    .digest('hex').slice(0, 24);
}

async function resolveStickerPath(asset, ws, libraryAlias, catalog) {
  // Relinking preserves a project's asset ID, so the source choice travels with its metadata.
  if (asset.reusedStickerPath === true) return asset.path;
  return (await findArchivedSticker(asset.path, ws, libraryAlias, catalog)) ?? asset.path;
}

module.exports = { archiveRetiredStickers, findArchivedSticker, replacementId, resolveStickerPath };
