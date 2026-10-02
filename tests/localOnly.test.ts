import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerLocalOnly } from '../src/server/localOnly.js';

async function app() {
  const a = Fastify();
  registerLocalOnly(a, 4310, 5180);
  a.get('/api/x', async () => ({ ok: true }));
  a.post('/api/x', async () => ({ ok: true }));
  await a.ready();
  return a;
}

describe('localOnly', () => {
  it('accepts the API and the web app host names', async () => {
    const a = await app();
    for (const host of ['127.0.0.1:4310', 'localhost:4310', '127.0.0.1:5180', 'LOCALHOST:5180']) {
      expect((await a.inject({ url: '/api/x', headers: { host } })).statusCode).toBe(200);
    }
  });

  it('refuses a foreign Host (DNS rebinding)', async () => {
    const a = await app();
    expect((await a.inject({ url: '/api/x', headers: { host: 'evil.example.com' } })).statusCode).toBe(403);
    expect((await a.inject({ url: '/api/x', headers: { host: 'evil.example.com:4310' } })).statusCode).toBe(403);
  });

  it('refuses a foreign Origin (CSRF) and allows the web app origin', async () => {
    const a = await app();
    const post = (origin: string) => a.inject({ method: 'POST', url: '/api/x', headers: { host: '127.0.0.1:5180', origin } });
    expect((await post('https://evil.example.com')).statusCode).toBe(403);
    expect((await post('http://127.0.0.1:5180')).statusCode).toBe(200);
  });

  it('adds ALLOWED_HOSTS names', async () => {
    process.env.ALLOWED_HOSTS = 'my-pc.tailnet.ts.net';
    try {
      const a = await app();
      expect((await a.inject({ url: '/api/x', headers: { host: 'my-pc.tailnet.ts.net:5180' } })).statusCode).toBe(200);
    } finally {
      delete process.env.ALLOWED_HOSTS;
    }
  });
});
