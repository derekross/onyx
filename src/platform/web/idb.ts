// Single IndexedDB connection shared across web adapter modules.
//
// Stores:
//   - 'settings'   : key/value for AppSettings.
//   - 'secrets'    : encrypted secrets (sealed with master passphrase).
//   - 'meta'       : misc keys (master-key salt, lock state, etc.).

import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'onyx';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

export function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings');
        }
        if (!db.objectStoreNames.contains('secrets')) {
          db.createObjectStore('secrets');
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta');
        }
      },
    });
  }
  return dbPromise;
}
