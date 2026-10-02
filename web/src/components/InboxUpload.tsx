import { useRef, useState, type DragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, Clock, FileUp, Inbox, LoaderCircle } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './kit/popover';
import { cn } from '@/lib/utils';

interface InboxResult { file: string; ok: boolean; kind?: string; summary: string; locked?: boolean }

/**
 * Header button: add an exported file (הר הביטוח / הר הכסף) — the same handling as dropping it into data/inbox/.
 * Works from a phone too, where the folder isn't reachable.
 */
export function InboxUpload() {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<InboxResult[]>([]);

  const upload = async (files: File[]) => {
    setBusy(true);
    try {
      for (const file of files) {
        let r: InboxResult;
        try {
          const res = await fetch(`/api/inbox?name=${encodeURIComponent(file.name)}`, {
            method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file,
          });
          const body = await res.json().catch(() => null);
          r = res.ok ? body as InboxResult : { file: file.name, ok: false, summary: body?.error ?? res.statusText };
        } catch (err) {
          r = { file: file.name, ok: false, summary: err instanceof Error ? err.message : String(err) };
        }
        setResults(prev => [r, ...prev].slice(0, 8));
      }
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['insurance'] });
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
          <span>גרור לכאן ייצוא מהר הביטוח או מהר הכסף, או</span>
          <button type="button" className="btn btn-sm" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? <><LoaderCircle className="h-3.5 w-3.5 animate-spin" /> מייבא…</> : 'בחירת קבצים'}
          </button>
          <input ref={input} type="file" multiple hidden accept=".xlsx,.csv,.zip,.xml"
            onChange={e => { if (e.target.files?.length) upload([...e.target.files]); e.target.value = ''; }} />
          <span className="text-xs">קובצי Excel או CSV. הקובץ נקרא כאן במחשב, בלי לשלוח אותו לשום מקום.</span>
        </div>
        {results.length > 0 && (
          <ul className="space-y-2 text-xs">
            {results.map((r, i) => (
              <li key={i} className="flex gap-2">
                {r.ok ? <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  : r.locked ? <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                  : <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-600" />}
                <span><span className="font-medium">{r.file}</span>{r.kind ? ` · ${r.kind}` : ''}<br />
                  <span className="text-fg-subtle">{r.summary}</span></span>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
