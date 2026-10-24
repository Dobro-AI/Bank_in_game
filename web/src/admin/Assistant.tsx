import { FormEvent, useEffect, useRef, useState } from 'react';
import { api, useLoad } from '../api';
import { CloseIcon, ImageAddIcon, MicIcon, SendIcon } from '../icons';
import { ErrorText, Money } from '../ui';
import type { Ctx } from './GamePage';

interface ChatMessage { id: number; role: 'user' | 'assistant'; text: string; hasImage: boolean; created_at: string }
interface Proposal {
  id: number; kind: string; status: 'pending' | 'done' | 'rejected'; title: string; sourceNote: string;
  lines: { label: string; value: string | number; money?: boolean }[];
}
interface ThreadView { threadId: number; messages: ChatMessage[]; proposals: Proposal[]; transcription: boolean }

const STATUS: Record<string, string> = { done: 'Проведено', rejected: 'Отклонено' };
const SUGGESTIONS = [
  'Сколько денег у каждой роли?',
  'Самые крупные переводы за такт',
  'Кто больше всех заработал?',
  'Что в прайсе и правилах про налоги?',
  'Что сейчас в листе «Счета»?',
  'Придумай страхование: capex, opex, эффект',
];

const SpeechRecognitionCtor: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

/** Shrinks a photo before upload: phone pictures are several MB, 1600px is plenty to read a slip. */
async function prepareImage(file: File): Promise<{ mediaType: string; data: string; preview: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const preview = canvas.toDataURL('image/jpeg', 0.85);
  return { mediaType: 'image/jpeg', data: preview.split(',')[1], preview };
}

const toBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });

