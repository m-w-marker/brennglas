import type { ModelInfo } from '@brennglas/shared';
import { h } from '../dom.ts';
import { t, tx } from '../i18n.ts';

const KEY = 'brennglas.license.';

const COMMERCIAL = { yes: 'lic.yes', limited: 'lic.limited', no: 'lic.no' } as const;

export function commercialLabel(m: ModelInfo): string {
  return t(COMMERCIAL[m.license.commercial]);
}

/** Bestätigung gilt für genau diese Lizenz; ändert sich der Name, wird neu gefragt. */
function acknowledged(m: ModelInfo): boolean {
  try {
    return localStorage.getItem(KEY + m.id) === m.license.name;
  } catch {
    return false;
  }
}

/** Zeigt die Lizenz vor der ersten Nutzung eines Modells; true = bestätigt. */
export function ensureLicense(m: ModelInfo): Promise<boolean> {
  if (acknowledged(m)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const ok = h('button', { type: 'button', class: 'primary' }, t('lic.accept'));
    const cancel = h('button', { type: 'button', class: 'button ghost' }, t('lic.cancel'));
    const dlg = h('dialog', { class: 'lic-dialog' },
      h('h3', {}, t('lic.title', { name: tx(m.name) ?? m.id })),
      h('p', { class: 'lic-name' }, `${m.license.name} · ${commercialLabel(m)}`),
      h('p', {}, tx(m.license.summary) ?? ''),
      h('p', { class: 'lic-note' }, t('lic.note')),
      h('a', { href: m.license.url, target: '_blank', rel: 'noopener noreferrer' }, t('lic.details')),
      h('div', { class: 'lic-actions' }, cancel, ok));
    let settled = false;
    const done = (yes: boolean) => {
      if (settled) return;
      settled = true;
      if (yes) {
        try {
          localStorage.setItem(KEY + m.id, m.license.name);
        } catch {
          // ohne Speicher wird beim nächsten Mal erneut gefragt
        }
      }
      dlg.close();
      dlg.remove();
      resolve(yes);
    };
    ok.addEventListener('click', () => done(true));
    cancel.addEventListener('click', () => done(false));
    dlg.addEventListener('cancel', () => done(false));
    document.body.append(dlg);
    dlg.showModal();
  });
}
