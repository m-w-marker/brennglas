import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Relative Pfade gelten ab app/, egal aus welchem Ordner gestartet wird.
export const APP_DIR = fileURLToPath(new URL('../../', import.meta.url));

const envFile = resolve(APP_DIR, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const config = {
  comfyUrl: (process.env.COMFY_URL ?? 'http://127.0.0.1:8188').replace(/\/$/, ''),
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
  dataDir: resolve(APP_DIR, process.env.DATA_DIR ?? './data'),
  workflowsDir: resolve(APP_DIR, 'workflows'),
  modelsDir: resolve(APP_DIR, 'models'),
};
