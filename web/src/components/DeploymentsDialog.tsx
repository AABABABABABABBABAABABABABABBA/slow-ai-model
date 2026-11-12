import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ExternalLink, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/toast';

interface Deployment {
  id: number;
  script_name: string;
  slug: string;
  url: string | null;
  size_bytes: number;
  created_at: number;
  updated_at: number;
}

export function DeploymentsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [deployments, setDeployments] = useState<Deployment[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!open) return;
    setErr(null); setDeployments(null);
    api<{ deployments: Deployment[] }>('/deployments').then(r => {
      if (!r.ok) setErr((r.data as any)?.error || `Failed (${r.status})`);
      else setDeployments(r.data.deployments);
    });
  }, [open, tick]);

  async function del(name: string) {
    if (!confirm(`Delete ${name}? Removes it from Cloudflare + the database.`)) return;
    const r = await api(`/deployments?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (r.ok) { toast('Deleted', 'ok'); setTick(t => t + 1); }
    else toast('Delete failed', 'err');
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>My deployments</DialogTitle>
          <DialogDescription>24/7 Worker apps you've shipped with the <b>☁ Deploy</b> button.</DialogDescription>
        </DialogHeader>

        {err && <div className="text-sm text-destructive p-3">{err}</div>}
        {!deployments && !err && <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>}

        {deployments && deployments.length === 0 && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            None yet. Ask ChadGPT to write some JS/TS, then click the <b>☁ Deploy 24/7</b> button on the code block.
          </div>
        )}

        {deployments && deployments.length > 0 && (
          <div className="max-h-96 overflow-y-auto border rounded-md divide-y">
            {deployments.map(d => (
              <div key={d.id} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium text-sm">{d.slug}</div>
                  <div className="text-xs text-muted-foreground font-mono truncate">
                    {d.url || '(url pending)'}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {(d.size_bytes / 1024).toFixed(1)} KB · {new Date(d.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  {d.url && (
                    <Button size="sm" variant="outline" asChild>
                      <a href={d.url} target="_blank" rel="noopener noreferrer" className="gap-1">
                        <ExternalLink className="h-3 w-3" /> Open
                      </a>
                    </Button>
                  )}
                  <Button size="sm" variant="destructive" onClick={() => del(d.script_name)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="text-xs text-muted-foreground mt-2">
          Max 10 deployments per user. Each runs 24/7 on Cloudflare's edge, free.
        </div>
      </DialogContent>
    </Dialog>
  );
}
