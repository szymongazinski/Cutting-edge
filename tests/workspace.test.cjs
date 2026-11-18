const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Workspace } = require('../app/workspace.cjs');
test('an unreadable import does not leave a broken shared asset or remove the source', async (t) => {
  const { Library } = require('../app/library.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cut-bad-import-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ws = new Workspace({ data: path.join(dir, 'data'), documents: dir, videos: dir, bundled: dir });
  await ws.init();
  const files = new Library(ws, {
    probeAsset: async () => {
      throw Error('Unreadable media');
    },
  });
  await fs.mkdir(files.cacheDir, { recursive: true });
  const source = path.join(dir, 'broken.wav');
  await fs.writeFile(source, 'bad');
  await assert.rejects(files.import(source, 'audiofx'), /Unreadable/);
  assert.deepEqual(await fs.readdir(files.folder('audiofx')), []);
  assert.equal(await fs.readFile(source, 'utf8'), 'bad');
});
test('projects with identical titles get independent files, reload edits and reject invalid documents', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cut-workspace-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = {
    data: dir,
    documents: dir,
    videos: dir,
    bundled: path.join(dir, 'bundled'),
    locale: 'en-US',
  };
  const workspace = new Workspace(config);
  await workspace.init();
  const a = await workspace.create('Day / 01');
  const b = await workspace.create('Day / 01');
  assert.notEqual(a.path, b.path);
  a.project.name = 'Changed';
  await workspace.save(a.path, a.project);
  assert.equal((await workspace.open(a.path)).project.name, 'Changed');
  await assert.rejects(() => workspace.save(a.path, { ...b.project, width: -3 }));
  assert.equal((await workspace.open(a.path)).project.name, 'Changed');
  await workspace.setSettings({ defaultFormat: 'webm', defaultFps: 60 });
  assert.equal((await workspace.create('New')).project.format, 'webm');
  assert.equal((await workspace.open(a.path)).project.fps, 30);
});
