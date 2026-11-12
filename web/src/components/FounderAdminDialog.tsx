import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { Shield, Users, AlertTriangle } from 'lucide-react';

function newNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

interface AdminUser {
  id: number;
  email: string;
  plan: 'free' | 'plus' | 'unlimited';
  granted_by?: string | null;
  banned: boolean;
  muted: boolean;
  blocked_models: string[];
  moderation_note?: string | null;
  cost_usd: number;
  calls: number;
  tokens: number;
}

interface UsersResponse {
  users: AdminUser[];
  totals: {
    user_count: number;
    total_cost_usd: number;
    founder_burden_usd: number;
    granted_count: number;
  };
}

interface BypassResponse {
  shared_fingerprints: { fp_hash: string; user_count: number; emails: string[] }[];
  recent_signups_last_hour: { email: string; created_at: number }[];
  multi_device_users: { email: string; devices: number }[];
  heaviest_today: { email: string; plan: string; calls: number; tokens: number }[];
}

type Tab = 'users' | 'bypass';

export function FounderAdminDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [tab, setTab] = useState<Tab>('users');
  const [users, setUsers] = useState<UsersResponse | null>(null);
  const [bypass, setBypass] = useState<BypassResponse | null>(null);
  const [managing, setManaging] = useState<AdminUser | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const reload = () => setReloadTick(t => t + 1);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    if (tab === 'users') {
      api<UsersResponse>('/admin/users').then(r => {
        if (!r.ok) setErr((r.data as any)?.error || `Failed (${r.status})`);
        else setUsers(r.data);
      });
    } else {
      api<BypassResponse>('/admin/bypass').then(r => {
        if (!r.ok) setErr((r.data as any)?.error || `Failed (${r.status})`);
        else setBypass(r.data);
      });
    }
  }, [open, tab, reloadTick]);

  async function moderate(email: string, action: string, extra: Record<string, unknown> = {}) {
    const r = await api('/admin/moderate', { method: 'POST', body: JSON.stringify({ email, action, nonce: newNonce(), ...extra }) });
    if (!r.ok) toast((r.data as any)?.error || 'Failed', 'err');
    else { toast(`Done — ${action}`, 'ok'); reload(); }
  }
  async function grant(email: string, plan: 'free' | 'plus' | 'unlimited') {
    const r = await api('/admin/grant', { method: 'POST', body: JSON.stringify({ email, plan, nonce: newNonce() }) });
    if (!r.ok) toast((r.data as any)?.error || 'Failed', 'err');
    else { toast(`${email} → ${plan}`, 'ok'); reload(); }
  }
  async function blockFp(fpHash: string) {
    if (!confirm(`Block fingerprint ${fpHash.slice(0, 16)}… — every user sharing it will be refused on next request.`)) return;
    const r = await api('/admin/block-device', { method: 'POST', body: JSON.stringify({ fp_hash: fpHash }) });
    if (!r.ok) toast('Block failed', 'err');
    else { toast('Blocked', 'ok'); reload(); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Founder admin</DialogTitle>
          <DialogDescription>Per-user controls + abuse-signal watch</DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 border-b pb-2 mb-2">
          <Button size="sm" variant={tab === 'users' ? 'secondary' : 'ghost'} onClick={() => setTab('users')} className="gap-1.5">
            <Users className="h-3.5 w-3.5" /> Users
          </Button>
          <Button size="sm" variant={tab === 'bypass' ? 'secondary' : 'ghost'} onClick={() => setTab('bypass')} className="gap-1.5">
            <Shield className="h-3.5 w-3.5" /> Bypass watch
          </Button>
        </div>

        {err && <div className="text-sm text-destructive p-3">{err}</div>}

        {tab === 'users' && users && (
          <>
            <div className="grid grid-cols-4 gap-2 mb-3">
              <Stat label="Users" val={users.totals.user_count} />
              <Stat label="Unlimited" val={users.totals.granted_count} />
              <Stat label="Total cost" val={`$${users.totals.total_cost_usd.toFixed(4)}`} />
              <Stat label="Your burden" val={`$${users.totals.founder_burden_usd.toFixed(4)}`} />
            </div>
            <div className="max-h-96 overflow-y-auto border rounded-md">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted">
                  <tr className="text-left text-xs uppercase text-muted-foreground">
                    <th className="p-2">Email</th>
                    <th className="p-2">Plan</th>
                    <th className="p-2 text-right">Cost</th>
                    <th className="p-2 text-right">Calls</th>
                    <th className="p-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {users.users.map(u => (
                    <tr key={u.id} className={`border-b border-border/50 ${u.banned ? 'opacity-50' : ''}`}>
                      <td className="p-2">
                        <span className="font-medium">{u.email}</span>
                        {u.banned && <span className="ml-1 text-[10px] rounded px-1 py-0.5 bg-destructive/20 text-destructive">BANNED</span>}
                        {u.muted && <span className="ml-1 text-[10px] rounded px-1 py-0.5 bg-yellow-500/20 text-yellow-500">MUTED</span>}
                      </td>
                      <td className="p-2">
                        <PlanBadge plan={u.plan} />
                      </td>
                      <td className="p-2 text-right font-mono text-xs">${u.cost_usd.toFixed(4)}</td>
                      <td className="p-2 text-right font-mono text-xs">{u.calls}</td>
                      <td className="p-2 text-right">
                        <Button size="sm" onClick={() => setManaging(u)}>Manage</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'bypass' && bypass && (
          <div className="space-y-5 max-h-[520px] overflow-y-auto">
            <Section title="Shared fingerprints" icon={<AlertTriangle className="h-4 w-4 text-destructive" />} hint="Same device across multiple accounts = account farming.">
              {bypass.shared_fingerprints.length === 0 ? (
                <div className="text-xs text-muted-foreground">None detected.</div>
              ) : bypass.shared_fingerprints.map(f => (
                <div key={f.fp_hash} className="flex justify-between items-start p-2 rounded border text-xs mb-1">
                  <div>
                    <div className="font-mono">{f.fp_hash.slice(0, 16)}…</div>
                    <div className="text-muted-foreground mt-0.5">{f.emails.join(', ')} · {f.user_count} accounts</div>
                  </div>
                  <Button size="sm" variant="destructive" onClick={() => blockFp(f.fp_hash)}>Block</Button>
                </div>
              ))}
            </Section>
            <Section title="Recent signups (last hour)">
              {bypass.recent_signups_last_hour.length === 0 ? (
                <div className="text-xs text-muted-foreground">None.</div>
              ) : bypass.recent_signups_last_hour.map(u => (
                <div key={u.email} className="flex justify-between text-xs py-1 border-b border-border/50 last:border-0">
                  <span>{u.email}</span>
                  <span className="text-muted-foreground">{new Date(u.created_at).toLocaleTimeString()}</span>
                </div>
              ))}
            </Section>
            <Section title="Multi-device users (3+ fingerprints)">
              {bypass.multi_device_users.length === 0 ? (
                <div className="text-xs text-muted-foreground">None.</div>
              ) : bypass.multi_device_users.map(u => (
                <div key={u.email} className="flex justify-between text-xs py-1 border-b border-border/50 last:border-0">
                  <span>{u.email}</span>
                  <span className="font-mono text-muted-foreground">{u.devices} devices</span>
                </div>
              ))}
            </Section>
            <Section title="Heaviest users today">
              {bypass.heaviest_today.length === 0 ? (
                <div className="text-xs text-muted-foreground">No activity yet.</div>
              ) : bypass.heaviest_today.map(u => (
                <div key={u.email} className="flex justify-between text-xs py-1 border-b border-border/50 last:border-0">
                  <span>{u.email} <PlanBadge plan={u.plan as any} /></span>
                  <span className="font-mono text-muted-foreground">{u.calls} calls · {(u.tokens / 1000).toFixed(1)}k tokens</span>
                </div>
              ))}
            </Section>
          </div>
        )}

        {managing && (
          <ManageUserSheet
            user={managing}
            onClose={() => setManaging(null)}
            onGrant={plan => grant(managing.email, plan)}
            onModerate={(action, extra) => moderate(managing.email, action, extra)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, val }: { label: string; val: string | number }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-[10px] uppercase text-muted-foreground tracking-wider">{label}</div>
      <div className="text-base font-bold font-mono">{val}</div>
    </div>
  );
}

function PlanBadge({ plan }: { plan: 'free' | 'plus' | 'unlimited' }) {
  const color = plan === 'unlimited' ? '#9b6bd8' : plan === 'plus' ? '#2e7d32' : 'hsl(var(--muted-foreground))';
  return <span className="text-xs font-semibold" style={{ color }}>{plan.toUpperCase()}</span>;
}

function Section({ title, icon, hint, children }: { title: string; icon?: React.ReactNode; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      </div>
      {hint && <div className="text-xs text-muted-foreground mb-2">{hint}</div>}
      {children}
    </div>
  );
}

function ManageUserSheet({ user, onClose, onGrant, onModerate }: {
  user: AdminUser;
  onClose: () => void;
  onGrant: (plan: 'free' | 'plus' | 'unlimited') => void;
  onModerate: (action: string, extra?: Record<string, unknown>) => void;
}) {
  const [note, setNote] = useState(user.moderation_note || '');

  function confirmAnd(msg: string, fn: () => void) {
    if (confirm(msg)) fn();
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border rounded-lg p-5 max-w-md w-full max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="text-sm font-medium mb-1">{user.email}</div>
        <div className="text-xs text-muted-foreground font-mono mb-4">
          {user.plan.toUpperCase()} · {user.calls} calls · ${user.cost_usd.toFixed(4)}
          {user.granted_by && ` · granted by ${user.granted_by}`}
        </div>

        <div className="text-xs font-semibold uppercase text-muted-foreground mb-2">Plan</div>
        <div className="flex gap-2 mb-4">
          {(['free', 'plus', 'unlimited'] as const).map(p => (
            <Button key={p} size="sm" variant={user.plan === p ? 'secondary' : 'default'} onClick={() => confirmAnd(`Set ${user.email} to ${p}?`, () => onGrant(p))}>
              {p}
            </Button>
          ))}
        </div>

        <div className="text-xs font-semibold uppercase text-muted-foreground mb-2">Moderation</div>
        <div className="grid grid-cols-2 gap-2 mb-4">
          <Button size="sm" variant="destructive" onClick={() => confirmAnd(user.banned ? 'Unban?' : 'Ban?', () => onModerate(user.banned ? 'unban' : 'ban', { note }))}>
            {user.banned ? 'Unban' : 'Ban'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => confirmAnd(user.muted ? 'Unmute?' : 'Mute (block sending)?', () => onModerate(user.muted ? 'unmute' : 'mute', { note }))}>
            {user.muted ? 'Unmute' : 'Mute'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => confirmAnd('Reset usage counters?', () => onModerate('reset_usage'))}>
            Reset usage
          </Button>
          <Button size="sm" variant="destructive" onClick={() => confirmAnd('Delete ALL chats + container?', () => onModerate('delete_chats'))}>
            Delete chats
          </Button>
        </div>

        <div className="text-xs font-semibold uppercase text-muted-foreground mb-2">Moderation note</div>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="Shown to user on refusal"
          rows={2}
          className="w-full text-sm rounded-md border bg-background p-2 mb-2"
        />
        <div className="flex justify-between">
          <Button size="sm" variant="outline" onClick={() => onModerate('set_note', { value: note })}>Save note</Button>
          <Button size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
