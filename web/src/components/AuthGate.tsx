import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { login, signup, type User } from '@/lib/api';

export function AuthGate({ onAuthed }: { onAuthed: (u: User) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const user = mode === 'login' ? await login(email, password) : await signup(email, password);
      onAuthed(user);
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full flex items-center justify-center p-4 pt-safe">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">
            {mode === 'login' ? 'Sign in to ChadGPT' : 'Create an account'}
          </CardTitle>
          <CardDescription>
            {mode === 'login' ? 'Enter your email below to sign in.' : 'All free-tier models. No limits.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Email</label>
              <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required autoComplete="email" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Password</label>
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="•••••••" required minLength={8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
            </div>
            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-sm p-3">
                {error}
              </div>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
            <div className="text-center text-sm text-muted-foreground">
              {mode === 'login' ? "Don't have an account? " : 'Already have one? '}
              <button type="button" className="text-primary hover:underline" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null); }}>
                {mode === 'login' ? 'Sign up' : 'Sign in'}
              </button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
