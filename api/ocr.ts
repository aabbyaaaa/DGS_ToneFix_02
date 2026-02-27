const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OCR_MODEL = process.env.OCR_MODEL || 'google/gemini-2.0-flash-001';
const REQUEST_TIMEOUT_MS = 30000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

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

function normalizeBody(body: unknown): Record<string, unknown> {
  if (typeof body === 'string') {
    return JSON.parse(body);
  }
  if (typeof body === 'object' && body !== null) {
    return body as Record<string, unknown>;
  }
  return {};
}

function parseImageDataUrl(imageDataUrl: string): { mimeType: string; base64Data: string } | null {
  const match = imageDataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-zA-Z0-9+/=]+)$/);
  if (!match) {
    return null;
  }
  const mimeType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  return {
    mimeType,
    base64Data: match[2],
  };
}

function estimateBytes(base64Data: string): number {
  return Math.floor((base64Data.length * 3) / 4);
}

function extractTextFromCompletion(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const textParts = content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (typeof item === 'object' && item !== null && typeof (item as { text?: unknown }).text === 'string') {
          return (item as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean);
    return textParts.join('\n').trim();
  }
  return '';
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

  let payload: Record<string, unknown>;
  try {
    payload = normalizeBody(req.body);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON payload.' });
    return;
  }

  const imageDataUrl = typeof payload.imageDataUrl === 'string' ? payload.imageDataUrl : '';
  if (!imageDataUrl) {
    sendJson(res, 400, { error: 'imageDataUrl is required.' });
    return;
  }

  const parsed = parseImageDataUrl(imageDataUrl);
  if (!parsed) {
    sendJson(res, 400, { error: 'Unsupported image format. Only png/jpeg/webp are allowed.' });
    return;
  }

  if (estimateBytes(parsed.base64Data) > MAX_IMAGE_BYTES) {
    sendJson(res, 413, { error: 'Image is too large. Max size is 10MB.' });
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
        'X-Title': 'Dogger Polisher OCR',
      },
      body: JSON.stringify({
        model: OCR_MODEL,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'You are an OCR extraction assistant. Extract visible text exactly from the image. Return plain text only, keep line breaks, do not add explanations.',
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Please OCR this image and return only the extracted text.',
              },
              {
                type: 'image_url',
                image_url: { url: imageDataUrl },
              },
            ],
          },
        ],
      }),
      signal: timeoutController.signal,
    });

    const bodyText = await upstream.text();
    if (!upstream.ok) {
      sendJson(res, upstream.status, { error: bodyText || 'OCR upstream request failed.' });
      return;
    }

    let parsedBody: any = null;
    try {
      parsedBody = JSON.parse(bodyText);
    } catch {
      sendJson(res, 502, { error: 'OCR response is not valid JSON.' });
      return;
    }

    const content = parsedBody?.choices?.[0]?.message?.content;
    const text = extractTextFromCompletion(content);
    if (!text) {
      sendJson(res, 422, { error: 'No text could be extracted from image.' });
      return;
    }

    sendJson(res, 200, {
      text,
      model: OCR_MODEL,
      charCount: text.length,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    sendJson(res, 502, { error: `OCR upstream request failed: ${errorMessage}` });
  } finally {
    clearTimeout(timeoutId);
  }
}

