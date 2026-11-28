type Attrs = Record<string, string | boolean | number | EventListener | undefined>;
const ENUMERATED = new Set(['draggable', 'contenteditable', 'spellcheck']);

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = String(v);
    // draggable/contenteditable/spellcheck kennen nur "true", leer gilt dort als ungültig (Ziehen ging nicht)
    else el.setAttribute(k, v === true ? (ENUMERATED.has(k) ? 'true' : '') : String(v));
  }
  for (const c of children) if (c) el.append(c);
  if (el instanceof HTMLInputElement && el.type === 'range') fillRange(el);
  return el;
}

/** Grüne Spur bis zum Knopf: Chrome kann das nicht per CSS, darum --fill; nach einem Setzen von value ohne input-Ereignis selbst aufrufen. */
export function fillRange(el: HTMLInputElement): void {
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  el.style.setProperty('--fill', `${max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0}%`);
}
// Läuft nach den Handlern am Regler selbst, sieht also auch einen dort begrenzten Wert
document.addEventListener('input', (e) => { if (e.target instanceof HTMLInputElement && e.target.type === 'range') fillRange(e.target); });

/** Clipboard-API gibt es nur in sicheren Kontexten (https oder localhost); sonst der alte Weg. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { readonly: true, style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
