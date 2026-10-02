import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, Clock, FileUp, Inbox, KeyRound, LoaderCircle } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './kit/popover';
import { cn } from '@/lib/utils';

interface InboxResult { file: string; ok: boolean; kind?: string; summary: string; locked?: boolean; needsPassword?: boolean }
interface Row extends InboxResult { id: number; source?: File }

let nextId = 1;

/**
 * Header button: add an exported file (הר הביטוח, הר הכסף, the pension clearing house ZIP) — the same handling as
 * dropping it into data/inbox/. A locked ZIP asks for its code right there. Works from a phone too.
 */
export function InboxUpload() {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);

  const send = async (file: File, password?: string): Promise<InboxResult> => {
    try {
      const res = await fetch(`/api/inbox?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        // the code goes in a header, not the URL
        headers: { 'content-type': 'application/octet-stream', ...(password ? { 'x-zip-password': encodeURIComponent(password) } : {}) },
        body: file,
      });
      const body = await res.json().catch(() => null);
      return res.ok ? body as InboxResult : { file: file.name, ok: false, summary: body?.error ?? res.statusText };
    } catch (err) {
      return { file: file.name, ok: false, summary: err instanceof Error ? err.message : String(err) };
    }
  };
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['alerts'] });
    qc.invalidateQueries({ queryKey: ['insurance'] });
    qc.invalidateQueries({ queryKey: ['pension'] });
  };

  const upload = async (files: File[]) => {
    setBusy(true);
    try {
      for (const file of files) {
        const r = await send(file);
        setRows(prev => [{ ...r, id: nextId++, source: r.needsPassword ? file : undefined }, ...prev].slice(0, 8));
      }
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const unlock = async (row: Row, password: string) => {
    if (!row.source) return;
    setBusy(true);
    try {
      const r = await send(row.source, password);
      setRows(prev => prev.map(x => (x.id === row.id ? { ...r, id: row.id, source: r.needsPassword ? row.source : undefined } : x)));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) upload([...e.dataTransfer.files]);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="btn-ghost btn-icon text-fg-muted" aria-label="הוספת קובץ">
          <FileUp className="h-[1.15rem] w-[1.15rem]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3" dir="rtl">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Inbox className="h-4 w-4 text-primary" /> הוספת קובץ
        </div>
        <div onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}
          className={cn('flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-5 text-center text-sm text-fg-subtle transition-colors',
            dragging && 'border-primary bg-primary/5')}>
          <span>גרור לכאן ייצוא מהר הביטוח, מהר הכסף או דוח המסלקה, או</span>
          <button type="button" className="btn btn-sm" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? <><LoaderCircle className="h-3.5 w-3.5 animate-spin" /> מייבא…</> : 'בחירת קבצים'}
          </button>
          <input ref={input} type="file" multiple hidden accept=".xlsx,.csv,.zip,.xml"
            onChange={e => { if (e.target.files?.length) upload([...e.target.files]); e.target.value = ''; }} />
          <span className="text-xs">Excel, CSV או ZIP. הקובץ נקרא כאן במחשב, בלי לשלוח אותו לשום מקום.</span>
        </div>
        {rows.length > 0 && (
          <ul className="space-y-2 text-xs">
            {rows.map(r => (
              <li key={r.id} className="flex gap-2">
                {r.ok ? <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  : r.needsPassword ? <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                  : r.locked ? <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                  : <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-600" />}
                <span className="min-w-0 flex-1"><span className="font-medium break-all">{r.file}</span>{r.kind ? ` · ${r.kind}` : ''}<br />
                  <span className="text-fg-subtle">{r.summary}</span>
                  {r.needsPassword && r.source && <PasswordForm busy={busy} onSubmit={code => unlock(r, code)} />}
                </span>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

function PasswordForm({ busy, onSubmit }: { busy: boolean; onSubmit: (code: string) => void }) {
  const [code, setCode] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); if (code.trim()) { onSubmit(code.trim()); setCode(''); } };
  return (
    <form onSubmit={submit} className="mt-1.5 flex items-center gap-1.5">
      <input type="password" inputMode="numeric" autoComplete="off" maxLength={16} value={code} onChange={e => setCode(e.target.value)}
        placeholder="4 ספרות" aria-label="קוד הקובץ" autoFocus
        className="h-7 w-24 rounded-md border bg-background px-2 text-center text-xs tracking-widest" />
      <button type="submit" className="btn btn-sm h-7" disabled={busy || !code.trim()}>פתיחה</button>
    </form>
  );
}
