import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api, type User } from '@/lib/api';
import { Infinity as InfinityIcon } from 'lucide-react';

interface TierBreakdown {
  daily_used: number;
  daily_limit: number | null;
  weekly_used: number;
  weekly_limit: number | null;
  monthly_used: number;
  monthly_limit: number | null;
}

interface UsageResponse {
  plan: 'free' | 'plus' | 'unlimited';
  granted_by?: string | null;
  is_founder?: boolean;
  day: string;
  week: string;
  month: string;
  resets_daily_at: string;
  resets_weekly_at: string;
  resets_monthly_at: string;
  tiers: Record<'free' | 'pro' | 'ultra', TierBreakdown>;
  account_tokens: { daily: number; monthly: number };
  lifetime_cost_usd: number;
  lifetime_calls: number;
}

function Bar({ label, used, limit, fill }: { label: string; used: number; limit: number; fill: string }) {
  const pct = Math.min(100, Math.round((100 * used) / Math.max(1, limit)));
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">{used} / {limit}</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div className="h-full transition-all" style={{ width: `${pct}%`, background: fill }} />
      </div>
    </div>
  );
}

function fillFor(pct: number) {
  if (pct >= 100) return 'hsl(0 70% 50%)';
  if (pct >= 80) return 'hsl(40 85% 50%)';
  return 'hsl(142 70% 45%)';
}

export function UsageDialog({ open, onOpenChange, user, onUpgrade, onOpenAdmin }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  user: User;
  onUpgrade: () => void;
  onOpenAdmin: () => void;
}) {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setData(null); setErr(null);
    api<UsageResponse>('/usage').then(r => {
      if (!r.ok) setErr((r.data as any)?.error || `Failed (${r.status})`);
      else setData(r.data);
    });
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Your usage</DialogTitle>
          <DialogDescription>Live from Cloudflare D1 — survives logout and device changes.</DialogDescription>
        </DialogHeader>

        {!data && !err && <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>}
        {err && <div className="py-4 text-sm text-destructive">{err}</div>}

        {data && data.plan === 'unlimited' && (
          <div className="space-y-4">
            <div className="rounded-lg p-4 text-white" style={{ background: 'linear-gradient(135deg,#4e2a8e,#8a4fd1)' }}>
              <div className="text-xs uppercase tracking-wider opacity-80">Founder grant</div>
              <div className="text-xl font-bold flex items-center gap-2 mt-1">
                <InfinityIcon className="h-5 w-5" /> Unlimited access
              </div>
              <div className="text-xs opacity-90 mt-1.5">
                Granted by {data.granted_by || 'founder'}. Every tier unlocked, no cap.
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md border p-3">
                <div className="text-xs uppercase text-muted-foreground">Cost to founder</div>
                <div className="text-lg font-mono font-bold mt-0.5">${data.lifetime_cost_usd.toFixed(4)}</div>
                <div className="text-xs text-muted-foreground mt-0.5">your lifetime burden</div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs uppercase text-muted-foreground">Calls</div>
                <div className="text-lg font-mono font-bold mt-0.5">{data.lifetime_calls.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground mt-0.5">lifetime requests</div>
              </div>
            </div>
            {data.is_founder && (
              <div className="pt-2 text-right">
                <Button onClick={onOpenAdmin} className="bg-[#4e2a8e] hover:bg-[#5e3a9e]">Founder admin</Button>
              </div>
            )}
          </div>
        )}

        {data && data.plan !== 'unlimited' && (
          <div className="space-y-4">
            <div className="flex justify-between items-baseline text-xs">
              <span><b className="text-sm">{data.plan.toUpperCase()}</b> plan</span>
              <span className="font-mono text-muted-foreground">{data.day} · {data.week} · {data.month}</span>
            </div>
            {(['free', 'pro', 'ultra'] as const).map(tier => {
              const t = data.tiers[tier];
              return (
                <div key={tier} className="space-y-2 border-b border-border/50 pb-3 last:border-0">
                  <div className="text-sm font-medium capitalize">{tier} tier</div>
                  {t.daily_limit !== null && <Bar label="Daily" used={t.daily_used} limit={t.daily_limit} fill={fillFor((100 * t.daily_used) / t.daily_limit)} />}
                  {t.weekly_limit !== null && <Bar label="Weekly" used={t.weekly_used} limit={t.weekly_limit} fill={fillFor((100 * t.weekly_used) / t.weekly_limit)} />}
                  {t.monthly_limit !== null && <Bar label="Monthly" used={t.monthly_used} limit={t.monthly_limit} fill={fillFor((100 * t.monthly_used) / t.monthly_limit)} />}
                  {t.daily_limit === null && <div className="text-xs text-muted-foreground font-mono">unlimited</div>}
                </div>
              );
            })}
            <div className="text-xs text-muted-foreground leading-relaxed">
              Account tokens today: <b className="font-mono">{data.account_tokens.daily.toLocaleString()}</b> · this month: <b className="font-mono">{data.account_tokens.monthly.toLocaleString()}</b>
            </div>
            <div className="flex justify-end gap-2">
              {data.plan === 'free' && <Button onClick={onUpgrade}>Upgrade to Plus</Button>}
              {data.is_founder && <Button onClick={onOpenAdmin} className="bg-[#4e2a8e] hover:bg-[#5e3a9e]">Founder admin</Button>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
