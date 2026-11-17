// ffmpeg und ffprobe: die Fassung aus install.bat (app/runtime/ffmpeg) vor der im PATH.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FFMPEG_DIR = join(fileURLToPath(new URL('../../', import.meta.url)), 'runtime', 'ffmpeg');

export function toolPath(name: 'ffmpeg' | 'ffprobe', dir = FFMPEG_DIR, exists: (f: string) => boolean = existsSync): string {
  const local = join(dir, 'bin', `${name}.exe`);
  return exists(local) ? local : name;
}
