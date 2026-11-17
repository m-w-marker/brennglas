// Installer: ComfyUI, Custom Nodes, Abhängigkeiten, Modelle (→ docs/plan/plan_installer.md Phase 2 und 3).
// Start über install.bat in der Wurzel; jeder Lauf prüft den Stand und ergänzt nur, was fehlt.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, statfsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { catalog, download, filesToLoad, GatedError, isPresent, remoteSize, type CatalogFile, type CatalogModel } from './files.ts';
import { COMFY_ASSET, COMFY_MIN, COMFY_RELEASE, comfyVersion, FFMPEG_RELEASE, isPortableComfy, pickComfyAsset, pickFfmpegAsset, readEnv, versionAtLeast, writeEnv } from './setup.ts';
import { FFMPEG_DIR, toolPath } from '../tools.ts';
import type { Text } from '@brennglas/shared';

const en = (x: Text): string => (typeof x === 'string' ? x : x.en);

const APP = fileURLToPath(new URL('../../../', import.meta.url));
const ENV = join(APP, '.env');
const EXAMPLE = join(APP, '.env.example');
const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

// Zeilen-Warteschlange statt rl.question: so kommen auch umgeleitete Antworten an, und ein geschlossenes Fenster heißt „leer“.
const rl = createInterface({ input: process.stdin });
const lines: string[] = [];
const waiting: ((s: string) => void)[] = [];
let closed = false;
rl.on('line', (l) => { const w = waiting.shift(); if (w) w(l); else lines.push(l); });
rl.on('close', () => { closed = true; for (const w of waiting.splice(0)) w(''); });
function ask(q: string): Promise<string> {
  process.stdout.write(q);
  const next = lines.shift();
  if (next !== undefined) return Promise.resolve(next.trim());
  if (closed) return Promise.resolve('');
  return new Promise((r) => waiting.push((s) => r(s.trim())));
}
const yes = async (q: string) => (await ask(q)).toLowerCase().startsWith('y');

function openBrowser(url: string): void {
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
}

function progress(name: string) {
  let last = 0;
  return (done: number, total: number | null) => {
    if (Date.now() - last < 500) return;
    last = Date.now();
    const size = (n: number) => (total && total < 1024 ** 3 ? `${Math.round(n / 1024 ** 2)} MB` : gb(n));
    process.stdout.write(`\r  ${name}  ${size(done)}${total ? ` of ${size(total)}` : ''}   `);
  };
}

const freeBytes = (dir: string) => { const s = statfsSync(dir); return s.bavail * s.bsize; };

// Windows bringt tar mit, es entpackt auch 7z und zip.
const TAR = (() => { const root = process.env.SystemRoot ?? process.env.windir; return root ? join(root, 'System32', 'tar.exe') : 'tar.exe'; })();

// --- 1. ComfyUI ---
async function installComfy(parent: string): Promise<void> {
  const res = await fetch(COMFY_RELEASE, { headers: { 'User-Agent': 'brennglas-installer' } });
  const asset = pickComfyAsset(res.ok ? await res.json() : null);
  if (!asset) throw new Error('Could not find the ComfyUI download on GitHub. Try again later.');
  // Archiv und entpackter Ordner liegen kurz nebeneinander.
  if (freeBytes(parent) < asset.size * 4) throw new Error(`Not enough space in ${parent}: about ${gb(asset.size * 4)} needed.`);
  const archive = join(parent, COMFY_ASSET);
  console.log(`Downloading ComfyUI ${asset.version} (${gb(asset.size)}) to ${parent}`);
  await download(asset.url, archive, undefined, progress(COMFY_ASSET));
  console.log('\nUnpacking ComfyUI ...');
  const r = spawnSync(TAR, ['-xf', archive, '-C', parent], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`Unpacking failed. Unpack ${archive} with 7-Zip into ${parent}, then run install.bat again.`);
  rmSync(archive, { force: true });
}

async function ensureComfy(): Promise<string> {
  let dir = process.env.COMFY_DIR ?? readEnv(ENV, 'COMFY_DIR');
  if (!dir || !isPortableComfy(dir)) {
    if (dir) console.log(`No portable ComfyUI found in ${dir}.`);
    const fallback = resolve(APP, '..', '..', 'ComfyUI_windows_portable');
    console.log('Brennglas needs ComfyUI, the portable build for NVIDIA cards.');
    for (;;) {
      const a = (await ask(`Path of your portable ComfyUI, or Enter to download it to\n  ${fallback}\n> `)).replace(/^"|"$/g, '');
      dir = a ? resolve(a) : fallback;
      if (!a && !isPortableComfy(dir)) await installComfy(dirname(dir));
      if (isPortableComfy(dir)) break;
      console.log(`No portable ComfyUI in ${dir} (it needs python_embeded and ComfyUI\\main.py).`);
      if (closed) throw new Error('No ComfyUI selected.');
    }
    writeEnv(ENV, EXAMPLE, 'COMFY_DIR', dir);
  }
  const v = comfyVersion(dir);
  if (v && versionAtLeast(v, COMFY_MIN)) {
    console.log(`ComfyUI ${v} in ${dir}`);
    return dir;
  }
  console.log(`ComfyUI ${v ?? '(unknown version)'} is older than ${COMFY_MIN}, the version Brennglas is tested with.`);
  if (await yes('Update ComfyUI now? Close ComfyUI first. (y/n) ')) {
    spawnSync('cmd', ['/c', 'update_comfyui_stable.bat', 'nopause'], { cwd: join(dir, 'update'), stdio: 'inherit' });
    console.log(`ComfyUI is now ${comfyVersion(dir) ?? 'unknown'}.`);
  }
  return dir;
}

