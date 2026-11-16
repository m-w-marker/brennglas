import type { Generation, SseEvent } from '@brennglas/shared';
import { api } from '../api.ts';
import { h } from '../dom.ts';
import { t } from '../i18n.ts';

export interface QueuePanel {
  el: HTMLElement;
  setCount(n: number): void;
  onEvent(ev: SseEvent): void;
}

/** Zähler in der Kopfzeile; ein Klick klappt die offenen Jobs auf – vorholen, entfernen, ansehen. */
export function queuePanel(badge: (workflow: string) => string, onShow: (g: Generation) => void): QueuePanel {
  const counter = h('button', { type: 'button', class: 'queue', title: t('queue.title') });
  const list = h('div', { class: 'queue-list hidden' });
  const el = h('div', { class: 'queue-wrap' }, counter, list);
  let open = false;

  function setCount(n: number) {
    counter.textContent = n > 0 ? t('queue.n', { n }) : t('queue.empty');
    counter.classList.toggle('busy', n > 0);
  }

  function act(btn: HTMLButtonElement, run: () => Promise<unknown>) {
    btn.disabled = true;
    run().catch((e: Error) => { btn.title = e.message; btn.classList.add('err'); }).finally(() => void refresh());
  }

  async function refresh() {
    if (!open) return;
    const items = await api.queue().catch(() => null);
    if (!open) return;
    if (!items) return void list.replaceChildren(h('p', { class: 'queue-empty' }, t('queue.fail')));
    if (items.length === 0) return void list.replaceChildren(h('p', { class: 'queue-empty' }, t('queue.none')));
    list.replaceChildren(...items.map(({ generation: g, state, canFront }) => {
      const front = h('button', { type: 'button', class: 'q-btn', title: t('queue.front') }, '↑');
      front.addEventListener('click', (e) => { e.stopPropagation(); act(front, () => api.toFront(g.id)); });
      const remove = h('button', { type: 'button', class: 'q-btn danger', title: t('queue.remove') }, '✕');
      remove.addEventListener('click', (e) => { e.stopPropagation(); act(remove, () => api.cancel(g.id)); });
      return h('div', { class: `q-item ${state}`, onclick: () => { toggle(false); onShow(g); } },
        h('span', { class: 'q-state' }, t(state === 'running' ? 'queue.running' : 'queue.waiting')),
        h('span', { class: 'q-model' }, badge(g.workflow)),
        h('span', { class: 'q-prompt', title: g.prompt }, g.prompt || '—'),
        canFront ? front : null, remove);
    }));
  }

  function toggle(on = !open) {
    open = on;
    list.classList.toggle('hidden', !on);
    if (on) {
      list.replaceChildren(h('p', { class: 'queue-empty' }, '…'));
      void refresh();
    }
  }

  counter.addEventListener('click', () => toggle());
  document.addEventListener('click', (e) => { if (open && !el.contains(e.target as Node)) toggle(false); });

  return {
    el,
    setCount,
    onEvent(ev) {
      if (open && (ev.type === 'queue' || ev.type === 'status' || ev.type === 'done' || ev.type === 'error')) void refresh();
    },
  };
}
