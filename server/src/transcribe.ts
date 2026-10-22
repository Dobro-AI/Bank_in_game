import { AppError } from './db.js';

/**
 * Speech-to-text for uploaded voice messages. Claude does not accept audio, so this goes to a
 * separate STT service: OpenAI's transcription endpoint when OPENAI_API_KEY is set.
 * Live dictation in the browser (Web Speech API) works without it.
 */
export function transcriptionEnabled() {
  return !!process.env.OPENAI_API_KEY;
}

export async function transcribe(audio: Buffer, mimeType: string, filename: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new AppError('Расшифровка аудиофайлов не настроена (нужен OPENAI_API_KEY)', 503);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType || 'audio/webm' }), filename || 'voice.webm');
  form.append('model', process.env.STT_MODEL ?? 'whisper-1');
  form.append('language', 'ru');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new AppError(`Не удалось расшифровать аудио (${res.status})`, 502);
  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
}
