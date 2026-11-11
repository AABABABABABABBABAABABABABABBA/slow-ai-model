import { useEffect, useMemo, useRef, useState } from 'react';
import { Send, Square, ChevronDown, Menu, Settings as SettingsIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { store, useStore, type Chat } from '@/lib/store';
import { MODELS, modelById } from '@/lib/models';
import { streamChat, type User } from '@/lib/api';
import { cn } from '@/lib/utils';

export function ChatView({ user, onOpenSidebar, onOpenSettings }: { user: User; onOpenSidebar: () => void; onOpenSettings: () => void }) {
  const activeId = useStore(s => s.activeChatId);
  const chats = useStore(s => s.chats);
  const modelId = useStore(s => s.model);
  const chat = useMemo(() => chats.find(c => c.id === activeId) || null, [chats, activeId]);
  const model = modelById(modelId);

  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [userScrolled, setUserScrolled] = useState(false);

  // Auto-scroll when new content arrives — but only if user is near bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || userScrolled) return;
    el.scrollTop = el.scrollHeight;
  }, [chat?.messages, userScrolled]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setUserScrolled(!near);
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;

    let c = chat;
    if (!c) c = store.newChat();
    setInput('');
    setUserScrolled(false);

    store.addMessage(c.id, { role: 'user', content: text, ts: Date.now() });
    store.addMessage(c.id, { role: 'assistant', content: '', ts: Date.now() });

    setBusy(true);
    abortRef.current = new AbortController();

    try {
      const msgs = (store.getState().chats.find(x => x.id === c!.id)?.messages || [])
        .filter(m => m.content || m.role === 'user')
        .slice(0, -1)
        .map(m => ({ role: m.role, content: m.content }));
      msgs.push({ role: 'user', content: text });

      let acc = '';
      // Batch store writes via rAF so a fast stream doesn't re-render the
      // entire chat on every token. ~60fps instead of ~hundreds of updates
      // per second shaves real latency on long replies and mobile devices.
      let scheduled = false;
      const flush = () => { store.updateLastMessage(c!.id, acc); scheduled = false; };
      for await (const chunk of streamChat(msgs, model.id, { signal: abortRef.current.signal })) {
        acc += chunk;
        if (!scheduled) {
          scheduled = true;
          requestAnimationFrame(flush);
        }
      }
      // Final flush so we never end with a trailing un-rendered chunk.
      store.updateLastMessage(c!.id, acc);
      if (!acc.trim()) store.updateLastMessage(c!.id, '_(no response — the model returned nothing)_');
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        store.updateLastMessage(c!.id, `**Error:** ${err.message || 'request failed'}`);
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function stop() { abortRef.current?.abort(); }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="h-full flex flex-col min-w-0">
      {/* Header */}
      <header className="flex items-center justify-between gap-2 border-b px-3 py-2 pt-safe bg-background/80 backdrop-blur">
        <div className="flex items-center gap-1 min-w-0">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={onOpenSidebar}>
            <Menu className="h-5 w-5" />
          </Button>
          <div className="relative">
            <Button variant="ghost" className="gap-1.5" onClick={() => setModelMenuOpen(o => !o)}>
              <span className="font-semibold">{model.name}</span>
              {model.sub && <span className="text-muted-foreground font-normal text-sm">{model.sub}</span>}
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
            {modelMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setModelMenuOpen(false)} />
                <div className="absolute left-0 top-full mt-1 z-50 w-80 bg-popover border rounded-md shadow-lg max-h-96 overflow-y-auto py-1">
                  {(['auto', 'free', 'pro', 'ultra'] as const).map(tier => {
                    const list = MODELS.filter(m => m.tier === tier);
                    if (!list.length) return null;
                    const needsPlus = (tier === 'pro' || tier === 'ultra') && user.plan === 'free';
                    return (
                      <div key={tier}>
                        <div className="px-3 pt-2 pb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          {tier === 'auto' ? 'Smart routing' : tier} {needsPlus && '(Plus)'}
                        </div>
                        {list.map(m => (
                          <button
                            key={m.id}
                            disabled={needsPlus}
                            className={cn(
                              'w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center justify-between gap-2',
                              m.id === model.id && 'bg-accent',
                              needsPlus && 'opacity-50 cursor-not-allowed'
                            )}
                            onClick={() => { store.setModel(m.id); setModelMenuOpen(false); }}
                          >
                            <span>
                              <span className="font-medium">{m.name}</span>
                              {m.sub && <span className="text-muted-foreground ml-1.5 text-xs">{m.sub}</span>}
                            </span>
                            {needsPlus && <span className="text-xs text-muted-foreground">🔒</span>}
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onOpenSettings}>
          <SettingsIcon className="h-4 w-4" />
        </Button>
      </header>

      {/* Messages */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto" style={{ WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}>
        {!chat || chat.messages.length === 0 ? (
          <EmptyState onPick={(t) => setInput(t)} />
        ) : (
          <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
            {chat.messages.map((m, i) => (
              <MessageBubble key={i} role={m.role} content={m.content} />
            ))}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t bg-background p-3 pb-safe">
        <div className="max-w-3xl mx-auto relative">
          <Textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Message ChadGPT"
            rows={1}
            className="pr-12 min-h-[44px] max-h-40"
            disabled={busy}
          />
          <Button
            size="icon"
            variant={busy ? 'destructive' : 'default'}
            className="absolute right-1.5 bottom-1.5 h-8 w-8"
            onClick={busy ? stop : send}
            disabled={!busy && !input.trim()}
          >
            {busy ? <Square className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
          </Button>
        </div>
        <div className="text-center text-xs text-muted-foreground mt-2">
          ChadGPT · running on Cloudflare Workers AI
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (t: string) => void }) {
  const prompts = ['NBA tonight', 'Lakers', 'Fortnite shop', 'Peely skin', 'Weather', 'BTC + ETH', 'JS debounce'];
  return (
    <div className="h-full flex flex-col items-center justify-center p-8 text-center">
      <h1 className="text-2xl font-semibold mb-2">What's on your mind?</h1>
      <p className="text-sm text-muted-foreground mb-8 max-w-md">
        Ask about anything. NBA, Fortnite, weather, and crypto questions get live data mixed in server-side.
      </p>
      <div className="flex flex-wrap justify-center gap-2 max-w-lg">
        {prompts.map(p => (
          <Button key={p} variant="outline" size="sm" onClick={() => onPick(p)}>{p}</Button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ role, content }: { role: 'user' | 'assistant'; content: string }) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-primary text-primary-foreground px-4 py-2 text-sm whitespace-pre-wrap">
          {content}
        </div>
      </div>
    );
  }
  return (
    <div className="max-w-full text-sm leading-relaxed whitespace-pre-wrap">
      {content || <span className="inline-block w-2 h-4 bg-foreground/50 animate-pulse" />}
    </div>
  );
}
