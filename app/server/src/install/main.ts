// Modell-Installer: Auswahl, Lizenz, Platzprüfung, Downloads mit Fortsetzen (→ docs/plan/plan_installer.md Phase 2).
// Start über install.bat in der Wurzel; ein zweiter Lauf zeigt den Stand und lädt nur, was fehlt.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { catalog, download, filesToLoad, GatedError, isPresent, remoteSize, type CatalogFile, type CatalogModel } from './files.ts';

const APP = fileURLToPath(new URL('../../../', import.meta.url));
const ENV = join(APP, '.env');
const rl = createInterface({ input: process.stdin, output: process.stdout });
let closed = false;
rl.on('close', () => { closed = true; });
// Endet die Eingabe (Fenster zu, umgeleitete Eingabe), gilt jede weitere Frage als leer beantwortet.
const ask = async (q: string): Promise<string> => (closed ? '' : rl.question(q).catch(() => ''));
const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

function readEnv(key: string): string | undefined {
  if (!existsSync(ENV)) return undefined;
  const line = readFileSync(ENV, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim() || undefined;
}

function writeEnv(key: string, value: string): void {
  if (!existsSync(ENV)) copyFileSync(join(APP, '.env.example'), ENV);
  const lines = readFileSync(ENV, 'utf8').split(/\r?\n/);
  // Auch die auskommentierte Vorlage „# KEY=…“ ersetzen, statt eine zweite Zeile anzuhängen.
  const i = lines.findIndex((l) => l.startsWith(`${key}=`) || l.startsWith(`# ${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(ENV, lines.join('\n'));
}

function openBrowser(url: string): void {
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
}

async function comfyModelsDir(): Promise<string> {
  let dir = process.env.COMFY_DIR ?? readEnv('COMFY_DIR');
  while (!dir || !existsSync(join(dir, 'ComfyUI', 'models'))) {
    if (dir) console.log(`No ComfyUI\\models folder in ${dir}.`);
    dir = resolve((await ask('Path of your portable ComfyUI folder (the one with python_embeded): ')).trim().replace(/^"|"$/g, ''));
    if (existsSync(join(dir, 'ComfyUI', 'models'))) writeEnv('COMFY_DIR', dir);
  }
  return join(dir, 'ComfyUI', 'models');
}

function status(modelsDir: string, m: CatalogModel): 'installed' | 'partial' | 'missing' {
  const have = m.files.filter((f) => isPresent(modelsDir, f)).length;
  return have === m.files.length ? 'installed' : have ? 'partial' : 'missing';
}

async function askToken(f: CatalogFile): Promise<string | undefined> {
  const page = (f.url ?? '').split('/').slice(0, 5).join('/');
  console.log(`\n${f.name} comes from a gated Hugging Face repo.`);
  console.log(`1. Log in at huggingface.co, open ${page} and accept the license.`);
  console.log('2. Create a token with read access at https://huggingface.co/settings/tokens');
  openBrowser(page);
  const token = (await ask('Paste the token here (Enter to skip this model): ')).trim();
  if (token) writeEnv('HF_TOKEN', token);
  return token || undefined;
}

async function main(): Promise<void> {
  console.log('Brennglas model installer\n');
  const modelsDir = await comfyModelsDir();
  let token = readEnv('HF_TOKEN');
  const models = catalog(APP);

  // Größen nur für fehlende Dateien, parallel; gesperrte ohne Token bleiben unbekannt.
  const missing = [...new Map(models.flatMap((m) => m.files).filter((f) => f.url && !isPresent(modelsDir, f)).map((f) => [f.key, f])).values()];
  const sizes = new Map(await Promise.all(missing.map(async (f) => [f.key, await remoteSize(f.url as string, token)] as const)));
  const need = (m: CatalogModel) => filesToLoad(modelsDir, [m]).reduce((s, f) => s + (sizes.get(f.key) ?? 0), 0);

  models.forEach((m, i) => {
    const st = status(modelsDir, m);
    const open = filesToLoad(modelsDir, [m]).filter((f) => sizes.get(f.key) == null);
    const extra = open.some((f) => f.gated) ? ' + gated files (login)' : open.length ? ' + files of unknown size' : '';
    const size = st === 'installed' ? '' : `${gb(need(m)).padStart(9)} to download${extra}`;
    console.log(`${st === 'installed' ? '[x]' : '[ ]'} ${String(i + 1).padStart(2)}  ${m.spec.name.padEnd(26)} ${st.padEnd(10)}`
      + `commercial: ${m.spec.license.commercial.padEnd(8)}${size}`);
  });

  const answer = (await ask('\nModels to install (numbers like 2,5 or "all", Enter to quit): ')).trim().toLowerCase();
  if (!answer) return;
  const picked = answer === 'all' ? models : answer.split(/[ ,]+/).map((n) => models[Number(n) - 1]).filter((m): m is CatalogModel => !!m);
  const chosen: CatalogModel[] = [];
  for (const m of picked.filter((x) => status(modelsDir, x) !== 'installed')) {
    console.log(`\n${m.spec.name}: ${m.spec.license.name}\n  ${m.spec.license.url}\n  ${typeof m.spec.license.summary === 'string' ? m.spec.license.summary : m.spec.license.summary.en}`);
    if ((await ask('Accept this license? (y/n) ')).trim().toLowerCase().startsWith('y')) chosen.push(m);
  }
  const todo = filesToLoad(modelsDir, chosen);
  if (!todo.length) return void console.log('\nNothing to download.');

  const known = todo.reduce((s, f) => s + (sizes.get(f.key) ?? 0), 0);
  const free = (() => { const s = statfsSync(modelsDir); return s.bavail * s.bsize; })();
  if (known > free) return void console.log(`\nNot enough space: ${gb(known)} needed, ${gb(free)} free on the ComfyUI drive.`);
  console.log(`\n${todo.length} files, ${gb(known)}${todo.some((f) => sizes.get(f.key) == null) ? ' plus gated files' : ''}. Interrupted downloads continue on the next run.`);

  const skipped = new Set<string>();
  for (const f of todo) {
    if (!f.url) { console.log(`No download link for ${f.key}, skipped.`); continue; }
    if (f.gated && !token && skipped.has(f.url.split('/').slice(0, 5).join('/'))) continue;
    let last = 0;
    const show = (done: number, total: number | null) => {
      if (Date.now() - last < 500) return;
      last = Date.now();
      process.stdout.write(`\r  ${f.name}  ${gb(done)}${total ? ` of ${gb(total)}` : ''}   `);
    };
    for (;;) {
      try {
        await download(f.url, join(modelsDir, f.folder, f.name), token, show);
        process.stdout.write(`\r  ${f.name}  done${' '.repeat(30)}\n`);
        break;
      } catch (e) {
        if (!(e instanceof GatedError)) { console.log(`\n  ${f.name} failed: ${(e as Error).message}. Run install.bat again to continue.`); break; }
        token = await askToken(f);
        if (!token) { skipped.add(f.url.split('/').slice(0, 5).join('/')); console.log('  Skipped.'); break; }
      }
    }
  }
  console.log('\nDone. Start Brennglas with start.bat. Run install.bat again any time to add models.');
}

try {
  await main();
} finally {
  rl.close();
}
