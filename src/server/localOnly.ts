import type { FastifyInstance } from 'fastify';

/**
 * Binding to 127.0.0.1 keeps other machines out, but not web pages open in this machine's browser:
 * - DNS rebinding: a site points its own hostname at 127.0.0.1 and reads the API as same-origin.
 *   Its requests carry that hostname in `Host`, so only our own host names are accepted.
 * - CSRF: a page posts a form / no-cors fetch to the API. Browsers send `Origin` on those, so a request
 *   with an Origin that isn't the web app is refused. Requests without Origin (curl, the chat's MCP server,
 *   same-origin GETs) still work.
 *
 * The Vite dev server proxies /api without changing `Host`, so the web app's port is allowed too.
 * `ALLOWED_HOSTS` (comma-separated host names, e.g. a private-network name) adds names for both ports.
 */
export function allowedHosts(apiPort: number | string, webPort: number | string): Set<string> {
  const names = ['127.0.0.1', 'localhost',
    ...(process.env.ALLOWED_HOSTS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)];
  return new Set(names.flatMap(n => [`${n}:${apiPort}`, `${n}:${webPort}`]));
}

export function registerLocalOnly(app: FastifyInstance, apiPort: number | string, webPort: number | string): void {
  const hosts = allowedHosts(apiPort, webPort);
  const origins = new Set([...hosts].map(h => `http://${h}`));

  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!hosts.has(host)) return reply.code(403).send({ error: `host not allowed: ${host || '(none)'}` });
    const origin = req.headers.origin;
    if (origin && !origins.has(origin.toLowerCase())) return reply.code(403).send({ error: 'origin not allowed' });
  });
}
