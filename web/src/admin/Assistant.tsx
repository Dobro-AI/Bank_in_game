import { FormEvent, useEffect, useRef, useState } from 'react';
import { api, useLoad } from '../api';
import { ErrorText, Money } from '../ui';
import type { Ctx } from './GamePage';

interface ChatMessage { id: number; role: 'user' | 'assistant'; text: string; hasImage: boolean; created_at: string }
interface Proposal {
  id: number; kind: string; status: 'pending' | 'done' | 'rejected'; amount: number; comment: string;
  sourceNote: string; from: string; to: string; priceItem: string | null;
}
interface ThreadView { threadId: number; messages: ChatMessage[]; proposals: Proposal[]; transcription: boolean }

const KIND: Record<string, string> = { transfer: 'Перевод', host_credit: 'Начисление', host_debit: 'Списание', fixed_price: 'Оплата по прайсу' };
const STATUS: Record<string, string> = { done: 'Проведено', rejected: 'Отклонено' };
const SUGGESTIONS = [
  'Сколько денег сейчас у каждой роли?',
  'Покажи самые крупные переводы за текущий такт',
  'Какие цены в прайсе и что говорят правила про налоги?',
  'Предложи, как ввести в игру страхование: capex, opex и эффект',
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
  const audioInput = useRef<HTMLInputElement>(null);

  useEffect(() => { if (view.data) setData(view.data); }, [view.data]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [data?.messages.length, data?.proposals.length, busy]);

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

  async function newChat() {
    const v = await api<ThreadView>(`/api/admin/games/${ctx.id}/assistant/new`, { body: {} });
    setData(v);
  }

  if (!data) return <ErrorText error={view.error} />;
  // Messages and proposal cards in one timeline.
  const timeline = [
    ...data.messages.map((m) => ({ at: m.created_at, key: `m${m.id}`, m })),
    ...data.proposals.map((p) => ({ at: (p as any).created_at ?? '', key: `p${p.id}`, p })),
  ];

  return (
    <section className="assistant">
      <div className="row between">
        <p className="small muted" style={{ margin: 0 }}>Чат виден только вам. Помощник читает данные игры, но двигает деньги только после вашего подтверждения.</p>
        <button className="btn small" onClick={newChat} disabled={busy}>Новый чат</button>
      </div>

      <div className="chat" aria-live="polite">
        {timeline.length === 0 && (
          <div className="stack">
            <p className="muted">Сфотографируйте бумажку с переводом, спросите про балансы и переводы или попросите придумать механику.</p>
            <div className="chips">
              {SUGGESTIONS.map((s) => <button key={s} className="chip-toggle" onClick={() => send(undefined, s)} disabled={busy}>{s}</button>)}
            </div>
          </div>
        )}
        {timeline.map((item) => 'm' in item && item.m ? (
          <div key={item.key} className={`bubble ${item.m.role}`}>
            {item.m.hasImage && <div className="tiny muted">Фото</div>}
            {item.m.text}
          </div>
        ) : 'p' in item && item.p ? (
          <ProposalCard key={item.key} p={item.p} canRun={ctx.d.can.run} onDecide={decide} />
        ) : null)}
        {busy && <div className="bubble assistant muted">Помощник думает…</div>}
        <div ref={bottom} />
      </div>

      <ErrorText error={error} />
      {note && <p className="small muted">{note}</p>}
      {image && (
        <div className="row">
          <img src={image.preview} alt="Фото для помощника" className="thumb" />
          <button className="btn small" onClick={() => setImage(undefined)}>Убрать фото</button>
        </div>
      )}
      <form className="composer" onSubmit={send}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Сообщение помощнику"
          aria-label="Сообщение помощнику" rows={2}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <div className="row">
          <button type="button" className="btn small" onClick={() => photoInput.current?.click()}>Фото</button>
          <input ref={photoInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { onPhoto(e.target.files?.[0]); e.target.value = ''; }} />
          {SpeechRecognitionCtor && (
            <button type="button" className="btn small" aria-pressed={listening} onClick={toggleDictation}>{listening ? 'Остановить диктовку' : 'Диктовать'}</button>
          )}
          {data.transcription && (
            <>
              <button type="button" className="btn small" aria-pressed={recording} onClick={toggleRecording}>{recording ? 'Остановить запись' : 'Записать голосовое'}</button>
              <button type="button" className="btn small" onClick={() => audioInput.current?.click()}>Аудиофайл</button>
              <input ref={audioInput} type="file" accept="audio/*" hidden onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) transcribeBlob(f, f.name);
                e.target.value = '';
              }} />
            </>
          )}
          <span className="grow" />
          <button className="btn primary" disabled={busy || (!text.trim() && !image)}>Отправить</button>
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
        <strong>{KIND[p.kind]}{p.priceItem ? `: ${p.priceItem}` : ''}</strong>
        {p.status !== 'pending' && <span className={p.status === 'done' ? 'chip accent' : 'chip'}>{STATUS[p.status]}</span>}
      </div>
      <div className="summary-line"><span className="muted">Откуда</span><span>{p.from}</span></div>
      <div className="summary-line"><span className="muted">Куда</span><span>{p.to}</span></div>
      <div className="summary-line"><span className="muted">Сумма</span><Money value={p.amount} /></div>
      {p.comment && <div className="summary-line"><span className="muted">Назначение</span><span>{p.comment}</span></div>}
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
