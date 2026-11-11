import { createStorage, StorageEnum } from '../base/index.js';
import type { Destination, Prompt, Shipment } from './dock-types.js';

const newId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

// ─── Prompts Storage ──────────────────────────────────────────────────────────

const promptsStorage = createStorage<Prompt[]>('dock-prompts', [], {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

const dockPromptsStorage = {
  ...promptsStorage,
  addPrompt: async (prompt: Omit<Prompt, 'id'>) => {
    await promptsStorage.set(prev => [...prev, { ...prompt, id: newId('prompt') }]);
  },
  updatePrompt: async (id: string, updates: Partial<Omit<Prompt, 'id'>>) => {
    await promptsStorage.set(prev => prev.map(p => (p.id === id ? { ...p, ...updates } : p)));
  },
  removePrompt: async (id: string) => {
    await promptsStorage.set(prev => prev.filter(p => p.id !== id));
  },
};

// ─── Destinations Storage ─────────────────────────────────────────────────────

const destinationsStorage = createStorage<Destination[]>('dock-destinations', [], {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

const dockDestinationsStorage = {
  ...destinationsStorage,
  addDestination: async (destination: Omit<Destination, 'id' | 'count' | 'createdAt'>): Promise<Destination> => {
    const created: Destination = { ...destination, id: newId('dest'), count: 0, createdAt: Date.now() };
    await destinationsStorage.set(prev => [...prev, created]);
    return created;
  },
  updateDestination: async (id: string, updates: Partial<Omit<Destination, 'id'>>) => {
    await destinationsStorage.set(prev => prev.map(d => (d.id === id ? { ...d, ...updates } : d)));
  },
  removeDestination: async (id: string) => {
    await destinationsStorage.set(prev => prev.filter(d => d.id !== id));
  },
};

// ─── Shipments Storage (the manifest) ─────────────────────────────────────────

const MAX_SHIPMENTS = 1000;

const shipmentsStorage = createStorage<Shipment[]>('dock-shipments', [], {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

const dockShipmentsStorage = {
  ...shipmentsStorage,
  addShipment: async (shipment: Omit<Shipment, 'id' | 'at'>) => {
    const entry: Shipment = { ...shipment, id: newId('ship'), at: Date.now() };
    await shipmentsStorage.set(prev => [...prev, entry].slice(-MAX_SHIPMENTS));
    return entry;
  },
  updateShipment: async (id: string, updates: Partial<Omit<Shipment, 'id'>>) => {
    await shipmentsStorage.set(prev => prev.map(s => (s.id === id ? { ...s, ...updates } : s)));
  },
  removeShipments: async (ids: string[]) => {
    const remove = new Set(ids);
    await shipmentsStorage.set(prev => prev.filter(s => !remove.has(s.id)));
  },
};

export { dockPromptsStorage, dockDestinationsStorage, dockShipmentsStorage };
