import { useEffect, useState, useCallback } from 'react';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ToastKind = 'ok' | 'err' | 'warn' | 'info';
export interface ToastItem {
  id: number;
  title: string;
  sub?: string;
  kind: ToastKind;
  timeoutMs: number;
}

const bus = new EventTarget();
let nextId = 1;

export function toast(title: string, kind: ToastKind = 'info', opts: { sub?: string; timeoutMs?: number } = {}) {
  bus.dispatchEvent(new CustomEvent('toast', {
    detail: { id: nextId++, title, sub: opts.sub, kind, timeoutMs: opts.timeoutMs ?? 3000 } as ToastItem,
  }));
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems(list => list.filter(t => t.id !== id)), []);

  useEffect(() => {
    const onToast = (e: Event) => {
      const t = (e as CustomEvent<ToastItem>).detail;
      setItems(list => [...list, t]);
      if (t.timeoutMs > 0) {
        window.setTimeout(() => dismiss(t.id), t.timeoutMs);
      }
    };
    bus.addEventListener('toast', onToast);
    return () => bus.removeEventListener('toast', onToast);
  }, [dismiss]);

  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 max-w-sm pt-safe">
      {items.map(t => (
        <div
          key={t.id}
          className={cn(
            'flex gap-3 items-start rounded-lg border bg-card text-card-foreground shadow-lg px-4 py-3 text-sm animate-in slide-in-from-right-5',
            t.kind === 'ok' && 'border-green-600/40',
            t.kind === 'err' && 'border-destructive/50',
            t.kind === 'warn' && 'border-yellow-600/40',
          )}
        >
          {t.kind === 'ok' && <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />}
          {t.kind === 'err' && <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />}
          {t.kind === 'warn' && <AlertCircle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />}
          <div className="flex-1 min-w-0">
            <div className="font-medium">{t.title}</div>
            {t.sub && <div className="text-xs text-muted-foreground mt-0.5">{t.sub}</div>}
          </div>
          <button onClick={() => dismiss(t.id)} className="text-muted-foreground hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
