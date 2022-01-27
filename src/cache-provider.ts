import type { Cache } from 'swr'
import { openDB } from 'idb'

import type { TCacheProvider, TConfig } from './types'
import simpleStorageHandler from './storage-handler/simple'

type TKey = string

/**
 * Cache provider factory
 */
export default async function createCacheProvider<Data = any, Error = any>({
  dbName,
  storeName,
  storageHandler = simpleStorageHandler,
  version = 1,
}: TConfig): Promise<TCacheProvider> {
  type TValue = Data | Error
  type TCache = Cache<TValue>

  // Initialize database
  const db = await openDB(dbName, version, {
    upgrade: (upgradeDb, ...rest) => {
      const objectStore = upgradeDb.createObjectStore(storeName)

      storageHandler.upgradeObjectStore?.(objectStore, ...rest)
    }
  })

  // Get storage snapshot
  const map = new Map<TKey, TValue>()

  let cursor = await db.transaction(storeName).store.openCursor()

  while (cursor) {
    const key = cursor.key as TKey

    map.set(key, storageHandler.revive(cursor.value))
    cursor = await cursor.continue()
  }

  /**
   * SWR Cache provider API
   */
  return (globalCache: Readonly<TCache>): TCache => ({
    get: (key: TKey): TValue | null | undefined =>
      map.get(key),

    set: (key: TKey, value: TValue): void => {
      map.set(key, value)

      if (isResponseResult(key)) {
        db.put(storeName, storageHandler.replace(value), key)
      }
    },

    /**
     * Used only by useSWRInfinite
     */
    delete: (key: TKey): void => {
      if (map.delete(key) && isResponseResult(key)) {
        db.delete(storeName, key)
      }
    },
  })

  /**
   * Ignore internal values (error, isValidaing)
   */
  function isResponseResult(key: TKey): boolean {
    return !key.startsWith('$')
  }
}
