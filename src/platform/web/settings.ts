import type { AppSettings, Settings } from '../types';
import { getDB } from './idb';

const KEY = 'app';

export const settings: Settings = {
  async load(): Promise<AppSettings> {
    const db = await getDB();
    const stored = (await db.get('settings', KEY)) as AppSettings | undefined;
    if (stored) return stored;
    return { vault_path: null, show_terminal: false };
  },
  async save(value): Promise<void> {
    const db = await getDB();
    await db.put('settings', value, KEY);
  },
};
