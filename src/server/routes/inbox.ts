import { randomBytes } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/connection.js';
import { INBOX_DIR, handleFile } from '../../inbox/index.js';

const MAX_FILE = 40 * 1024 * 1024;

/** A file name safe to keep: no folders, no characters Windows refuses. */
export const safeUploadName = (name: string) =>
  basename(name.replace(/\\/g, '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 120) || 'file';

/**
 * The "add a file" button: the raw file as the body (application/octet-stream), its name in ?name=, and for a locked
 * ZIP the code in an X-Zip-Password header (used to open it; never stored, never in a URL or a log).
 * It goes through the same inbox handling as a file dropped into data/inbox/, right away, and the result is returned.
 * (Written first under a dot-name the folder watcher ignores, so it isn't picked up twice.)
 */
export function inboxRoutes(app: FastifyInstance, db: DB): void {
  app.post('/api/inbox', { bodyLimit: MAX_FILE }, async (req, reply) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) return reply.code(400).send({ error: 'empty file' });
    const name = safeUploadName(String((req.query as { name?: string }).name ?? 'file'));
    // in a header, not the URL — the dev proxy prints the URL of a request that fails
    const header = req.headers['x-zip-password'];
    const password = typeof header === 'string' && header ? decodeURIComponent(header).slice(0, 64) : undefined;
    mkdirSync(INBOX_DIR, { recursive: true });
    const path = join(INBOX_DIR, `.upload-${randomBytes(4).toString('hex')}-${name}`);
    writeFileSync(path, body);
    return handleFile(db, INBOX_DIR, path, name, { password, askPassword: true });
  });
}