// --- 2. Custom Nodes, nur für das Hochskalieren von Render-Sequenzen ---
const NODES = [
  { name: 'ComfyUI-VideoHelperSuite', url: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite' },
  { name: 'was-node-suite-comfyui', url: 'https://github.com/WASasquatch/was-node-suite-comfyui' },
];

async function ensureNodes(comfy: string): Promise<void> {
  const dir = join(comfy, 'ComfyUI', 'custom_nodes');
  const missing = NODES.filter((n) => !existsSync(join(dir, n.name)));
  if (!missing.length) return;
  if (!(await yes(`\nUpscaling render sequences needs two custom nodes (${missing.map((n) => n.name).join(', ')}). Install them? (y/n) `))) return;
  for (const n of missing) {
    if (spawnSync('git', ['clone', '--depth', '1', n.url, join(dir, n.name)], { stdio: 'inherit' }).status !== 0) {
      console.log(`Could not clone ${n.name}. Git is needed for this step: https://git-scm.com/`);
      continue;
    }
    const req = join(dir, n.name, 'requirements.txt');
    if (existsSync(req)) spawnSync(join(comfy, 'python_embeded', 'python.exe'), ['-s', '-m', 'pip', 'install', '-r', req], { stdio: 'inherit' });
  }
}

// --- 3. ffmpeg: Schnitt, Videodateien als Quelle, MP4 aus Sequenzen; portabel nach app/runtime/ffmpeg ---
async function ensureFfmpeg(): Promise<void> {
  if (toolPath('ffmpeg') !== 'ffmpeg' || spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) return;
  if (!(await yes('\nCutting videos and upscaling video files need ffmpeg (about 90 MB). Install it? (y/n) '))) return;
  const res = await fetch(FFMPEG_RELEASE, { headers: { 'User-Agent': 'brennglas-installer' } });
  const asset = pickFfmpegAsset(res.ok ? await res.json() : null);
  if (!asset) return void console.log('Could not find the ffmpeg download on GitHub. Run install.bat again later.');
  const runtime = dirname(FFMPEG_DIR);
  const zip = join(runtime, asset.name);
  // Der Build unter diesem Namen wird täglich neu gebaut: eine halbe Datei von gestern nicht fortsetzen
  rmSync(`${zip}.part`, { force: true });
  await download(asset.url, zip, undefined, progress(asset.name));
  const tmp = join(runtime, 'ffmpeg-tmp');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  if (spawnSync(TAR, ['-xf', zip, '-C', tmp], { stdio: 'inherit' }).status !== 0) {
    rmSync(zip, { force: true });
    throw new Error('unpacking failed');
  }
  rmSync(FFMPEG_DIR, { recursive: true, force: true });
  renameSync(join(tmp, asset.name.replace(/\.zip$/, '')), FFMPEG_DIR);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(zip, { force: true });
  console.log(`\nffmpeg ${asset.version} in ${FFMPEG_DIR} (GPL, license in LICENSE.txt there)`);
}

// --- 4. Abhängigkeiten von Brennglas; corepack holt pnpm selbst, nichts wird global installiert ---
function ensureDeps(): void {
  const marker = join(APP, 'node_modules', '.modules.yaml');
  if (existsSync(marker) && statSync(marker).mtimeMs >= statSync(join(APP, 'pnpm-lock.yaml')).mtimeMs) return;
  console.log('\nInstalling Brennglas ...');
  const r = spawnSync('corepack pnpm install --frozen-lockfile', { cwd: APP, stdio: 'inherit', shell: true,
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' } });
  if (r.status !== 0) throw new Error('Installing Brennglas failed, see the messages above.');
}

// --- 5. Modelle ---
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
  const token = await ask('Paste the token here (Enter to skip this model): ');
  if (token) writeEnv(ENV, EXAMPLE, 'HF_TOKEN', token);
  return token || undefined;
}

async function models(comfy: string): Promise<void> {
  const modelsDir = join(comfy, 'ComfyUI', 'models');
  let token = readEnv(ENV, 'HF_TOKEN');
  const all = catalog(APP);

  // Größen nur für fehlende Dateien, parallel; gesperrte ohne Token bleiben unbekannt.
  const missing = [...new Map(all.flatMap((m) => m.files).filter((f) => f.url && !isPresent(modelsDir, f)).map((f) => [f.key, f])).values()];
  const sizes = new Map(await Promise.all(missing.map(async (f) => [f.key, await remoteSize(f.url as string, token)] as const)));
  const need = (m: CatalogModel) => filesToLoad(modelsDir, [m]).reduce((s, f) => s + (sizes.get(f.key) ?? 0), 0);

  console.log('\nModels');
  all.forEach((m, i) => {
    const st = status(modelsDir, m);
    const open = filesToLoad(modelsDir, [m]).filter((f) => sizes.get(f.key) == null);
    const extra = open.some((f) => f.gated) ? ' + gated files (login)' : open.length ? ' + files of unknown size' : '';
    const size = st === 'installed' ? '' : `${gb(need(m)).padStart(9)} to download${extra}`;
    console.log(`${st === 'installed' ? '[x]' : '[ ]'} ${String(i + 1).padStart(2)}  ${en(m.spec.name).padEnd(26)} ${st.padEnd(10)}`
      + `commercial: ${m.spec.license.commercial.padEnd(8)}${size}`);
  });

  const answer = (await ask('\nModels to install (numbers like 2,5 or "all", Enter to skip): ')).toLowerCase();
  if (!answer) return;
  const picked = answer === 'all' ? all : answer.split(/[ ,]+/).map((n) => all[Number(n) - 1]).filter((m): m is CatalogModel => !!m);
  const chosen: CatalogModel[] = [];
  for (const m of picked.filter((x) => status(modelsDir, x) !== 'installed')) {
    const summary = typeof m.spec.license.summary === 'string' ? m.spec.license.summary : m.spec.license.summary.en;
    console.log(`\n${en(m.spec.name)}: ${m.spec.license.name}\n  ${m.spec.license.url}\n  ${summary}`);
    if (await yes('Accept this license? (y/n) ')) chosen.push(m);
  }
  const todo = filesToLoad(modelsDir, chosen);
  if (!todo.length) return void console.log('\nNothing to download.');

  const known = todo.reduce((s, f) => s + (sizes.get(f.key) ?? 0), 0);
  if (known > freeBytes(modelsDir)) return void console.log(`\nNot enough space: ${gb(known)} needed, ${gb(freeBytes(modelsDir))} free on the ComfyUI drive.`);
  console.log(`\n${todo.length} files, ${gb(known)}${todo.some((f) => sizes.get(f.key) == null) ? ' plus gated files' : ''}. Interrupted downloads continue on the next run.`);

  const skipped = new Set<string>();
  for (const f of todo) {
    if (!f.url) { console.log(`No download link for ${f.key}, skipped.`); continue; }
    const repo = f.url.split('/').slice(0, 5).join('/');
    if (skipped.has(repo)) continue;
    for (;;) {
      try {
        await download(f.url, join(modelsDir, f.folder, f.name), token, progress(f.name));
        process.stdout.write(`\r  ${f.name}  done${' '.repeat(30)}\n`);
        break;
      } catch (e) {
        if (!(e instanceof GatedError)) { console.log(`\n  ${f.name} failed: ${(e as Error).message}. Run install.bat again to continue.`); break; }
        token = await askToken(f);
        if (!token) { skipped.add(repo); console.log('  Skipped.'); break; }
      }
    }
  }
}

// Fertiger Block mit den echten Pfaden; process.execPath ist das Node, das gerade läuft (auch das portable).
function claudeDesktopConfig(): void {
  const block = { mcpServers: { brennglas: { command: process.execPath, args: [join(APP, 'mcp', 'src', 'index.ts')] } } };
  console.log('\nTo use Brennglas in the Claude Desktop app: Settings, Developer, Edit Config, paste this block');
  console.log('(if other servers are already listed, add only the "brennglas" entry), then quit Claude Desktop');
  console.log('completely (also from the tray icon) and start it again:\n');
  console.log(JSON.stringify(block, null, 2));
}

try {
  console.log('Brennglas installer. Run it again any time: it only adds what is missing.\n');
  const comfy = await ensureComfy();
  await ensureNodes(comfy);
  // Optional: ohne Netz oder bei gesperrter Datei geht es ohne ffmpeg weiter, statt den ganzen Lauf abzubrechen
  await ensureFfmpeg().catch((e: Error) => console.log(`\nffmpeg could not be installed (${e.message}). Run install.bat again later.`));
  ensureDeps();
  await models(comfy);
  claudeDesktopConfig();
  console.log('\nDone. Start Brennglas with start.bat.');
} catch (e) {
  console.log(`\n${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  rl.close();
}