export function Assistant({ ctx }: { ctx: Ctx }) {
  const view = useLoad(() => api<ThreadView>(`/api/admin/games/${ctx.id}/assistant`), [ctx.id]);
  const [data, setData] = useState<ThreadView>();
  const [text, setText] = useState('');
  const [image, setImage] = useState<{ mediaType: string; data: string; preview: string }>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const [listening, setListening] = useState(false);
  const [recording, setRecording] = useState(false);
  const recognition = useRef<any>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (view.data) setData(view.data); }, [view.data]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [data?.messages.length, data?.proposals.length, busy]);
  // The message field grows with the text, up to a few lines.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  async function send(e?: FormEvent, preset?: string) {
    e?.preventDefault();
    const message = preset ?? text;
    if (!message.trim() && !image) return;
    setBusy(true);
    setError(undefined);
    // Show the message immediately; the reply can take a while.
    setData((d) => d && { ...d, messages: [...d.messages, { id: -1, role: 'user', text: message, hasImage: !!image, created_at: new Date().toISOString() }] });
    setText('');
    const img = image;
    setImage(undefined);
    try {
      const v = await api<ThreadView>(`/api/admin/games/${ctx.id}/assistant/messages`, {
        body: { text: message, image: img && { mediaType: img.mediaType, data: img.data } },
      });
      setData((d) => ({ ...v, transcription: d?.transcription ?? false }));
    } catch (err: any) {
      setError(err.message);
      view.reload();
    } finally {
      setBusy(false);
    }
  }

  async function onPhoto(file?: File) {
    if (!file) return;
    try { setImage(await prepareImage(file)); } catch { setError('Не удалось открыть изображение'); }
  }

  async function transcribeBlob(blob: Blob, filename: string) {
    setNote('Расшифровываем аудио…');
    try {
      const r = await api<{ text: string }>('/api/admin/assistant/transcribe', {
        body: { data: await toBase64(blob), mediaType: blob.type, filename },
      });
      setText((t) => [t, r.text].filter(Boolean).join(' '));
      setNote(undefined);
    } catch (err: any) {
      setNote(undefined);
      setError(err.message);
    }
  }

  function toggleDictation() {
    if (listening) { recognition.current?.stop(); return; }
    const rec = new SpeechRecognitionCtor();
    rec.lang = 'ru-RU';
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (ev: any) => {
      const chunk = Array.from(ev.results as ArrayLike<any>).slice(ev.resultIndex).map((r: any) => r[0].transcript).join(' ');
      setText((t) => [t, chunk.trim()].filter(Boolean).join(' '));
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognition.current = rec;
    rec.start();
    setListening(true);
  }

  async function toggleRecording() {
    if (recording) { recorder.current?.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        transcribeBlob(new Blob(chunks, { type: rec.mimeType }), 'voice.webm');
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setError('Нет доступа к микрофону');
    }
  }

  async function decide(p: Proposal, action: 'confirm' | 'reject') {
    setError(undefined);
    try {
      await api(`/api/admin/assistant/proposals/${p.id}/${action}`, { body: {} });
      view.reload();
      ctx.reload();
    } catch (err: any) {
      setError(err.message);
      view.reload();
    }
  }

  if (!data) return <ErrorText error={view.error} />;
  // Messages and proposal cards in one timeline.
  const timeline = [
    ...data.messages.map((m) => ({ at: m.created_at, key: `m${m.id}`, m })),
    ...data.proposals.map((p) => ({ at: (p as any).created_at ?? '', key: `p${p.id}`, p })),
  ];

  // Dictation in the browser when it can, otherwise a voice note transcribed on the server.
  const mic = SpeechRecognitionCtor
    ? { on: listening, toggle: toggleDictation, label: listening ? 'Остановить диктовку' : 'Диктовать' }
    : data.transcription
      ? { on: recording, toggle: toggleRecording, label: recording ? 'Остановить запись' : 'Записать голосовое' }
      : null;

  return (
    <section className="assistant">
      <p className="small muted" style={{ margin: 0 }}>Помощник читает данные игры, но двигает деньги только после вашего подтверждения.</p>

      <div className="chat" aria-live="polite">
        {timeline.length === 0 && (
          <p className="muted">Сфотографируйте бумажку с переводом, спросите про балансы и переводы или попросите придумать механику.</p>
        )}
        {timeline.map((item) => 'm' in item && item.m ? (
          <div key={item.key} className={`bubble ${item.m.role}`}>
            {item.m.hasImage && <div className="tiny muted">Фото</div>}
            {item.m.text}
          </div>
        ) : 'p' in item && item.p ? (
          <ProposalCard key={item.key} p={item.p} canRun={ctx.d.game.kind === 'branch'} onDecide={decide} />
        ) : null)}
        {busy && <div className="bubble assistant muted">Помощник думает…</div>}
        <div ref={bottom} />
      </div>

      <ErrorText error={error} />
      {note && <p className="small muted">{note}</p>}

      <div className="hints" role="list" aria-label="Подсказки">
        {SUGGESTIONS.map((s) => (
          <button key={s} role="listitem" className="hint" onClick={() => send(undefined, s)} disabled={busy}>{s}</button>
        ))}
      </div>
      <form className="composer" onSubmit={send}>
        {image && (
          <div className="composer-photo">
            <img src={image.preview} alt="Фото для помощника" className="thumb" />
            <button type="button" className="composer-photo-remove" aria-label="Убрать фото" onClick={() => setImage(undefined)}><CloseIcon /></button>
          </div>
        )}
        <div className="composer-bar">
          <button type="button" className="icon-btn" aria-label="Прикрепить фото" onClick={() => photoInput.current?.click()}><ImageAddIcon /></button>
          <input ref={photoInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { onPhoto(e.target.files?.[0]); e.target.value = ''; }} />
          <textarea ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="Написать сообщение…"
            aria-label="Сообщение помощнику" rows={1}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          {mic && (
            <button type="button" className="icon-btn" aria-label={mic.label} title={mic.label} aria-pressed={mic.on} onClick={mic.toggle}><MicIcon /></button>
          )}
          <button className="send-btn" aria-label="Отправить" disabled={busy || (!text.trim() && !image)}><SendIcon /></button>
        </div>
      </form>
    </section>
  );
}

function ProposalCard({ p, canRun, onDecide }: { p: Proposal; canRun: boolean; onDecide: (p: Proposal, a: 'confirm' | 'reject') => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const run = async (a: 'confirm' | 'reject') => { setBusy(true); await onDecide(p, a); setBusy(false); };
  return (
    <div className="panel proposal">
      <div className="row between">
        <strong>{p.title}</strong>
        {p.status !== 'pending' && <span className={p.status === 'done' ? 'chip accent' : 'chip'}>{STATUS[p.status]}</span>}
      </div>
      {p.lines.map((l) => (
        <div key={l.label} className="summary-line">
          <span className="muted">{l.label}</span>{l.money ? <Money value={Number(l.value)} /> : <span>{l.value}</span>}
        </div>
      ))}
      {p.sourceNote && <p className="tiny muted">На бумажке: {p.sourceNote}</p>}
      {p.status === 'pending' && canRun && (
        <div className="row end">
          <button className="btn small" disabled={busy} onClick={() => run('reject')}>Отклонить</button>
          <button className="btn small primary" disabled={busy} onClick={() => run('confirm')}>Провести</button>
        </div>
      )}
    </div>
  );
}
