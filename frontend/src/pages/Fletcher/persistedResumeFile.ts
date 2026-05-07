const DB_NAME = 'hunt.fletcher'
const DB_VERSION = 1
const STORE_NAME = 'optionBResumeFile'
const FILE_KEY = 'resume'

interface StoredResumeFile {
  key: string
  name: string
  type: string
  lastModified: number
  blob: Blob
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openResumeDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function loadPersistedFletcherResumeFile(): Promise<File | null> {
  if (!hasIndexedDb()) return null
  const db = await openResumeDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(FILE_KEY)
      request.onsuccess = () => {
        const record = request.result as StoredResumeFile | undefined
        if (!record?.blob) {
          resolve(null)
          return
        }
        resolve(
          new File([record.blob], record.name || 'resume', {
            type: record.type || record.blob.type,
            lastModified: record.lastModified || Date.now(),
          }),
        )
      }
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

export async function savePersistedFletcherResumeFile(file: File | null): Promise<void> {
  if (!hasIndexedDb()) return
  const db = await openResumeDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      if (file) {
        store.put({
          key: FILE_KEY,
          name: file.name,
          type: file.type,
          lastModified: file.lastModified,
          blob: file,
        } satisfies StoredResumeFile)
      } else {
        store.delete(FILE_KEY)
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}
