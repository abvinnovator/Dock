import { createStorage, StorageEnum } from '../base/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Snippet {
  id: string;
  shortcut: string; // e.g. "do/greet"
  text: string;
}

export interface Prompt {
  id: string;
  name: string;
  text: string;
}

export interface PinnedWindow {
  id?: string;
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  favicon?: string;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
  minimized?: boolean;
  mode: 'iframe' | 'companion';
}

// ─── Snippets Storage ─────────────────────────────────────────────────────────

const snippetsStorage = createStorage<Snippet[]>(
  'dock-snippets',
  [],
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

export const dockSnippetsStorage = {
  ...snippetsStorage,
  addSnippet: async (snippet: Omit<Snippet, 'id'>) => {
    const id = `snip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await snippetsStorage.set(prev => [...prev, { ...snippet, id }]);
  },
  updateSnippet: async (id: string, updates: Partial<Omit<Snippet, 'id'>>) => {
    await snippetsStorage.set(prev =>
      prev.map(s => (s.id === id ? { ...s, ...updates } : s)),
    );
  },
  removeSnippet: async (id: string) => {
    await snippetsStorage.set(prev => prev.filter(s => s.id !== id));
  },
};

// ─── Prompts Storage ──────────────────────────────────────────────────────────

const promptsStorage = createStorage<Prompt[]>(
  'dock-prompts',
  [],
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

export const dockPromptsStorage = {
  ...promptsStorage,
  addPrompt: async (prompt: Omit<Prompt, 'id'>) => {
    const id = `prompt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await promptsStorage.set(prev => [...prev, { ...prompt, id }]);
  },
  updatePrompt: async (id: string, updates: Partial<Omit<Prompt, 'id'>>) => {
    await promptsStorage.set(prev =>
      prev.map(p => (p.id === id ? { ...p, ...updates } : p)),
    );
  },
  removePrompt: async (id: string) => {
    await promptsStorage.set(prev => prev.filter(p => p.id !== id));
  },
};

// ─── Pinned Windows (Companions) Storage ──────────────────────────────────────

const pinnedWindowsStorage = createStorage<PinnedWindow[]>(
  'dock-pinned-windows',
  [],
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

export const dockPinnedWindowsStorage = {
  ...pinnedWindowsStorage,
  addPinned: async (entry: PinnedWindow) => {
    await pinnedWindowsStorage.set(prev => {
      const filtered = prev.filter(w => w.url !== entry.url);
      return [...filtered, { ...entry, id: entry.id ?? `pin_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` }];
    });
  },
  updatePinned: async (url: string, updates: Partial<PinnedWindow>) => {
    await pinnedWindowsStorage.set(prev =>
      prev.map(w => (w.url === url ? { ...w, ...updates } : w)),
    );
  },
  removePinned: async (urlOrWindowId: string | number) => {
    await pinnedWindowsStorage.set(prev =>
      prev.filter(w => w.url !== urlOrWindowId && w.windowId !== urlOrWindowId && w.id !== urlOrWindowId),
    );
  },
};

// ─── Blocked / Companion-First Sites Storage ─────────────────────────────────

export type DomainStrategy = 'companion-first' | 'normal' | 'declarative-only';

export const COMPANION_FIRST_DOMAINS = [
  'mail.google.com',
  'accounts.google.com',
  'myaccount.google.com',
  'x.com',
  'twitter.com',
  'login.microsoftonline.com',
  'web.whatsapp.com',
  'web.telegram.org',
  'discord.com',
  'slack.com',
];

export function getDomainStrategy(url: string, customBlockedList: string[] = []): DomainStrategy {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const allBlocked = [...new Set([...COMPANION_FIRST_DOMAINS, ...customBlockedList])];
    const isCompanionFirst = allBlocked.some(d => {
      const lowerD = d.toLowerCase();
      return hostname === lowerD || hostname.endsWith('.' + lowerD);
    });
    if (isCompanionFirst) {
      return 'companion-first';
    }
  } catch {
    // If URL parsing fails, default to normal
  }
  return 'normal';
}

const blockedSitesStorage = createStorage<string[]>(
  'dock-blocked-sites',
  COMPANION_FIRST_DOMAINS,
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

export const dockBlockedSitesStorage = {
  ...blockedSitesStorage,
  addBlocked: async (domain: string) => {
    const cleanDomain = domain.toLowerCase().trim();
    if (!cleanDomain) return;
    await blockedSitesStorage.set(prev => {
      if (prev.some(d => d.toLowerCase() === cleanDomain)) return prev;
      return [...prev, cleanDomain];
    });
  },
  removeBlocked: async (domain: string) => {
    const cleanDomain = domain.toLowerCase().trim();
    await blockedSitesStorage.set(prev => prev.filter(d => d.toLowerCase() !== cleanDomain));
  },
  isBlocked: async (url: string): Promise<boolean> => {
    const list = await blockedSitesStorage.get();
    return getDomainStrategy(url, list) === 'companion-first';
  },
  getStrategy: async (url: string): Promise<DomainStrategy> => {
    const list = await blockedSitesStorage.get();
    return getDomainStrategy(url, list);
  },
};


