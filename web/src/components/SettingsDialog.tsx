import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { api, logout, type User } from '@/lib/api';
import { store } from '@/lib/store';
import { toast } from '@/components/ui/toast';

function newNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function SettingsDialog({ open, onOpenChange, user, onSignOut }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  user: User;
  onSignOut: () => void;
}) {
  const [showChangePw, setShowChangePw] = useState(false);
  const [cur, setCur] = useState('');
  const [nxt, setNxt] = useState('');
  const [cnf, setCnf] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function changePassword() {
    setErr(null);
    if (!cur || !nxt) { setErr('Fill both password fields.'); return; }
    if (nxt.length < 8) { setErr('New password must be at least 8 characters.'); return; }
    if (nxt !== cnf) { setErr('Confirmation does not match.'); return; }
    setBusy(true);
    const r = await api('/password', {
      method: 'POST',
      body: JSON.stringify({ current_password: cur, new_password: nxt, nonce: newNonce() }),
    });
    setBusy(false);
    if (!r.ok) { setErr((r.data as any)?.error || `Failed (${r.status})`); return; }
    toast('Password changed', 'ok');
    setCur(''); setNxt(''); setCnf('');
    setShowChangePw(false);
  }

  async function clearChats() {
    if (!confirm('Delete every chat in this browser? This can\'t be undone.')) return;
    const { chats } = store.getState();
    chats.forEach(c => store.deleteChat(c.id));
    toast('All chats deleted', 'ok');
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Account + preferences</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center justify-between py-2">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{user.email}</div>
              <div className="text-xs text-muted-foreground">Plan: {user.plan.toUpperCase()}</div>
            </div>
            <Button variant="outline" size="sm" onClick={async () => { await logout(); onSignOut(); }}>
              Sign out
            </Button>
          </div>

          <Separator />

          {!showChangePw ? (
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">Password</div>
                <div className="text-xs text-muted-foreground">Change your account password.</div>
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowChangePw(true)}>Change</Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-sm font-medium">Change password</div>
              <Input type="password" placeholder="Current password" value={cur} onChange={e => setCur(e.target.value)} autoComplete="current-password" />
              <Input type="password" placeholder="New password (min 8)" value={nxt} onChange={e => setNxt(e.target.value)} autoComplete="new-password" />
              <Input type="password" placeholder="Confirm new password" value={cnf} onChange={e => setCnf(e.target.value)} autoComplete="new-password" />
              {err && <div className="text-xs text-destructive">{err}</div>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => { setShowChangePw(false); setErr(null); }}>Cancel</Button>
                <Button size="sm" onClick={changePassword} disabled={busy}>{busy ? '…' : 'Save'}</Button>
              </div>
            </div>
          )}

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Clear all chats</div>
              <div className="text-xs text-muted-foreground">Removes every chat from this browser.</div>
            </div>
            <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={clearChats}>
              Clear
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
