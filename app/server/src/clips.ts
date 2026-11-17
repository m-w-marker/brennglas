import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeArgs, frameRate, planConcat, type ClipInfo, type ConcatExtras, type CutFormat, type Join, type ShotEdit } from './concat-plan.ts';
import { toolPath } from './tools.ts';

function run(tool: 'ffmpeg' | 'ffprobe', args: string[]): Promise<string> {
  const cmd = toolPath(tool);
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e) => fail(new Error(`${tool}: ${e.message} – install.bat richtet es ein`)));
    child.on('close', (code) => (code === 0 ? ok(out) : fail(new Error(`${tool} Code ${String(code)}: ${err.trim().slice(-600)}`))));
  });
}

export async function probe(file: string): Promise<ClipInfo> {
  const raw = await run('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,width,height,r_frame_rate,avg_frame_rate,duration:stream_disposition=attached_pic:format=duration', '-of', 'json', file]);
  type Stream = { codec_type?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; duration?: string; disposition?: { attached_pic?: number } };
  const j = JSON.parse(raw) as { streams?: Stream[]; format?: { duration?: string } };
  // Cover-Bild in mp4/m4a zählt als Video-Stream, ist aber keins
  const v = j.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  // Länge der Videospur: ist sie kürzer als der Container, setzte xfade sonst hinter ihr Ende an und verlöre den Rest still
  const own = Number(v?.duration);
  const duration = own > 0 ? own : Number(j.format?.duration);
  if (!v?.width || !v.height || !Number.isFinite(duration)) throw new Error(`Kein lesbares Video: ${file}`);
  return { duration, width: v.width, height: v.height, fps: frameRate(v.avg_frame_rate, v.r_frame_rate), hasAudio: !!j.streams?.some((s) => s.codec_type === 'audio') };
}

export interface ConcatOptions {
  fade: number;
  /** Übergang je Shot-Paar; fehlt er, gilt fade als Überblendung. Zur Endkarte endJoin, sonst fade. */
  joins?: Join[];
  endJoin?: Join;
  /** Kürzen und Tempo je Shot, gleiche Reihenfolge wie files. */
  edits?: ShotEdit[];
  /** Standbild am Ende (z. B. Logo-Karte), wird wie ein stummer Shot angehängt. */
  endcard?: { file: string; seconds: number };
  music?: { file: string; volume: number; shotVolume: number };
  logo?: { file: string; scale: number; position: 'tl' | 'tr' | 'bl' | 'br' };
  fadeIn?: number;
  fadeOut?: number;
  format?: CutFormat;
  /** Klein und schnell, zum Ansehen vor dem Rendern. */
  preview?: boolean;
}

async function probeImage(file: string): Promise<{ width: number; height: number }> {
  const raw = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', file]);
  const s = (JSON.parse(raw) as { streams?: { width?: number; height?: number }[] }).streams?.[0];
  if (!s?.width || !s.height) throw new Error(`Kein lesbares Bild: ${file}`);
  return { width: s.width, height: s.height };
}

/** Shots zu einem MP4 (H.264 + AAC) oder WebM (VP9 + Opus); fade in Sekunden, 0 = harter Schnitt; optional Endkarte, Musik, Logo. */
export async function concatClips(files: string[], o: ConcatOptions, out: string): Promise<{ duration: number; width: number; height: number }> {
  const clips = await Promise.all(files.map(probe));
  const inputs = files.flatMap((f) => ['-i', f]);
  const fps = clips[0]?.fps ?? 24;
  if (o.endcard) {
    clips.push({ ...(await probeImage(o.endcard.file)), duration: o.endcard.seconds, fps, hasAudio: false });
    inputs.push('-loop', '1', '-framerate', String(fps), '-t', String(o.endcard.seconds), '-i', o.endcard.file);
  }
  const extras: ConcatExtras = {
    ...(o.fadeIn ? { fadeIn: o.fadeIn } : {}), ...(o.fadeOut ? { fadeOut: o.fadeOut } : {}), ...(o.preview ? { maxHeight: 480 } : {}),
  };
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
  const joins: Join[] = [...(o.joins ?? files.slice(1).map(() => ({ duration: o.fade }))), ...(o.endcard ? [o.endJoin ?? { duration: o.fade }] : [])];
  const plan = planConcat(clips, joins, extras, o.edits);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...inputs,
    '-filter_complex', plan.filter, '-map', '[v]', '-map', '[a]', ...encodeArgs(o.format ?? 'mp4', o.preview), out]);
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
