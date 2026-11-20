import type { Place } from './import.ts';

const storeName = 'places';

function openPlaces() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('gpx-route-editor-places', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'key' });
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('地点データベースを開けませんでした。'));
  });
}

export async function updatePlaces(add: Place[] = [], remove?: string) {
  const db = await openPlaces();
  try {
    return await new Promise<Place[]>((resolve, reject) => {
      const transaction = db.transaction(storeName, add.length || remove ? 'readwrite' : 'readonly');
      const store = transaction.objectStore(storeName);
      for (const place of add) store.put(place);
      if (remove) store.delete(remove);
      const request = store.getAll();
      transaction.oncomplete = () => resolve(request.result as Place[]);
      transaction.onabort = () => reject(transaction.error ?? new Error('地点を保存できませんでした。'));
    });
  } finally {
    db.close();
  }
}
