import { useEffect, useState } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { Sidebar } from '@/components/Sidebar';
import { ChatView } from '@/components/ChatView';
import { SettingsDialog } from '@/components/SettingsDialog';
import { me, type User } from '@/lib/api';
import { cn } from '@/lib/utils';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    me().then(u => { setUser(u); setLoading(false); });
  }, []);

  if (loading) {
    return <div className="h-full flex items-center justify-center text-muted-foreground">Loading…</div>;
  }
  if (!user) {
    return <AuthGate onAuthed={setUser} />;
  }

  return (
    <div className="h-full flex">
      {/* Desktop sidebar */}
      <div className="hidden md:block w-64 shrink-0">
        <Sidebar />
      </div>

      {/* Mobile sidebar as overlay */}
      {sidebarOpen && (
        <>
          <div
            className="md:hidden fixed inset-0 z-40 bg-black/50"
            onClick={() => setSidebarOpen(false)}
          />
          <div className={cn('md:hidden fixed inset-y-0 left-0 z-50 w-72 transition-transform')}>
            <Sidebar onClose={() => setSidebarOpen(false)} />
          </div>
        </>
      )}

      <div className="flex-1 min-w-0">
        <ChatView
          user={user}
          onOpenSidebar={() => setSidebarOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </div>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        user={user}
        onSignOut={() => { setUser(null); setSettingsOpen(false); }}
      />
    </div>
  );
}
