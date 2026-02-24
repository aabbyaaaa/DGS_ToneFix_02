import { defineConfig, loadEnv, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 25000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

function sendJson(res: any, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function getClientIp(req: any): string {
  const forwardedFor = req.headers?.['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

async function readRequestBody(req: any): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', (error: Error) => reject(error));
  });
}

function createPolishProxyPlugin(apiKey: string): Plugin {
  const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

  const handleRequest = async (req: any, res: any, next: () => void) => {
    if (req.url !== '/api/polish') {
      next();
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }

    if (!apiKey) {
      sendJson(res, 500, { error: 'Server API key is missing (API_KEY).' });
      return;
    }

    const now = Date.now();
    const ip = getClientIp(req);
    const current = rateLimitMap.get(ip);

    if (!current || current.resetAt <= now) {
      rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    } else {
      if (current.count >= RATE_LIMIT_MAX) {
        sendJson(res, 429, { error: 'Too many requests. Please retry later.' });
        return;
      }
      current.count += 1;
      rateLimitMap.set(ip, current);
    }

    let payload: unknown;
    try {
      payload = await readRequestBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON payload.' });
      return;
    }

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);

    try {
      const upstream = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:5173',
          'X-Title': 'Dogger Polisher',
        },
        body: JSON.stringify(payload),
        signal: timeoutController.signal,
      });

      const bodyText = await upstream.text();
      res.statusCode = upstream.status;
      res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json; charset=utf-8');
      res.end(bodyText);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      sendJson(res, 502, { error: `Upstream request failed: ${errorMessage}` });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return {
    name: 'polish-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void handleRequest(req, res, next);
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        void handleRequest(req, res, next);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, (process as any).cwd(), '');
  return {
    plugins: [react(), createPolishProxyPlugin(env.API_KEY)],
  };
});
