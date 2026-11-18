import { el, icon, btn, group, api, run, by } from './dom.mjs';
import { state, t, project, rootProject, commit, selectIds, redraw, textClip } from './session.mjs';
import { stylePreset } from './layout.mjs';
import { fullBox, makeClip, splitClip, makeCompound } from './model.mjs';
const whitelisted = new Set([
  'name',
  'start',
  'in',
  'duration',
  'track',
  'box',
  'crop',
  'volume',
  'muted',
  'text',
  'style',
]);
const clamp = (v, a, b) => Math.min(b, Math.max(a, Number(v)));
function bounded(c, p) {
  c.start = clamp(c.start, 0, 86400);
  c.in = clamp(c.in, 0, 86400);
  c.volume = clamp(c.volume, 0, 8);
  c.track = Math.round(clamp(c.track, 0, 200));
  c.duration = clamp(c.duration, 1 / p.fps, 86400);
  for (const k of ['box', 'crop']) {
    const b = c[k] || fullBox();
    if (!Object.values(b).every(Number.isFinite))
      throw Error(t('Błędne wymiary ramki.', 'Invalid bounds.'));
    const w = clamp(b.w, 0.001, 1),
      h = clamp(b.h, 0.001, 1);
    c[k] = { x: clamp(b.x, 0, 1 - w), y: clamp(b.y, 0, 1 - h), w, h };
  }
  if (c.kind === 'media') {
    const a = p.assets[c.assetId];
    if (a.kind !== 'image' && !(a.kind === 'video' && ['visualfx', 'sticker'].includes(a.category))) {
      c.in = Math.min(c.in, Math.max(0, a.duration - 1 / p.fps));
      c.duration = Math.min(c.duration, a.duration - c.in);
    }
  }
}
export function applyActions(actions) {
  const ids = [],
    pieces = new Map();
  commit((p) => {
    for (const action of actions) {
      const c = p.clips.find((o) => o.id === action.id);
      switch (action.type) {
        case 'update':
          if (!c) throw Error(t('Klip został usunięty.', 'The clip has been removed.'));
          for (const [k, v] of Object.entries(action.patch || {}))
            if (whitelisted.has(k)) {
              c[k] = ['box', 'crop', 'style'].includes(k) ? { ...c[k], ...v } : v;
            }
          bounded(c, p);
          ids.push(c.id);
          break;
        case 'remove':
          p.clips = p.clips.filter((o) => o.id !== action.id);
          break;
        case 'split': {
          const family = pieces.get(action.id) || [action.id];
          const piece = p.clips.find(
            (clip) =>
              family.includes(clip.id) &&
              clip.start < action.time &&
              clip.start + clip.duration > action.time,
          );
          const right = piece && splitClip(p, piece.id, action.time);
          if (!right)
            throw Error(t('Punkt podziału jest poza klipem.', 'Split point is outside the clip.'));
          pieces.set(action.id, [...family, right.id]);
          ids.push(right.id);
          break;
        }
        case 'compound': {
          const group = makeCompound(p, action.ids);
          if (group) ids.push(group.id);
          break;
        }
        case 'insertAsset': {
          const a = action.asset;
          if (!a) throw Error('Missing assistant asset');
          p.assets[a.id] = a;
          const n = makeClip(p, a, action.start || 0, action.track || 0);
          if (a.category === 'sticker') {
            const scale = 0.24 / Math.max(n.box.w, n.box.h);
            n.box = { x: 0.68, y: 0.07, w: n.box.w * scale, h: n.box.h * scale };
          }
          p.clips.push(n);
          ids.push(n.id);
          break;
        }
        case 'addText': {
          const n = textClip(
            'text',
            action.text,
            action.box || { x: 0.1, y: 0.65, w: 0.8, h: 0.2 },
            { ...stylePreset('classic', p.height), ...action.style },
            action.duration || 3,
            action.start || 0,
            action.track,
          );
          bounded(n, p);
          p.clips.push(n);
          ids.push(n.id);
          break;
        }
        default:
          throw Error(t('Nieznana operacja asystenta.', 'Unknown assistant operation.'));
      }
    }
  });
  if (ids.length) selectIds(ids);
}
function chatState() {
  const id = state.doc.path;
  if (!state.chat.has(id)) state.chat.set(id, { messages: [], busy: false, status: '', draft: '' });
  return state.chat.get(id);
}
export function chatEvent(value) {
  const c = chatState();
  if (c.busy) {
    c.status = typeof value === 'string' ? value : value?.message || '';
    const status = by('chat-status');
    if (status) status.textContent = c.status;
  }
}
export function renderChat(host) {
  const ctx = chatState(),
    log = el('div', { class: 'chat-log' });
  host.className = 'chat';
  if (!ctx.messages.length) {
    const intro = el(
      'div',
      { class: 'chat-intro' },
      icon('bot'),
      el('strong', {}, t('Asystent montażu', 'Editing assistant')),
      el(
        'p',
        {},
        t(
          'ChatGPT widzi układ bieżącego projektu. Zmiany na osi możesz cofnąć skrótem Ctrl+Z.',
          'ChatGPT can edit your current project. Undo timeline changes with Ctrl+Z.',
        ),
      ),
    );
    for (const sample of [
      t('Wstaw tytuł na początku filmu.', 'Add a title at the beginning.'),
      t('Wygeneruj naklejkę z migającą gwiazdą.', 'Generate a blinking star sticker.'),
    ])
      intro.append(
        btn(
          'arrow-up-right',
          sample,
          () => {
            draft.value = sample;
            draft.focus();
          },
          'helper-action',
        ),
      );
    log.append(intro);
  }
  for (const m of ctx.messages) log.append(el('div', { class: 'chat-msg ' + m.role }, m.content));
  const draft = el('textarea', {
    placeholder: t('Napisz do ChatGPT…', 'Message ChatGPT…'),
    value: ctx.draft,
    disabled: ctx.busy,
  });
  draft.oninput = () => {
    ctx.draft = draft.value;
  };
  const status = el(
    'small',
    { id: 'chat-status', class: 'hint' },
    ctx.busy ? ctx.status : t('Konto ChatGPT · Codex CLI', 'ChatGPT account · Codex CLI'),
  );
  const send = btn(
    'send',
    t('Wyślij', 'Send'),
    run(async () => {
      const message = draft.value.trim();
      if (!message || ctx.busy) return;
      const id = rootProject().id,
        nest = JSON.stringify(state.nested),
        rev = state.revision;
      const history = ctx.messages.slice(-16);
      ctx.messages.push({ role: 'user', content: message });
      ctx.draft = '';
      ctx.busy = true;
      ctx.status = t('ChatGPT pracuje…', 'ChatGPT is working…');
      redraw();
      try {
        const r = await api('assistant', {
          project: project(),
          message,
          history,
          selection: state.selection,
        });
        if (
          r.actions?.length &&
          (id !== rootProject().id || rev !== state.revision || nest !== JSON.stringify(state.nested))
        ) {
          ctx.messages.push({
            role: 'assistant',
            content: t(
              'Projekt zmienił się podczas odpowiedzi. Wyślij polecenie ponownie dla aktualnej osi.',
              'The project changed while I was working. Send the request again for the current timeline.',
            ),
          });
        } else {
          if (r.actions?.length) applyActions(r.actions);
          ctx.messages.push({ role: 'assistant', content: r.reply || t('Gotowe.', 'Done.') });
        }
        state.library = {};
        await state.commands.reloadLibrary?.();
      } catch (e) {
        ctx.messages.push({ role: 'assistant', content: e.message });
      } finally {
        ctx.busy = false;
        ctx.status = '';
        redraw();
      }
    }),
    'primary',
  );
  send.disabled = ctx.busy;
  draft.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send.click();
    }
  };
  host.replaceChildren(
    log,
    el('div', { class: 'chat-compose' }, draft, group(status, el('span', { class: 'flex' }), send)),
  );
  requestAnimationFrame(() => {
    log.scrollTop = log.scrollHeight;
  });
}
