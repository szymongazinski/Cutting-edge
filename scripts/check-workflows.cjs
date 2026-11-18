'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '..');
(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'cutting-edge-flows-'));
  const output = path.join(profile, 'Films'),
    docs = path.join(profile, 'Projects');
  const speech = path.join(profile, 'voice.wav'),
    padded = path.join(profile, 'voice-with-pauses.wav');
  const source = path.join(root, 'assets', 'sample', 'Ridgeline.mp4');
  const script =
    "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile($env:CUTTING_EDGE_QA_VOICE); $s.Speak('Welcome to the video studio. We can edit our recording together.'); $s.Dispose()";
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    env: { ...process.env, CUTTING_EDGE_QA_VOICE: speech },
  });
  execFileSync(
    path.join(root, 'tools', 'ffmpeg.exe'),
    ['-v', 'error', '-i', speech, '-af', 'adelay=850,apad=pad_dur=1', '-ar', '16000', '-ac', '1', padded],
    { windowsHide: true },
  );
  await fs.writeFile(
    path.join(profile, 'settings.json'),
    JSON.stringify({
      projectDir: docs,
      outputDir: output,
      language: 'en',
      theme: 'dark',
      defaultWidth: 1280,
      defaultHeight: 720,
    }),
  );
  const application = await _electron.launch({
    args: process.env.CUTTING_EDGE_QA_EXE ? [] : [root],
    executablePath: process.env.CUTTING_EDGE_QA_EXE || require('electron'),
    env: { ...process.env, CUTTING_EDGE_PROFILE: profile, CUTTING_EDGE_QA_HIDDEN: '1' },
    timeout: 60000,
  });
  const page = await application.firstWindow(),
    fail = [];
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => fail.push(e.message));
  const button = (name, parent = page) => parent.getByRole('button', { name, exact: true });
  const dlg = () => page.getByRole('dialog').last();
  const read = () =>
    page.evaluate(async () => structuredClone((await import('./session.mjs')).rootProject()));
  const choose = (files) =>
    application.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    }, files);
  async function create(name) {
    await page.locator('#project-menu >button').click();
    await button('New project').click();
    await page.getByLabel('Project name', { exact: true }).fill(name);
    await button('Create project', dlg()).click();
    await page.waitForFunction((name) => document.title.startsWith(name), name);
  }
  try {
    await page.locator('#app[aria-busy=false]').waitFor({ timeout: 60000 });
    await create('Workflow verification');
    await choose([source, padded]);
    await button('Import files').click();
    await page.locator('.asset').nth(1).waitFor();
    for (const a of await page.locator('.asset').all()) await a.dblclick({ position: { x: 21, y: 13 } });
    const lanes = page.locator('.ce-clip');
    assert.equal(await lanes.count(), 2);
    await lanes.first().click({ position: { x: 45, y: 9 } });
    await lanes.last().click({ modifiers: ['Control'], position: { x: 45, y: 9 } });
    await button('Sync and create compound clip').click();
    await page.getByLabel('Compound clip name').fill('Screen + commentary');
    await dlg().locator('input[type=number]').last().fill('0.15');
    await button('Create compound clip', dlg()).click();
    let document = await read();
    assert.equal(document.clips.length, 1);
    assert.equal(document.clips[0].children.length, 2);
    assert.equal(Math.max(...document.clips[0].children.map((c) => c.start)), 0.15);
    const initial = document.clips[0].duration;
    await button('Remove silence', page.locator('#properties')).click();
    await page.getByLabel('Silence threshold (dB)').fill('-42');
    await page.getByLabel('Minimum silence (s)').fill('0.35');
    await button('Detect silence', dlg()).click();
    await button('Remove silence', dlg()).click();
    document = await read();
    assert.ok(document.clips.length >= 1);
    assert.ok(Math.max(...document.clips.map((c) => c.start + c.duration)) < initial - 0.5);
    console.log('Verified synced compound and ripple silence removal.');
    await button('Captions', page.locator('#rail')).click();
    await page.getByRole('button', { name: /Generate captions Local ListenActive/ }).click();
    await page.getByLabel('Speech source').selectOption('all');
    await page.getByLabel('Speech language').selectOption('en');
    await button('Generate captions', dlg()).click();
    await page.locator('.ce-clip[data-kind=caption]').first().waitFor({ timeout: 600000 });
    const cap = (await read()).clips.find((c) => c.kind === 'caption');
    assert.ok(cap.cues.length && cap.cues.every((c) => c.start < c.end));
    assert.ok(cap.style.size > 0);
    await page.waitForFunction(() => !document.querySelector('[role=dialog]'));
    const files = await fs.readdir(output);
    const srt = files.find((f) => f.endsWith('.srt'));
    assert.ok(srt);
    assert.match(
      await fs.readFile(path.join(output, srt), 'utf8'),
      /-->[\s\S]+(video|studio|recording)/i,
    );
    console.log('Verified local speech to fitted timeline captions and SRT.');
    await application.evaluate(
      ({ dialog }, base) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: base });
      },
      path.join(output, 'captions.vtt'),
    );
    await page.getByRole('button', { name: /Export subtitles SRT/ }).click();
    await dlg().getByLabel('Format').selectOption('vtt');
    await button('Save file', dlg()).click();
    assert.match(await fs.readFile(path.join(output, 'captions.vtt'), 'utf8'), /^WEBVTT/);
    await button('Templates', page.locator('#rail')).click();
    await button('Create template').click();
    await dlg().getByLabel('Template name').fill('Speaker layout');
    await dlg().getByLabel('X %').fill('1.376');
    await dlg().getByLabel('Width %').fill('38');
    await dlg().getByLabel('Height %').fill('60');
    await button('Save template', dlg()).click();
    await button('Apply', page.locator('.template-card')).click();
    await dlg().locator('select').first().selectOption({ label: 'Ridgeline.mp4' });
    await button('Place on timeline', dlg()).click();
    const selection = page.getByRole('dialog', { name: 'Crop source' }).locator('.crop-selection');
    const frame = await selection.boundingBox();
    const cx = frame.x + frame.width / 2, cy = frame.y + frame.height / 2;
    const before = await page.locator('.crop-source').boundingBox();
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - frame.width / 8, cy, { steps: 5 });
    await page.mouse.up();
    const after = await page.locator('.crop-source').boundingBox();
    assert.ok(after.x < before.x - frame.width / 10);
    await button('Apply crop', dlg()).click();
    await page.waitForFunction(() => !document.querySelector('[role=dialog]'));
    assert.ok(
      (await read()).clips.some(
        (c) => c.kind === 'media' && Math.abs(c.box.w - 0.38) < 0.0001 && c.crop.w < 1 && c.crop.x > 0,
      ),
    );
    console.log('Verified template replacement and interactive crop.');
    await button('Audio', page.locator('#rail')).click();
    await choose([padded]);
    await button('Import files').click();
    await page.locator('.asset').first().waitFor();
    await create('Second project');
    await button('Audio', page.locator('#rail')).click();
    await page
      .locator('.asset')
      .first()
      .dblclick({ position: { x: 18, y: 12 } });
    assert.ok(
      Object.values((await read()).assets).some(
        (a) => a.category === 'audiofx' && a.name === 'voice-with-pauses.wav',
      ),
    );
    if (process.env.CUTTING_EDGE_TEST_CHAT === '1') {
      await button('ChatGPT', page.locator('#inspector-tabs')).click();
      await page
        .locator('.chat-compose textarea')
        .fill(
          'Add a new editable text clip with the exact text Assistant verified at 0.5 seconds for 2 seconds. Also synthesize a short bell named TestBell and insert it at the same time.',
        );
      await button('Send', page.locator('.chat-compose')).click();
      await page.waitForFunction(
        () => !document.querySelector('.chat-compose textarea')?.disabled,
        null,
        { timeout: 180000 },
      );
      document = await read();
      assert.ok(document.clips.some((c) => c.text === 'Assistant verified' && c.start === 0.5));
      assert.ok(
        Object.values(document.assets).some(
          (a) => a.kind === 'audio' && a.category === 'audiofx' && a.name !== 'voice-with-pauses.wav',
        ),
      );
      await page.locator('#top-actions [title="Undo (Ctrl+Z)"]').click();
      assert.equal((await read()).clips.length, 1);
      console.log('Verified signed-in ChatGPT commands, inserted synthesized audio and one-step undo.');
    }
    assert.deepEqual(fail, []);
    console.log('Verified reusable sound library in second project.');
  } catch (e) {
    console.error((await page.locator('body').innerText()).slice(-2900));
    console.error(fail);
    throw e;
  } finally {
    await application.close();
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
