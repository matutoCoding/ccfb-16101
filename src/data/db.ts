// IndexedDB 持久化：菌棒二进制记录分块存储，配置类对象走独立 store
const DB_NAME = 'mushroom-farm-v1'
const DB_VERSION = 1

export const STORE = {
  meta: 'meta', // 单例配置、批次、棚档案
  stickChunk: 'stickChunk', // 菌棒记录分块
  task: 'task',
  event: 'event',
} as const

const META_KEYS = {
  settings: 'settings',
  greenhouses: 'greenhouses',
  batches: 'batches',
  origins: 'origins',
  total: 'total',
  chunkCount: 'chunkCount',
  initialized: 'initialized',
}

export const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE.meta)) db.createObjectStore(STORE.meta)
      if (!db.objectStoreNames.contains(STORE.stickChunk)) db.createObjectStore(STORE.stickChunk)
      if (!db.objectStoreNames.contains(STORE.task)) {
        const s = db.createObjectStore(STORE.task, { keyPath: 'id', autoIncrement: true })
        s.createIndex('house', 'greenhouseId')
      }
      if (!db.objectStoreNames.contains(STORE.event)) {
        const s = db.createObjectStore(STORE.event, { keyPath: 'id', autoIncrement: true })
        s.createIndex('stick', 'stickId')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

const tx = <T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode)
    const req = fn(t.objectStore(store))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

export const idbGet = <T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> =>
  tx(db, store, 'readonly', (s) => s.get(key) as IDBRequest<T>)

export const idbPut = (db: IDBDatabase, store: string, value: unknown, key?: IDBValidKey): Promise<IDBValidKey> =>
  tx(db, store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key)))

export const idbClear = (db: IDBDatabase, store: string): Promise<void> =>
  tx(db, store, 'readwrite', (s) => s.clear())

export const idbAll = async <T>(db: IDBDatabase, store: string): Promise<T[]> => {
  const t = db.transaction(store, 'readonly')
  return new Promise<T[]>((resolve, reject) => {
    const out: T[] = []
    const req = t.objectStore(store).openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        out.push(cursor.value as T)
        cursor.continue()
      } else resolve(out)
    }
    req.onerror = () => reject(req.error)
  })
}

export const META = META_KEYS

// 二进制菌棒记录按 chunk 分块写，每块 5 万根（约 4MB），兼顾吞吐与事务体积
export const CHUNK_STICKS = 50000

export const saveStickChunks = async (
  db: IDBDatabase,
  records: Float32Array,
  total: number,
): Promise<void> => {
  await idbClear(db, STORE.stickChunk)
  const chunkCount = Math.ceil(total / CHUNK_STICKS)
  for (let c = 0; c < chunkCount; c++) {
    const start = c * CHUNK_STICKS * 20 // Float32 视角
    const end = Math.min(records.length, (c + 1) * CHUNK_STICKS * 20)
    // 复制为独立 ArrayBuffer，避免视图引用整个底层缓冲
    const part = records.slice(start, end)
    await idbPut(db, STORE.stickChunk, part.buffer as ArrayBuffer, c)
  }
  await idbPut(db, STORE.meta, chunkCount, META_KEYS.chunkCount)
}

export const loadStickChunks = async (db: IDBDatabase, total: number): Promise<Float32Array> => {
  const chunkCount = await idbGet<number>(db, STORE.meta, META_KEYS.chunkCount)
  const records = new Float32Array(total * 20)
  const n = chunkCount ?? 0
  for (let c = 0; c < n; c++) {
    const buf = await idbGet<ArrayBuffer>(db, STORE.stickChunk, c)
    if (!buf) continue
    const part = new Float32Array(buf)
    records.set(part, c * CHUNK_STICKS * 20)
  }
  return records
}
