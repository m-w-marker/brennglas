import { execFile } from 'node:child_process';

let missing = false;

/** GPU-Last in % per nvidia-smi (ComfyUI liefert sie nicht); ohne NVIDIA einmal scheitern, dann nicht mehr fragen. */
export function gpuLoad(): Promise<number | null> {
  if (missing) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 3000, windowsHide: true }, (err, out) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') missing = true;
        return resolve(null);
      }
      const n = Number(out.split('\n')[0]?.trim());
      resolve(Number.isFinite(n) ? n : null);
    });
  });
}
