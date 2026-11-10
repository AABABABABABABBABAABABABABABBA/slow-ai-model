import { useState, useMemo } from 'react';
import { MessageSquarePlus, Search, Archive, Trash2, MoreHorizontal, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { store, useStore, type Chat } from '@/lib/store';
import { cn } from '@/lib/utils';

function groupByAge(chats: Chat[]) {
  const now = Date.now();
  const g: Record<string, Chat[]> = { Today: [], Yesterday: [], 'Previous 7 days': [], 'Previous 30 days': [], Older: [] };
  for (const c of chats) {
    const age = now - c.createdAt;
    if (age < 86400000) g.Today.push(c);
    else if (age < 2 * 86400000) g.Yesterday.push(c);
    else if (age < 7 * 86400000) g['Previous 7 days'].push(c);
    else if (age < 30 * 86400000) g['Previous 30 days'].push(c);
    else g.Older.push(c);
  }
  return g;
}

export function Sidebar({ onClose }: { onClose?: () => void }) {
  const chats = useStore(s => s.chats);
  const active = useStore(s => s.activeChatId);
  const [q, setQ] = useState('');
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const query = q.trim().toLowerCase();
  const matches = (c: Chat) => !query || (c.title + ' ' + c.messages.map(m => m.content).join(' ')).toLowerCase().includes(query);

  const activeChats = useMemo(() => chats.filter(c => !c.archived && matches(c)), [chats, query]);
  const archived = useMemo(() => chats.filter(c => c.archived && matches(c)), [chats, query]);
  const groups = groupByAge(activeChats);

  function startEdit(c: Chat) { setEditingId(c.id); setEditValue(c.title); }
  function commitEdit() {
    if (editingId && editValue.trim()) store.renameChat(editingId, editValue.trim());
    setEditingId(null);
  }

  function row(c: Chat, isArchived = false) {
    const editing = editingId === c.id;
    return (
      <div
        key={c.id}
        className={cn(
          'group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm mx-2 cursor-pointer transition-colors',
          c.id === active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
          isArchived && 'opacity-60'
        )}
        onClick={() => { if (editing) return; store.setActive(c.id); onClose?.(); }}
      >
        {editing ? (
          <Input
            autoFocus
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditingId(null); }}
            onClick={e => e.stopPropagation()}
            className="h-6 text-sm"
          />
        ) : (
          <span
            className="flex-1 truncate"
            onDoubleClick={e => { e.stopPropagation(); startEdit(c); }}
            title={c.title}
          >
            {c.title}
          </span>
        )}
        {!editing && (
          <div className="opacity-0 group-hover:opacity-100 transition-opacity flex gap-0.5 md:flex" style={{ opacity: window.matchMedia('(hover: none)').matches ? 1 : undefined }}>
            {isArchived ? (
              <>
                <Button size="icon" variant="ghost" className="h-6 w-6" onClick={e => { e.stopPropagation(); store.archiveChat(c.id, false); }} title="Restore">
                  <Archive className="h-3 w-3" />
                </Button>
                <Button size="icon" variant="ghost" className="h-6 w-6 hover:text-destructive" onClick={e => { e.stopPropagation(); if (confirm(`Delete "${c.title}"? Can't be undone.`)) store.deleteChat(c.id); }} title="Delete">
                  <Trash2 className="h-3 w-3" />
                </Button>
              </>
            ) : (
              <>
                <Button size="icon" variant="ghost" className="h-6 w-6" onClick={e => { e.stopPropagation(); store.archiveChat(c.id, true); }} title="Archive">
                  <Archive className="h-3 w-3" />
                </Button>
                <Button size="icon" variant="ghost" className="h-6 w-6" onClick={e => { e.stopPropagation(); startEdit(c); }} title="Rename">
                  <MoreHorizontal className="h-3 w-3" />
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <aside className="h-full flex flex-col bg-card border-r pt-safe">
      <div className="p-3 flex items-center justify-between gap-2">
        <div className="font-semibold text-sm">ChadGPT</div>
        <Button size="sm" variant="secondary" onClick={() => { store.newChat(); onClose?.(); }} className="gap-1.5">
          <MessageSquarePlus className="h-4 w-4" />
          New
        </Button>
      </div>
      <div className="px-3 pb-2 relative">
        <Search className="absolute left-5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search chats" className="h-8 pl-8 text-sm" />
      </div>
      <Separator />
      <div className="flex-1 overflow-y-auto py-2" style={{ WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}>
        {Object.entries(groups).map(([label, chats]) =>
          chats.length ? (
            <div key={label}>
              <div className="px-4 pt-3 pb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</div>
              {chats.map(c => row(c))}
            </div>
          ) : null
        )}
        {!activeChats.length && query && (
          <div className="px-4 py-6 text-sm text-muted-foreground text-center">No matches for "{query}"</div>
        )}
        {(archived.length > 0 || chats.some(c => c.archived)) && (
          <>
            <button
              className={cn(
                'w-full flex items-center gap-2 px-4 pt-4 pb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors',
                archiveOpen && 'text-foreground'
              )}
              onClick={() => setArchiveOpen(o => !o)}
            >
              <ChevronRight className={cn('h-3 w-3 transition-transform', archiveOpen && 'rotate-90')} />
              <span className="flex-1 text-left">Archive ({archived.length})</span>
              {archived.length > 0 && (
                <span
                  className="hover:text-destructive"
                  onClick={e => {
                    e.stopPropagation();
                    if (!confirm(`Delete all ${archived.length} archived chat(s)?`)) return;
                    archived.forEach(c => store.deleteChat(c.id));
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </span>
              )}
            </button>
            {archiveOpen && (archived.length ? archived.map(c => row(c, true)) : (
              <div className="px-4 py-3 text-sm text-muted-foreground italic">Nothing archived</div>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
