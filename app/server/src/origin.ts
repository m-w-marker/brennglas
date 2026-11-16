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
