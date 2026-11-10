import { useSyncExternalStore } from 'react';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  messages: Message[];
  archived?: boolean;
}

interface State {
  chats: Chat[];
  activeChatId: string | null;
  model: string;
  theme: 'dark';
}

const STORAGE_KEY = 'chadgpt-react-v1';

function load(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { model: 'auto', theme: 'dark', ...JSON.parse(raw) };
  } catch {}
  return { chats: [], activeChatId: null, model: 'auto', theme: 'dark' };
}

let state: State = load();
const listeners = new Set<() => void>();

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  listeners.forEach(l => l());
}

export const store = {
  getState: () => state,
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },

  newChat(): Chat {
    const c: Chat = { id: 'c_' + Math.random().toString(36).slice(2, 10), title: 'New chat', createdAt: Date.now(), messages: [] };
    state = { ...state, chats: [c, ...state.chats], activeChatId: c.id };
    save();
    return c;
  },

  setActive(id: string | null) {
    state = { ...state, activeChatId: id };
    save();
  },

  renameChat(id: string, title: string) {
    state = { ...state, chats: state.chats.map(c => c.id === id ? { ...c, title } : c) };
    save();
  },

  archiveChat(id: string, archived = true) {
    state = { ...state, chats: state.chats.map(c => c.id === id ? { ...c, archived } : c) };
    save();
  },

  deleteChat(id: string) {
    state = {
      ...state,
      chats: state.chats.filter(c => c.id !== id),
      activeChatId: state.activeChatId === id ? null : state.activeChatId,
    };
    save();
  },

  addMessage(chatId: string, msg: Message) {
    state = {
      ...state,
      chats: state.chats.map(c => {
        if (c.id !== chatId) return c;
        const messages = [...c.messages, msg];
        // Auto-title from first user message
        const title = (c.messages.length === 0 && msg.role === 'user')
          ? msg.content.slice(0, 40) + (msg.content.length > 40 ? '…' : '')
          : c.title;
        return { ...c, messages, title };
      }),
    };
    save();
  },

  updateLastMessage(chatId: string, content: string) {
    state = {
      ...state,
      chats: state.chats.map(c => {
        if (c.id !== chatId) return c;
        const messages = c.messages.slice();
        if (messages.length) messages[messages.length - 1] = { ...messages[messages.length - 1], content };
        return { ...c, messages };
      }),
    };
    save();
  },

  setModel(model: string) {
    state = { ...state, model };
    save();
  },
};

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()), () => selector(store.getState()));
}
