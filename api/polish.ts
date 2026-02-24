const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 25000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

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

function normalizePayload(body: unknown): unknown {
  if (typeof body === 'string') {
    return JSON.parse(body);
  }
  return body ?? {};
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const apiKey = process.env.API_KEY;
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
    payload = normalizePayload(req.body);
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
        'HTTP-Referer': 'https://dogger-polisher.vercel.app',
        'X-Title': 'Dogger Polisher',
      },
      body: JSON.stringify(payload),
      signal: timeoutController.signal,
    });

    const bodyText = await upstream.text();
    let parsed: unknown = bodyText;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // Keep plain text if upstream did not return JSON.
    }

    sendJson(res, upstream.status, parsed);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    sendJson(res, 502, { error: `Upstream request failed: ${errorMessage}` });
  } finally {
    clearTimeout(timeoutId);
  }
}
