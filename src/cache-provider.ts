import type { Cache as SWRCache, State as SWRState } from 'swr'
import { openDB } from 'idb'

import type { TCacheProvider, TConfig } from './types'
import simpleStorageHandler from './storage-handler/simple'

// Unlinke what SWR types suggest, key is always a serialized string
type TKey = string

/**
 * Cache provider factory
 */
export default async function createCacheProvider<Data = any, Error = any>({
  dbName,
  storeName,
  storageHandler = simpleStorageHandler,
  version = 1,
  onError = () => {},
}: TConfig): Promise<TCacheProvider> {
  type TCache = SWRCache<Data>
  type TState = SWRState<Data, Error>

  // Initialize database
  const db = await openDB(dbName, version, {
    upgrade: (upgradeDb, oldVersion, ...rest) => {
      // Delete previous object store on upgrade
      if (oldVersion && version > oldVersion) {
        upgradeDb.deleteObjectStore(storeName)
      }

      const objectStore = upgradeDb.createObjectStore(storeName)

      storageHandler.upgradeObjectStore?.(objectStore, oldVersion, ...rest)
    }
  })

  // Get storage snapshot
  const map = new Map<TKey, TState>()

  let cursor = await db.transaction(storeName, 'readwrite').store.openCursor()

  while (cursor) {
    const key = cursor.key as TKey
    const value = storageHandler.revive(key, cursor.value)

    // Stale
    if (value === undefined) {
      cursor.delete()
    // OK
    } else {
      map.set(key, value)
    }

    cursor = await cursor.continue()
  }

  /**
   * SWR Cache provider API
   */
  return (globalCache: Readonly<TCache>): TCache => ({
    keys: () =>
      map.keys(),

    get: (key: TKey): TState | undefined =>
      map.get(key),

    set: (key: TKey, value: TState): void => {
      map.set(key, value)

      if (isFetchInfo(value)) {
        return
      }

      const storeValue = storageHandler.replace(key, value)

      if (storeValue === undefined) {
        return
      }

      db.put(storeName, storeValue, key)
        .catch(onError)
    },

    /**
     * Used only by useSWRInfinite
     */
    delete: (key: TKey): void => {
      if (map.delete(key)) {
        db.delete(storeName, key)
          .catch(onError)
      }
    },

    /**
     * Documented, but missing method type
     * @link https://swr.vercel.app/docs/advanced/cache#access-to-the-cache
     * @link https://github.com/vercel/swr/pull/1480
     */
    // @ts-ignore
    clear: (): void => {
      map.clear()
      db.clear(storeName)
    },
  })

  /**
   * Do not store as non-native errors are not serializable, other properties are optional
   * @link https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm#supported_types
   */
  function isFetchInfo(state: TState): boolean {
    return (
      state.error instanceof Error ||
      state.isValidating === true ||
      state.isLoading === true
    )
  }
}
