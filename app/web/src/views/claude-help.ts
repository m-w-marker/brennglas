import { api } from '../api.ts';
import { copyText, h } from '../dom.ts';
import { t } from '../i18n.ts';

/** Block mit Kopieren-Knopf; der Knopf bestätigt kurz, statt still zu kopieren. */
function copyBlock(text: string): HTMLElement {
  const btn = h('button', { type: 'button', class: 'button ghost' }, t('claude.copy'));
  btn.addEventListener('click', () => void copyText(text).then((ok) => {
    btn.textContent = ok ? t('claude.copied') : t('claude.copy');
    setTimeout(() => { btn.textContent = t('claude.copy'); }, 1500);
  }));
  return h('div', { class: 'claude-block' }, h('pre', {}, text), btn);
}

/** Anleitung „Mit Claude verbinden“ mit dem fertigen MCP-Eintrag (echte Pfade dieses Rechners vom Backend). */
export function openClaudeHelp(): void {
  const body = h('div', {}, h('p', { class: 'lic-note' }, '…'));
  const close = h('button', { type: 'button', class: 'button ghost' }, t('claude.close'));
  const dlg = h('dialog', { class: 'lic-dialog claude-dialog' },
    h('h3', {}, t('claude.title')),
    h('p', {}, t('claude.intro')),
    h('ol', {}, h('li', {}, t('claude.step1')), h('li', {}, t('claude.step2')), h('li', {}, t('claude.step3'))),
    body,
    h('p', { class: 'lic-note' }, t('claude.connector')),
    h('div', { class: 'lic-actions' }, close));
  const done = () => { dlg.close(); dlg.remove(); };
  close.addEventListener('click', done);
  dlg.addEventListener('cancel', done);
  document.body.append(dlg);
  dlg.showModal();
  api.claudeConfig().then(({ node, script }) => {
    const json = JSON.stringify({ mcpServers: { brennglas: { command: node, args: [script] } } }, null, 2);
    body.replaceChildren(copyBlock(json), h('p', { class: 'lic-note' }, t('claude.code')),
      copyBlock(`claude mcp add brennglas -- "${node}" "${script}"`));
  }, (e: Error) => body.replaceChildren(h('p', { class: 'form-error' }, t('claude.fail', { msg: e.message }))));
}
