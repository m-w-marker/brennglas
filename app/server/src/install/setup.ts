import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Mit dieser ComfyUI-Version sind die Workflows getestet; ältere bekommen ein Update angeboten. */
export const COMFY_MIN = '0.45.0';
export const COMFY_RELEASE = 'https://api.github.com/repos/comfyanonymous/ComfyUI/releases/latest';
export const COMFY_ASSET = 'ComfyUI_windows_portable_nvidia.7z';

export function readEnv(file: string, key: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim() || undefined;
}

/** Setzt einen Schlüssel; alle anderen Zeilen bleiben, auch Kommentare. Fehlt .env, entsteht sie aus der Vorlage. */
export function writeEnv(file: string, example: string, key: string, value: string): void {
  if (!existsSync(file)) {
    if (existsSync(example)) copyFileSync(example, file);
    else writeFileSync(file, '');
  }
  const text = readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  // Auch die auskommentierte Vorlage „# KEY=…“ ersetzen, statt eine zweite Zeile anzuhängen.
  const i = lines.findIndex((l) => l.startsWith(`${key}=`) || l.startsWith(`# ${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else if (lines.at(-1) === '') lines.splice(-1, 0, `${key}=${value}`);
  else lines.push(`${key}=${value}`);
  writeFileSync(file, lines.join(eol));
}

/** Version einer ComfyUI-Installation aus comfyui_version.py; null, wenn keine da oder unlesbar. */
export function comfyVersion(comfyDir: string): string | null {
  try {
    return /__version__\s*=\s*"([\d.]+)"/.exec(readFileSync(join(comfyDir, 'ComfyUI', 'comfyui_version.py'), 'utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}

export function versionAtLeast(have: string, need: string): boolean {
  const a = have.split('.').map(Number);
  const b = need.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/** Download-Link des portablen NVIDIA-Pakets aus der GitHub-Release-Antwort. */
export function pickComfyAsset(release: unknown): { url: string; size: number; version: string } | null {
  const r = release as { tag_name?: unknown; assets?: { name?: unknown; browser_download_url?: unknown; size?: unknown }[] } | null;
  const a = Array.isArray(r?.assets) ? r.assets.find((x) => x.name === COMFY_ASSET) : undefined;
  if (!a || typeof a.browser_download_url !== 'string') return null;
  return { url: a.browser_download_url, size: typeof a.size === 'number' ? a.size : 0, version: String(r?.tag_name ?? '?').replace(/^v/, '') };
}

export const FFMPEG_RELEASE = 'https://api.github.com/repos/FFmpeg-Builds/FFmpeg-Builds/releases/latest';

/** Höchste stabile Linie als GPL-shared-Build (x264 fürs MP4, DLLs halbieren den Download); nie „master“. */
export function pickFfmpegAsset(release: unknown): { name: string; url: string; size: number; version: string } | null {
  const r = release as { assets?: { name?: unknown; browser_download_url?: unknown; size?: unknown }[] } | null;
  let best: { name: string; url: string; size: number; version: string } | null = null;
  for (const a of Array.isArray(r?.assets) ? r.assets : []) {
    const m = typeof a.name === 'string' ? /^ffmpeg-n([\d.]+)-latest-win64-gpl-shared-[\d.]+\.zip$/.exec(a.name) : null;
    if (!m?.[1] || typeof a.browser_download_url !== 'string') continue;
    if (best && versionAtLeast(best.version, m[1])) continue;
    best = { name: a.name as string, url: a.browser_download_url, size: typeof a.size === 'number' ? a.size : 0, version: m[1] };
  }
  return best;
}

/** Ein portables ComfyUI erkennt man am eingebetteten Python neben dem ComfyUI-Ordner. */
export function isPortableComfy(dir: string): boolean {
  return existsSync(join(dir, 'python_embeded', 'python.exe')) && existsSync(join(dir, 'ComfyUI', 'main.py'));
}
