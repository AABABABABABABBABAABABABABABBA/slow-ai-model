import { useEffect, useState } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { Sidebar } from '@/components/Sidebar';
import { ChatView } from '@/components/ChatView';
import { SettingsDialog } from '@/components/SettingsDialog';
import { UsageDialog } from '@/components/UsageDialog';
import { FounderAdminDialog } from '@/components/FounderAdminDialog';
import { DeploymentsDialog } from '@/components/DeploymentsDialog';
import { ToastHost, toast } from '@/components/ui/toast';
import { me, type User } from '@/lib/api';
import { cn } from '@/lib/utils';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [deploysOpen, setDeploysOpen] = useState(false);

  useEffect(() => {
    me().then(u => { setUser(u); setLoading(false); });
  }, []);

  if (loading) {
    return (
      <>
        <div className="h-full flex items-center justify-center text-muted-foreground">Loading…</div>
        <ToastHost />
      </>
    );
  }
  if (!user) {
    return (
      <>
        <AuthGate onAuthed={u => { setUser(u); toast('Signed in', 'ok'); }} />
        <ToastHost />
      </>
    );
  }

  return (
    <div className="h-full flex">
      <div className="hidden md:block w-64 shrink-0">
        <Sidebar
          onOpenDeploys={user.plan === 'plus' || user.plan === 'unlimited' ? () => setDeploysOpen(true) : undefined}
        />
      </div>

      {sidebarOpen && (
        <>
          <div className="md:hidden fixed inset-0 z-40 bg-black/50" onClick={() => setSidebarOpen(false)} />
          <div className={cn('md:hidden fixed inset-y-0 left-0 z-50 w-72 transition-transform')}>
            <Sidebar
              onClose={() => setSidebarOpen(false)}
              onOpenDeploys={user.plan === 'plus' || user.plan === 'unlimited' ? () => setDeploysOpen(true) : undefined}
            />
          </div>
        </>
      )}

      <div className="flex-1 min-w-0">
        <ChatView
          user={user}
          onOpenSidebar={() => setSidebarOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenUsage={() => setUsageOpen(true)}
        />
      </div>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        user={user}
        onSignOut={() => { setUser(null); setSettingsOpen(false); toast('Signed out'); }}
      />
      <UsageDialog
        open={usageOpen}
        onOpenChange={setUsageOpen}
        user={user}
        onUpgrade={() => { setUsageOpen(false); toast('Upgrade flow — ask the founder for an unlimited grant for now', 'info'); }}
        onOpenAdmin={() => { setUsageOpen(false); setAdminOpen(true); }}
      />
      <FounderAdminDialog
        open={adminOpen}
        onOpenChange={setAdminOpen}
      />
      <DeploymentsDialog
        open={deploysOpen}
        onOpenChange={setDeploysOpen}
      />
      <ToastHost />
      {/* hidden trigger — can wire this to a sidebar menu later */}
      <button hidden onClick={() => setDeploysOpen(true)} />
    </div>
  );
}
