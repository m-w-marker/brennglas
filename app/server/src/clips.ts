import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planConcat, type ClipInfo, type ConcatExtras } from './concat-plan.ts';

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e) => fail(new Error(`${cmd}: ${e.message} – ist es installiert und im PATH?`)));
    child.on('close', (code) => (code === 0 ? ok(out) : fail(new Error(`${cmd} Code ${String(code)}: ${err.trim().slice(-600)}`))));
  });
}

export async function probe(file: string): Promise<ClipInfo> {
  const raw = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate:format=duration', '-of', 'json', file]);
  const j = JSON.parse(raw) as { streams?: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string }[]; format?: { duration?: string } };
  const v = j.streams?.find((s) => s.codec_type === 'video');
  const [num, den] = (v?.r_frame_rate ?? '24/1').split('/').map(Number);
  const duration = Number(j.format?.duration);
  if (!v?.width || !v.height || !Number.isFinite(duration)) throw new Error(`Kein lesbares Video: ${file}`);
  return { duration, width: v.width, height: v.height, fps: den ? Math.round(((num ?? 24) / den) * 1000) / 1000 : 24, hasAudio: !!j.streams?.some((s) => s.codec_type === 'audio') };
}

export interface ConcatOptions {
  fade: number;
  /** Standbild am Ende (z. B. Logo-Karte), wird wie ein stummer Shot angehängt. */
  endcard?: { file: string; seconds: number };
  music?: { file: string; volume: number; shotVolume: number };
  logo?: { file: string; scale: number; position: 'tl' | 'tr' | 'bl' | 'br' };
}

async function probeImage(file: string): Promise<{ width: number; height: number }> {
  const raw = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', file]);
  const s = (JSON.parse(raw) as { streams?: { width?: number; height?: number }[] }).streams?.[0];
  if (!s?.width || !s.height) throw new Error(`Kein lesbares Bild: ${file}`);
  return { width: s.width, height: s.height };
}

/** Shots zu einem MP4 (H.264 + AAC); fade in Sekunden, 0 = harter Schnitt; optional Endkarte, Musik, Logo. */
export async function concatClips(files: string[], o: ConcatOptions, out: string): Promise<{ duration: number; width: number; height: number }> {
  const clips = await Promise.all(files.map(probe));
  const inputs = files.flatMap((f) => ['-i', f]);
  const fps = clips[0]?.fps ?? 24;
  if (o.endcard) {
    clips.push({ ...(await probeImage(o.endcard.file)), duration: o.endcard.seconds, fps, hasAudio: false });
    inputs.push('-loop', '1', '-framerate', String(fps), '-t', String(o.endcard.seconds), '-i', o.endcard.file);
  }
  const extras: ConcatExtras = {};
  if (o.music) {
    if (!(await probeHasAudio(o.music.file))) throw new Error(`Keine Tonspur in ${o.music.file}`);
    extras.music = { input: clips.length, volume: o.music.volume, shotVolume: o.music.shotVolume };
    inputs.push('-i', o.music.file);
  }
  if (o.logo) {
    await probeImage(o.logo.file);
    extras.logo = { input: clips.length + (o.music ? 1 : 0), scale: o.logo.scale, position: o.logo.position };
    inputs.push('-i', o.logo.file);
  }
  const plan = planConcat(clips, o.fade, extras);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...inputs,
    '-filter_complex', plan.filter, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out]);
  return plan;
}

async function probeHasAudio(file: string): Promise<boolean> {
  const raw = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', file]);
  return !!(JSON.parse(raw) as { streams?: { codec_type?: string }[] }).streams?.some((x) => x.codec_type === 'audio');
}

/** Ein Frame als PNG; at = Sekunden ab Anfang, null = der letzte. */
export async function frameAt(file: string, at: number | null): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'brennglas-frame-'));
  const png = join(dir, 'f.png');
  try {
    // -update 1 überschreibt je Frame: übrig bleibt der letzte der letzten Sekunde
    const seek = at === null ? ['-sseof', '-1'] : ['-ss', String(at)];
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...seek, '-i', file, ...(at === null ? ['-update', '1'] : ['-frames:v', '1']), png]);
    return readFileSync(png);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
