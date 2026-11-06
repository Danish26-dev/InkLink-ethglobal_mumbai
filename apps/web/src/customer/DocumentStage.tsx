import { useEffect, useRef, useState, type DragEvent } from 'react';
import { FileText, Loader2, Lock, RefreshCw, TriangleAlert, UploadCloud } from 'lucide-react';
import type { JobView } from '@inklink/shared-schemas';
import { api, errorMessage } from '../lib/api';

const ACCEPT = '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * The hero of the customer experience: the document itself.
 * Empty -> an upload surface. Uploaded -> the real document preview (PDF),
 * served by the backend through a single-use ticket, with Original / Edited.
 */
export function DocumentStage({ job, busy, locked, processing, onUpload }: {
  job: JobView;
  busy: boolean;
  locked: boolean;
  processing: boolean;
  onUpload: (file: File) => void;
}) {
  const doc = job.document;
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const drop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f && !busy && !locked) onUpload(f);
  };

  const picker = (
    <input ref={input} type="file" accept={ACCEPT} className="hidden" aria-label="Choose a PDF or DOCX"
      onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }} />
  );

  if (!doc) {
    return (
      <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={drop}
        className={`relative flex min-h-[520px] flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed p-10 text-center transition-colors ${
          drag ? 'border-signal bg-signal/5' : 'border-black/15 bg-white'
        }`}>
        {picker}
        <div className="relative mb-8 h-40 w-32" aria-hidden="true">
          <div className="absolute inset-0 translate-x-3 -translate-y-3 rotate-6 rounded-md border border-black/10 bg-paper" />
          <div className="absolute inset-0 flex flex-col gap-2 rounded-md border border-black/10 bg-white p-4 shadow-[0_20px_40px_-24px_rgba(17,17,17,0.6)]">
            <div className="h-2 w-2/3 rounded-sm bg-signal" />
            {[90, 75, 85, 60, 80].map((w) => <div key={w} className="h-1.5 rounded-sm bg-ink/10" style={{ width: `${w}%` }} />)}
          </div>
        </div>
        <h2 className="text-2xl font-semibold tracking-tight">Drop your document here</h2>
        <p className="mt-2 max-w-sm text-sm text-graphite">PDF or Word (DOCX), up to 25 MB. It is checked for sensitive content on the shop's server before any AI sees it.</p>
        <button type="button" className="btn-primary mt-6 px-6 py-2.5" disabled={busy || locked} onClick={() => input.current?.click()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" aria-hidden="true" />}
          {busy ? 'Uploading…' : 'Choose a file'}
        </button>
      </div>
    );
  }

  return (
    <div onDragOver={(e) => { e.preventDefault(); if (!locked) setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={drop}
      className={`flex min-h-[560px] flex-col overflow-hidden rounded-2xl border bg-[#E9E9E5] ${drag ? 'border-signal' : 'border-light-grey'}`}>
      {picker}
      <div className="flex flex-wrap items-center gap-3 border-b border-black/10 bg-white px-4 py-3">
        <FileText className="h-5 w-5 text-signal" aria-hidden="true" />
        <div className="min-w-[160px] flex-1">
          <p className="truncate text-sm font-medium">{doc.filename}</p>
          <p className="font-mono text-[11px] text-graphite">{doc.format.toUpperCase()} · {doc.pageCount ?? '?'} pages · {(doc.size / 1024).toFixed(0)} KB</p>
        </div>
        <Sensitivity doc={doc} />
        {!locked && (
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" disabled={busy || processing} onClick={() => input.current?.click()}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Replace
          </button>
        )}
      </div>
      <Preview job={job} processing={processing} />
    </div>
  );
}

function Sensitivity({ doc }: { doc: NonNullable<JobView['document']> }) {
  const c = doc.classification;
  if (!c) return null;
  const text = c.level === 'non_sensitive' ? 'No sensitive content' : c.level === 'sensitive' ? `Sensitive · ${c.categories.join(', ')}` : 'Unclassified';
  return (
    <span title={c.reason} className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] ${c.level === 'non_sensitive' ? 'bg-paper text-ink/70' : 'bg-ink text-paper'}`}>
      <Lock className="h-3 w-3" aria-hidden="true" />{text}
    </span>
  );
}

function Preview({ job, processing }: { job: JobView; processing: boolean }) {
  const doc = job.document!;
  const hasEdit = doc.edited && doc.editStatus !== 'rejected';
  const [version, setVersion] = useState<'original' | 'current'>(hasEdit ? 'current' : 'original');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasEdit && version === 'current') setVersion('original');
  }, [hasEdit, version]);

  useEffect(() => {
    if (!doc.available || doc.format !== 'pdf') return;
    let alive = true;
    setUrl(null);
    setError(null);
    // Fresh single-use ticket per version; the bearer token never goes into a URL.
    api.documentUrl(job.jobId, version).then((u) => alive && setUrl(u), (e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [job.jobId, doc.documentId, doc.available, doc.format, version, doc.editStatus]);

  return (
    <div className="relative flex flex-1 flex-col">
      {hasEdit && (
        <div role="tablist" aria-label="Document version" className="flex gap-1 border-b border-black/10 bg-white/70 px-4 py-2">
          {(['original', 'current'] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={version === v} onClick={() => setVersion(v)}
              className={`rounded-full px-3 py-1 text-xs ${version === v ? 'bg-ink text-paper' : 'text-ink/70 hover:bg-light-grey'}`}>
              {v === 'original' ? 'Original' : 'Edited by the operator'}
            </button>
          ))}
          <span className="ml-auto self-center text-[11px] text-graphite">Your original file is never changed.</span>
        </div>
      )}
      <div className="relative flex flex-1 items-stretch justify-center p-4">
        {!doc.available ? (
          <Placeholder text="This document was deleted under the shop's retention policy." />
        ) : doc.format !== 'pdf' ? (
          <Placeholder text="Word documents can't be previewed in the browser. The page count and settings still apply." doc />
        ) : error ? (
          <Placeholder text={error} warn />
        ) : !url ? (
          <div className="flex items-center gap-2 text-sm text-graphite"><Loader2 className="h-4 w-4 animate-spin" />Loading preview…</div>
        ) : (
          <iframe key={url} src={`${url}#toolbar=0&navpanes=0&view=FitH`} title={`Preview of ${doc.filename}`}
            className="h-[640px] w-full max-w-[820px] rounded-sm bg-white shadow-[0_24px_60px_-30px_rgba(17,17,17,0.6)]" />
        )}
        {processing && (
          // Shown only while the backend reports a run in progress.
          <div className="pointer-events-none absolute inset-4 overflow-hidden rounded-sm" aria-hidden="true">
            <div className="scan-line absolute inset-x-0 h-24 bg-gradient-to-b from-transparent via-signal/15 to-transparent" />
          </div>
        )}
      </div>
    </div>
  );
}

function Placeholder({ text, warn, doc }: { text: string; warn?: boolean; doc?: boolean }) {
  return (
    <div className="flex w-full max-w-[560px] flex-col items-center justify-center gap-3 self-center rounded-sm bg-white p-10 text-center shadow-[0_24px_60px_-30px_rgba(17,17,17,0.6)]">
      {warn ? <TriangleAlert className="h-6 w-6 text-signal" aria-hidden="true" /> : <FileText className={`h-10 w-10 ${doc ? 'text-signal' : 'text-graphite'}`} aria-hidden="true" />}
      <p className="text-sm text-graphite">{text}</p>
    </div>
  );
}
