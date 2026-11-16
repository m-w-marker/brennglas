import type { ServerResponse } from 'node:http';
import type { SseEvent } from '@brennglas/shared';

const clients = new Set<ServerResponse>();

export function addClient(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': verbunden\n\n');
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function broadcast(ev: SseEvent): void {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(line);
}

// Hält die Verbindung durch Proxys offen, die stille Streams kappen.
setInterval(() => {
  for (const c of clients) c.write(': ping\n\n');
}, 15_000).unref();
