import { OcrExtractResponse } from '../types';

const OCR_API_URL = '/api/ocr';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

function normalizeMimeType(type: string): string {
  if (type === 'image/jpg') {
    return 'image/jpeg';
  }
  return type;
}

function isSupportedType(type: string): boolean {
  return SUPPORTED_TYPES.has(type);
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('無法讀取圖片檔案'));
    reader.readAsDataURL(file);
  });
}

export async function extractTextFromImage(file: File): Promise<OcrExtractResponse> {
  const mimeType = normalizeMimeType(file.type);
  if (!isSupportedType(mimeType)) {
    throw new Error('僅支援 PNG / JPG / WEBP 圖片');
  }

  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('圖片大小超過 10MB，請縮小後再試');
  }

  const imageDataUrl = await fileToDataUrl(file);
  const response = await fetch(OCR_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ imageDataUrl }),
  });

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const message = typeof body?.error === 'string' ? body.error : `OCR API Error: ${response.status}`;
    throw new Error(message);
  }

  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) {
    throw new Error('未辨識到文字，請換一張更清晰的圖片');
  }

  return {
    text,
    charCount: Number(body?.charCount ?? text.length),
    model: typeof body?.model === 'string' ? body.model : undefined,
  };
}

