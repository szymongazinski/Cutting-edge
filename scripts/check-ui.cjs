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
    const footage = page.locator('#timeline .ce-clip[aria-label="Ridgeline.mp4"]');
    const cropMenu = page.locator('.ce-edit-menu:visible').getByText('Crop source', { exact: true });
    const cropDialog = page.getByRole('dialog', { name: 'Crop source', exact: true });
    await footage.click({ button: 'right' });
    await cropMenu.click();
    assert.equal(await cropDialog.locator('img').getAttribute('alt'), 'Ridgeline.mp4');
    await cropDialog.getByLabel('Zoom').press('ArrowRight');
    await cropDialog.getByRole('button', { name: 'Apply crop' }).click();
    await page.waitForFunction(() => window.qaSession.project().clips.find((c) => c.name === 'Ridgeline.mp4').crop.w < 1);
    await page.keyboard.press('Control+z');
    const frame = page.locator('.ce-stage-frame');
    const frameRect = await frame.boundingBox();
    await frame.click({ button: 'right', position: { x: frameRect.width * 0.72, y: frameRect.height * 0.3 } });
    await cropMenu.click();
    assert.equal(await cropDialog.locator('img').getAttribute('alt'), 'Ridgeline.mp4');
    await cropDialog.getByRole('button', { name: 'Cancel' }).click();
    await page.locator('#properties').getByRole('button', { name: 'Crop source' }).click();
    await cropDialog.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Stickers', exact: true }).click();
    await page.locator('.asset .variant').first().waitFor({ timeout: 60000 });
    const labels = await page.locator('.asset-name').allTextContents();
    assert.deepEqual(labels, [
      'Straight Arrow Thin', 'Straight Arrow Bold', 'Curved Arrow Thin', 'Curved Arrow Bold',
      'Clean Circle', 'Sketched Circle', 'Double Circle', 'Single Underline', 'Double Underline',
    ]);
    await page.waitForFunction(() => [...document.querySelectorAll('.asset-thumb.fx img')].every((img) => img.naturalWidth > 0));
    const clipped = await page.locator('.asset-thumb.fx').evaluateAll((tiles) => tiles.filter((tile) => {
      const thumb = tile.getBoundingClientRect();
      const img = tile.querySelector('img').getBoundingClientRect();
      return img.bottom > thumb.bottom + 1 || img.right > thumb.right + 1;
    }).map((tile) => tile.parentElement.ariaLabel));
    assert.deepEqual(clipped, []);
    const variant = page.locator('.asset .variant').first();
    const ids = await variant.locator('option').evaluateAll((o) => o.map((v) => v.value));
    assert.equal(ids.length, 6);
    await variant.selectOption(ids[1]);
    await page.locator('.asset.active').dblclick({ position: { x: 22, y: 15 } });
    assert.equal(await clipCount(), 5);
    const sticker = await page.evaluate(() =>
      Object.values(window.qaSession.project().assets).find((a) => a.category === 'sticker'),
    );
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#stage canvas.ce-stage-media');
      if (!canvas) return false;
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels[3] === 0 && pixels.some((value, i) => i % 4 === 3 && value > 220);
    });
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
    assert.equal(await page.getByLabel('Source edge handles').inputValue(), 'crop');
    await page.getByLabel('Source edge handles').selectOption('stretch');
    await page.getByLabel('Language', { exact: true }).selectOption('pl');
    await page.getByLabel('Appearance').selectOption('light');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.locator('html[lang=pl][data-theme=light]').waitFor();
    assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'settings.json'), 'utf8')).edgeDragMode, 'stretch');
    await page.getByRole('button', { name: 'Naklejki', exact: true }).click();
    await page.getByLabel('Szukaj w bibliotece', { exact: true }).fill('podkreślenie');
    await page.waitForFunction(() => document.querySelectorAll('.asset .variant').length === 2);
    const polishColors = await page.locator('.asset .variant').first().locator('option').allTextContents();
    assert.ok(polishColors.includes('Biały') && polishColors.includes('Atramentowy'));
    const customFamily = path.join(profile, 'Library', 'sticker', 'Kółko');
    await fs.mkdir(customFamily);
    await fs.copyFile(sticker.path, path.join(customFamily, 'Własny.gif'));
    await page.getByLabel('Szukaj w bibliotece', { exact: true }).fill('kółko');
    await page.getByRole('button', { name: 'Odśwież bibliotekę' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.asset-name').length === 4);
    const circleNames = await page.locator('.asset-name').allTextContents();
    assert.equal(new Set(circleNames).size, 4);
    await page.getByRole('button', { name: 'Dodaj pliki', exact: true }).click();
    const suggestions = await page.locator('#sticker-groups option').evaluateAll((opts) => opts.map((o) => o.value));
    assert.ok(suggestions.includes('Kółko') && suggestions.includes('Clean Circle'));
    await page.getByRole('dialog').getByRole('button', { name: 'Anuluj' }).click();
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
    const legacyPath = path.join(docs, 'cleared-gif-cache.cutproj');
    const legacyAsset = { ...sticker, previewPath: path.join(profile, 'Previews', 'old-missing.webm') };
    await fs.writeFile(legacyPath, JSON.stringify({
      ...saved, id: 'old-cache-test', assets: { [sticker.id]: legacyAsset },
      clips: [{ ...saved.clips.find((c) => c.kind === 'media'), assetId: sticker.id, start: 0 }],
    }));
    await app.evaluate(({ app }, file) => app.emit('second-instance', {}, [file]), legacyPath);
    await page.waitForFunction((file) => window.qaSession.state.doc.path === file, legacyPath);
    assert.equal(await page.evaluate((id) => window.qaSession.project().assets[id].previewPath, sticker.id), undefined);
    await page.locator('#stage canvas.ce-stage-media').waitFor();
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
      'Verified Electron playback, split/undo, both crop menus and inspector, edge preference, 9 sticker families × 6 colors, Polish search, templates, both layouts, save and H.264 + audio export.',
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
