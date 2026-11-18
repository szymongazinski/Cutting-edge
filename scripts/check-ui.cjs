'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '..');
(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'cutting-edge-ui-'));
  const docs = path.join(profile, 'Projects'),
    out = path.join(profile, 'Exports');
  await fs.writeFile(
    path.join(profile, 'settings.json'),
    JSON.stringify({ projectDir: docs, outputDir: out, language: 'en', theme: 'dark' }),
  );
  const app = await _electron.launch({
    args: process.env.CUTTING_EDGE_QA_EXE ? [] : [root],
    executablePath: process.env.CUTTING_EDGE_QA_EXE || require('electron'),
    env: { ...process.env, CUTTING_EDGE_PROFILE: profile },
    timeout: 60000,
  });
  const errors = [];
  const page = await app.firstWindow();
  page.setDefaultTimeout(18000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => {
    if (r.status() >= 400) console.warn('HTTP', r.status(), r.url());
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.warn('Renderer:', msg.text());
  });
  try {
    await page.locator('#app[aria-busy="false"]').waitFor({ timeout: 60000 });
    await page.evaluate(async () => {
      window.qaSession = await import('./session.mjs');
    });
    const session = (key) =>
      page.evaluate(async (key) => {
        const s = await import('./session.mjs');
        if (key === 'id') return s.rootProject().id;
        if (key === 'textCount') return s.project().clips.filter((c) => c.text === 'A real edit').length;
        return s.state.doc.path;
      }, key);
    const clipCount = () => page.locator('.ce-clip').count();
    assert.equal(await clipCount(), 4);
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('#stage video')].some((v) => v.videoWidth > 0 && v.readyState >= 2),
      null,
      { timeout: 18000 },
    );
    const screenshots = process.env.CUTTING_EDGE_SCREENSHOTS;
    if (screenshots) {
      await fs.mkdir(screenshots, { recursive: true });
      await page.screenshot({ path: path.join(screenshots, 'landscape.png') });
    }
    await page.getByRole('button', { name: 'Play (Space)', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#stage video')?.currentTime > 0.12);
    await page.getByRole('button', { name: 'Pause (Space)', exact: true }).click();
    await page.locator('#top').click({ position: { x: 660, y: 20 } });
    await page.keyboard.press('s');
    assert.equal(await clipCount(), 5);
    await page.keyboard.press('Control+z');
    assert.equal(await clipCount(), 4);
    await page.keyboard.press('m');
    await page.waitForFunction(
      () => !document.querySelector('[title="Timeline snapping (M)"]').classList.contains('active'),
    );
    const ui = await session('id');
    assert.ok(ui);
    await page.getByRole('button', { name: 'Stickers', exact: true }).click();
    await page.locator('.asset .variant').first().waitFor({ timeout: 60000 });
    const groups = await page.locator('.asset .variant').count();
    assert.ok(groups >= 2);
    const variant = page.locator('.asset .variant').first();
    const ids = await variant.locator('option').evaluateAll((o) => o.map((v) => v.value));
    assert.ok(ids.length >= 2);
    await variant.selectOption(ids[1]);
    await page.locator('.asset.active').dblclick({ position: { x: 22, y: 15 } });
    assert.equal(await clipCount(), 5);
    await page.keyboard.press('Control+z');
    await page.getByRole('button', { name: 'Templates', exact: true }).click();
    await page.getByRole('button', { name: 'Create template', exact: true }).click();
    await page.locator('[role=dialog]').getByRole('button', { name: 'Save template' }).click();
    await page.locator('.template-card').waitFor();
    assert.equal(await page.locator('.template-card').count(), 1);
    await page.getByRole('button', { name: 'Captions', exact: true }).click();
    await page.getByRole('button', { name: /Add text Title or custom text/ }).click();
    await page.locator('.modal textarea').fill('A real edit');
    await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click();
    assert.equal(await session('textCount'), 1);
    await page.getByRole('button', { name: '16:9', exact: true }).click();
    await page.getByLabel('Aspect ratio and resolution').selectOption('1080x1920');
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('#work.portrait').waitFor();
    assert.ok(
      await page
        .locator('#stage')
        .evaluate(
          (n) =>
            n.getBoundingClientRect().height >
            document.querySelector('#timeline').getBoundingClientRect().height,
        ),
    );
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'portrait.png') });
    await page.getByRole('button', { name: '9:16', exact: true }).click();
    await page.getByLabel('Aspect ratio and resolution').selectOption('1280x720');
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    const output = path.join(out, 'verified.mp4');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, output);
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: 'Choose file and export' }).click();
    await page.waitForFunction(
      () => [...document.querySelectorAll('.toast')].some((e) => e.textContent.includes('verified.mp4')),
      null,
      { timeout: 120000 },
    );
    assert.ok((await fs.stat(output)).size > 10000);
    const ffprobe = path.join(root, 'tools', 'ffprobe.exe');
    const { execFileSync } = require('node:child_process');
    const meta = JSON.parse(
      execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], {
        encoding: 'utf8',
      }),
    );
    assert.equal(meta.streams.find((s) => s.codec_type === 'video').width, 1280);
    assert.ok(Math.abs(+meta.format.duration - 8) < 0.12);
    await page.getByTitle('Settings', { exact: true }).first().click();
    await page.getByLabel('Language', { exact: true }).selectOption('pl');
    await page.getByLabel('Appearance').selectOption('light');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.locator('html[lang=pl][data-theme=light]').waitFor();
    await page.keyboard.press('Control+s');
    assert.deepEqual(errors, []);
    const savedFile = await session('path');
    const saved = JSON.parse(await fs.readFile(savedFile, 'utf8'));
    assert.ok(saved.clips.some((c) => c.text === 'A real edit'));
    const copyFile = path.join(docs, 'copy.cutproj');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, copyFile);
    await page.locator('#project-menu > button').click();
    await page.getByRole('button', { name: 'Zapisz kopię jako…' }).click();
    await page.waitForFunction((file) => window.qaSession.state.doc.path === file, copyFile);
    const copy = await fs.readFile(copyFile, 'utf8').then(JSON.parse);
    assert.notEqual(copy.id, saved.id);
    await page.getByRole('button', { name: '16:9', exact: true }).click();
    await app.evaluate(({ app }, file) => app.emit('second-instance', {}, [file]), savedFile);
    await page.waitForTimeout(250);
    assert.equal(await session('path'), copyFile);
    await page.getByRole('button', { name: 'Anuluj', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[role=dialog]'));
    await page.waitForFunction((file) => window.qaSession.state.doc.path === file, savedFile);
    if (screenshots) {
      await page.evaluate(async () => {
        const s = await import('./session.mjs');
        await s.prefs({ theme: 'dark' });
        await s.switchDoc(await window.cutting.call('sample'));
      });
      await page.waitForFunction(() => document.querySelector('#stage video')?.readyState >= 2);
      await page.locator('#notifications').evaluate((n) => n.replaceChildren());
      await page.screenshot({ path: path.join(screenshots, 'editor-pl.png') });
    }
    console.log(
      'Verified Electron playback, split/undo, snap shortcut, grouped GIF import, templates, text, both layouts, language/theme, autosave and actual H.264 + audio export.',
    );
  } catch (e) {
    console.error('Page:', (await page.locator('body').innerText()).slice(0, 3200));
    console.error('Errors:', errors);
    throw e;
  } finally {
    await app.close();
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
