import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { logout, type User } from '@/lib/api';

export function SettingsDialog({ open, onOpenChange, user, onSignOut }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  user: User;
  onSignOut: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Account + preferences</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm font-medium">Account</div>
              <div className="text-xs text-muted-foreground">{user.email} · {user.plan.toUpperCase()}</div>
            </div>
            <Button variant="outline" size="sm" onClick={async () => { await logout(); onSignOut(); }}>
              Sign out
            </Button>
          </div>
          <Separator />
          <div className="text-xs text-muted-foreground">
            This is the shadcn-powered React rebuild. The old vanilla UI is still live at chadgpt-964.pages.dev.
            Modals for Usage, Founder admin, Container details, Deployments, and Change password will land in follow-up turns.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
