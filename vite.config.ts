import { defineConfig, loadEnv, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENAI_EMBEDDINGS_API_URL = 'https://api.openai.com/v1/embeddings';
const REQUEST_TIMEOUT_MS = 25000;
const EMBEDDING_TIMEOUT_MS = 12000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const EMBEDDING_RATE_LIMIT_MAX = 60;

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

function createApiProxyPlugin(options: {
  openRouterApiKey: string;
  openAiApiKey: string;
  embeddingModel: string;
  hybridEnabled: boolean;
}): Plugin {
  const polishRateLimitMap = new Map<string, { count: number; resetAt: number }>();
  const embeddingRateLimitMap = new Map<string, { count: number; resetAt: number }>();

  const checkRateLimit = (rateMap: Map<string, { count: number; resetAt: number }>, ip: string, max: number): boolean => {
    const now = Date.now();
    const current = rateMap.get(ip);

    if (!current || current.resetAt <= now) {
      rateMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return true;
    }

    if (current.count >= max) {
      return false;
    }

    current.count += 1;
    rateMap.set(ip, current);
    return true;
  };

  const handlePolishRequest = async (req: any, res: any) => {
    if (!options.openRouterApiKey) {
      sendJson(res, 500, { error: 'Server API key is missing (API_KEY).' });
      return;
    }

    const ip = getClientIp(req);
    if (!checkRateLimit(polishRateLimitMap, ip, RATE_LIMIT_MAX)) {
      sendJson(res, 429, { error: 'Too many requests. Please retry later.' });
      return;
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
          Authorization: `Bearer ${options.openRouterApiKey}`,
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

  const handleEmbeddingRequest = async (req: any, res: any) => {
    if (!options.hybridEnabled) {
      sendJson(res, 503, { error: 'Hybrid retrieval is disabled.' });
      return;
    }
    if (!options.openAiApiKey) {
      sendJson(res, 500, { error: 'Server OPENAI_API_KEY is missing.' });
      return;
    }

    const ip = getClientIp(req);
    if (!checkRateLimit(embeddingRateLimitMap, ip, EMBEDDING_RATE_LIMIT_MAX)) {
      sendJson(res, 429, { error: 'Too many requests. Please retry later.' });
      return;
    }

    let payload: unknown;
    try {
      payload = await readRequestBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON payload.' });
      return;
    }

    const text = typeof (payload as { text?: unknown })?.text === 'string' ? (payload as { text: string }).text.trim() : '';
    if (!text) {
      sendJson(res, 400, { error: 'Invalid payload: text is required.' });
      return;
    }

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), EMBEDDING_TIMEOUT_MS);

    try {
      const upstream = await fetch(OPENAI_EMBEDDINGS_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.openAiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: options.embeddingModel,
          input: text,
        }),
        signal: timeoutController.signal,
      });

      const bodyText = await upstream.text();
      if (!upstream.ok) {
        sendJson(res, upstream.status, { error: bodyText || 'Embedding API failed.' });
        return;
      }

      const parsed = JSON.parse(bodyText);
      const vector = parsed?.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length === 0) {
        sendJson(res, 502, { error: 'Embedding vector is missing in API response.' });
        return;
      }

      sendJson(res, 200, { model: parsed?.model, vector });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      sendJson(res, 502, { error: `Embedding upstream request failed: ${errorMessage}` });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const handleRequest = async (req: any, res: any, next: () => void) => {
    if (req.url !== '/api/polish' && req.url !== '/api/embedding') {
      next();
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }

    if (req.url === '/api/polish') {
      await handlePolishRequest(req, res);
      return;
    }

    await handleEmbeddingRequest(req, res);
  };

  return {
    name: 'api-proxy',
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
    plugins: [
      react(),
      createApiProxyPlugin({
        openRouterApiKey: env.API_KEY,
        openAiApiKey: env.OPENAI_API_KEY,
        embeddingModel: env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
        hybridEnabled: env.HYBRID_ENABLED === undefined || env.HYBRID_ENABLED === 'true',
      }),
    ],
  };
});
