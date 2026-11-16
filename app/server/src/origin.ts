/** CSRF-Sperre: schreiben nur ohne Origin (curl, Skripte) oder vom selben Host – fremde Seiten senden ihren Origin mit. */
export function allowedWrite(method: string, origin: string | undefined, host: string | undefined): boolean {
  if (method === 'GET' || method === 'HEAD') return true;
  if (origin === undefined) return true;
  if (!host) return false;
  try {
    // Über URL normalisiert: Groß/klein und Standard-Port :80 vergleichen sonst falsch
    return new URL(origin).host === new URL(`http://${host}`).host;
  } catch {
    return false; // auch Origin "null" aus Sandbox-iframes
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** DNS-Rebinding-Sperre: eine fremde Domain, die auf 127.0.0.1 umgebogen wird, trägt ihren Namen im Host-Header. */
export function allowedHost(host: string | undefined, bindHost: string): boolean {
  if (!host) return false;
  try {
    const name = new URL(`http://${host}`).hostname;
    return LOOPBACK.has(name) || name === bindHost.toLowerCase();
  } catch {
    return false;
  }
}
