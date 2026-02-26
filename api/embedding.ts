const OPENAI_EMBEDDINGS_API_URL = 'https://api.openai.com/v1/embeddings';
const REQUEST_TIMEOUT_MS = 12000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function sendJson(res: any, status: number, payload: unknown) {
  res.status(status).json(payload);
}

function getClientIp(req: any): string {
  const forwardedFor = req.headers?.['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

function normalizeBody(body: unknown): { text: string } {
  const payload = typeof body === 'string' ? JSON.parse(body) : body;
  if (typeof (payload as { text?: unknown })?.text !== 'string') {
    throw new Error('Invalid payload: text is required.');
  }
  const text = (payload as { text: string }).text.trim();
  if (!text) {
    throw new Error('Invalid payload: text must not be empty.');
  }
  return { text };
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const hybridEnabled = process.env.HYBRID_ENABLED === undefined || process.env.HYBRID_ENABLED === 'true';
  if (!hybridEnabled) {
    sendJson(res, 503, { error: 'Hybrid retrieval is disabled.' });
    return;
  }

  const openAiApiKey = process.env.OPENAI_API_KEY;
  if (!openAiApiKey) {
    sendJson(res, 500, { error: 'Server OPENAI_API_KEY is missing.' });
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

  let body: { text: string };
  try {
    body = normalizeBody(req.body);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(OPENAI_EMBEDDINGS_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openAiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
        input: body.text,
      }),
      signal: timeoutController.signal,
    });

    const responseText = await response.text();
    if (!response.ok) {
      sendJson(res, response.status, { error: responseText || 'Embedding API failed.' });
      return;
    }

    const parsed = JSON.parse(responseText);
    const vector = parsed?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      sendJson(res, 502, { error: 'Embedding vector is missing in API response.' });
      return;
    }

    sendJson(res, 200, {
      model: parsed?.model,
      vector,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    sendJson(res, 502, { error: `Embedding upstream request failed: ${errorMessage}` });
  } finally {
    clearTimeout(timeoutId);
  }
}
