/* 用户库：IndexedDB 存列表/字幕/总结/对话；本地视频文件进 OPFS（不行则退回 IDB）。
   后端 data/ 只做串流代理、转录音频等临时缓存，不当作用户库。 */
(function (global) {
  const DB_NAME = 'vlh-library';
  const DB_VERSION = 1;
  const STORES = ['videos', 'subtitles', 'summaries', 'chats', 'files'];

  let _db = null;

  function openDb() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of STORES) {
          if (db.objectStoreNames.contains(name)) continue;
          if (name === 'videos') db.createObjectStore('videos', { keyPath: 'id' });
          else db.createObjectStore(name, { keyPath: 'videoId' });
        }
      };
      req.onsuccess = () => {
        _db = req.result;
        _db.onversionchange = () => {
          _db.close();
          _db = null;
        };
        resolve(_db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function idbGet(store, key) {
    const db = await openDb();
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    const val = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await txDone(tx);
    return val;
  }

  async function idbPut(store, value) {
    const db = await openDb();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    await txDone(tx);
  }

  async function idbDelete(store, key) {
    const db = await openDb();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    await txDone(tx);
  }

  async function idbGetAll(store) {
    const db = await openDb();
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    const val = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    await txDone(tx);
    return val;
  }

  async function opfsDir(create) {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('videos', { create: !!create });
  }

  async function saveLocalFile(id, file) {
    try {
      if (navigator.storage?.getDirectory) {
        const dir = await opfsDir(true);
        const fh = await dir.getFileHandle(id, { create: true });
        const writable = await fh.createWritable();
        await file.stream().pipeTo(writable);
        return 'opfs';
      }
    } catch (err) {
      console.warn('OPFS 保存失败，改用 IndexedDB', err);
    }
    await idbPut('files', { videoId: id, blob: file });
    return 'idb';
  }

  async function getLocalFile(id) {
    try {
      if (navigator.storage?.getDirectory) {
        const dir = await opfsDir(false);
        const fh = await dir.getFileHandle(id, { create: false });
        return await fh.getFile();
      }
    } catch { /* 无 OPFS 或该 id 不在 */ }
    const rec = await idbGet('files', id);
    return rec?.blob || null;
  }

  async function deleteLocalFile(id) {
    try {
      if (navigator.storage?.getDirectory) {
        const dir = await opfsDir(false);
        await dir.removeEntry(id);
      }
    } catch { /* 没有就算了 */ }
    try { await idbDelete('files', id); } catch { /* */ }
  }

  try { navigator.storage?.persist?.(); } catch { /* 隐私模式 */ }

  global.vlhLibrary = {
    newId() {
      return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    },

    async listVideos() {
      const all = await idbGetAll('videos');
      return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },

    async getVideo(id) {
      return (await idbGet('videos', id)) || null;
    },

    async saveVideo(rec) {
      const now = Date.now();
      rec.updatedAt = now;
      if (!rec.createdAt) rec.createdAt = now;
      await idbPut('videos', rec);
      return rec;
    },

    async deleteVideo(id) {
      await idbDelete('videos', id);
      await idbDelete('subtitles', id);
      await idbDelete('summaries', id);
      await idbDelete('chats', id);
      await deleteLocalFile(id);
    },

    async getCues(id) {
      return (await idbGet('subtitles', id))?.cues || [];
    },

    async saveCues(id, cues) {
      await idbPut('subtitles', { videoId: id, cues: cues || [] });
    },

    async getSummary(id) {
      return (await idbGet('summaries', id))?.text || null;
    },

    async saveSummary(id, text) {
      if (!text) {
        await idbDelete('summaries', id);
        return;
      }
      await idbPut('summaries', { videoId: id, text });
    },

    async getChat(id) {
      return (await idbGet('chats', id))?.messages || [];
    },

    async saveChat(id, messages) {
      await idbPut('chats', { videoId: id, messages: messages || [] });
    },

    saveLocalFile,
    getLocalFile,
    deleteLocalFile,
  };
})(window);
