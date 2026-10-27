/* Extension-owned binary cache. Video chunks live in IndexedDB, rather than
 * a WeChat page's memory, so the user's Save → material library → Add route
 * does not require choosing the same local files again. Only one batch exists. */
globalThis.WXHVideoStore = (() => {
  'use strict';
  const DB = 'wxh-video-batch-v1';
  const STORE = 'chunks';
  let opened;
  function database() {
    if (opened) return opened;
    opened = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('视频暂存空间不可用。'));
    });
    return opened;
  }
  function key(batchId, itemId, index) { return `${batchId}:${itemId}:${index}`; }
  async function put(batchId, itemId, index, blob) {
    if (!(blob instanceof Blob) || blob.size > 4 * 1024 * 1024) throw new Error('视频分片无效。');
    const db = await database();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(blob, key(batchId, itemId, index));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('视频暂存写入失败。'));
      tx.onabort = () => reject(tx.error || new Error('视频暂存被中断。'));
    });
  }
  async function get(batchId, itemId, index) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key(batchId, itemId, index));
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('暂存视频读取失败。'));
    });
  }
  async function clear() {
    const db = await database();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('清理旧视频暂存失败。'));
    });
  }
  async function removeItems(batchId, itemIds) {
    const db = await database();
    const prefixes = itemIds.map(itemId => `${batchId}:${itemId}:`);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const request = tx.objectStore(STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (prefixes.some(prefix => String(cursor.key).startsWith(prefix))) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('清理追加视频失败。'));
      tx.onabort = () => reject(tx.error || new Error('清理追加视频被中断。'));
    });
  }
  return { put, get, clear, removeItems };
})();
