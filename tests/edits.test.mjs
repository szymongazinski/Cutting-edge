import test from 'node:test';
import assert from 'node:assert/strict';
import * as layout from '../ui/layout.mjs';
test('editing one half of a split subtitle clip preserves its trim and later hidden cues', () => {
  const clip = {
    in: 2,
    duration: 3,
    cues: [
      { start: 0, end: 4, text: 'alpha' },
      { start: 4, end: 8, text: 'beta' },
    ],
  };
  const local = layout.visibleCues(clip);
  assert.deepEqual(local, [
    { start: 0, end: 2, text: 'alpha' },
    { start: 2, end: 3, text: 'beta' },
  ]);
  const saved = layout.replaceVisibleCues(clip, [
    { start: 0, end: 2, text: 'edited' },
    { start: 2, end: 3, text: 'beta' },
  ]);
  assert.equal(saved.duration, 3);
  assert.deepEqual(
    saved.cues.map((c) => [c.start, c.end]),
    [
      [0, 2],
      [2, 4],
      [4, 5],
      [5, 8],
    ],
  );
});
test('a failed earlier autosave cannot overwrite a later successful edit on closing', async () => {
  const { state, scheduleSave, flush } = await import('../ui/session.mjs');
  state.doc = { path: 'doc', project: { name: 'old' } };
  state.settings = { language: 'en' };
  state.revision = 1;
  let failFirst, startFirst;
  const started = new Promise((r) => (startFirst = r)),
    writes = [];
  globalThis.window = {
    cutting: {
      call: async (_, { project }) => {
        writes.push(project.name);
        if (project.name === 'old' && writes.length === 1) {
          startFirst();
          await new Promise((_, reject) => {
            failFirst = reject;
          });
        }
      },
    },
  };
  scheduleSave();
  const initial = flush().catch(() => {});
  await started;
  state.revision++;
  state.doc.project.name = 'new';
  scheduleSave();
  const current = flush();
  failFirst(new Error('transient file lock'));
  await Promise.all([initial, current]);
  await flush();
  assert.deepEqual(writes, ['old', 'new']);
  delete globalThis.window;
});
test('several assistant cuts using the original ID reach all requested timeline positions', async () => {
  const { state, flush } = await import('../ui/session.mjs');
  const { applyActions } = await import('../ui/chat.mjs');
  state.doc = {
    path: 'batch',
    project: {
      id: 'batch',
      name: 'Sample',
      fps: 30,
      assets: {},
      clips: [{ kind: 'text', id: 'a', name: 'Title', start: 0, in: 0, duration: 10, track: 0 }],
    },
  };
  state.nested = [];
  state.selection = [];
  state.revision = 1;
  state.settings = { language: 'en' };
  globalThis.window = { cutting: { call: async () => {} } };
  applyActions([
    { type: 'split', id: 'a', time: 3 },
    { type: 'split', id: 'a', time: 6 },
  ]);
  await flush();
  assert.deepEqual(
    state.doc.project.clips.map((c) => [c.start, c.duration]),
    [
      [0, 3],
      [3, 3],
      [6, 4],
    ],
  );
  delete globalThis.window;
});
