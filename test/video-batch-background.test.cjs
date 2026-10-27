const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const state = {}, chunks = new Map(), runs = [];
  let messageHandler, removedHandler;
  const tabs = new Map([[1, { id: 1, url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=video_edit' }]]);
  const chrome = {
    storage: { local: {
      get: async key => ({ [key]: state[key] }),
      set: async value => Object.assign(state, value)
    } },
    runtime: { onMessage: { addListener: handler => { messageHandler = handler; } } },
    tabs: {
      query: async () => [...tabs.values()],
      sendMessage: async (id, message) => {
        if (message.type === 'wxh.batch.run') { runs.push(id); return { ok: true }; }
        return undefined;
      },
      onRemoved: { addListener: handler => { removedHandler = handler; } }
    }
  };
  const WXHVideoStore = {
    put: async (batch, item, index, blob) => chunks.set(`${batch}:${item}:${index}`, blob),
    get: async (batch, item, index) => chunks.get(`${batch}:${item}:${index}`),
    clear: async () => chunks.clear(),
    removeItems: async (batch, ids) => {
      for (const key of chunks.keys()) if (ids.some(id => key.startsWith(`${batch}:${id}:`))) chunks.delete(key);
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/video-batch-background.js'), 'utf8');
  vm.runInNewContext(source, { chrome, crypto, Blob, navigator: { storage: { estimate: async () => ({ quota: 1000, usage: 0 }) } },
    WXHVideoStore, importScripts: () => {}, setTimeout, console });
  const send = (message, tabId = 1) => new Promise(resolve => messageHandler(message, {
    tab: tabs.get(tabId), url: tabs.get(tabId)?.url
  }, resolve));
  return { send, get: () => state.wxh_video_batch_v4, chunks, runs, tabs, remove: id => { tabs.delete(id); removedHandler(id); } };
}

const video = (id, title = id) => ({ id, title, fileName: `${id}.mp4`, fileType: 'video/mp4', fileSize: 5,
  fileModified: 1, duration: 20, original: true });

async function staged(h, items) {
  const started = await h.send({ type: 'wxh.batch.begin', items });
  assert.equal(started.ok, true);
  for (const item of items) {
    const part = await h.send({ type: 'wxh.batch.stage-chunk', batchId: started.batch.id, itemId: item.id,
      index: 0, blob: new Blob([new Uint8Array(5)]) });
    assert.equal(part.ok, true);
    assert.equal((await h.send({ type: 'wxh.batch.stage-complete', batchId: started.batch.id, itemId: item.id })).ok, true);
  }
  return started.batch.id;
}

test('files staged once remain available on a new WeChat Add page after the first import', async () => {
  const h = harness();
  const batchId = await staged(h, [video('a'), video('b')]);
  assert.equal(h.get().phase, '待上传');
  assert.equal(h.chunks.size, 2);
  assert.deepEqual(h.runs, []);
  assert.equal((await h.send({ type: 'wxh.batch.activate', itemId: 'a' })).ok, true);
  assert.deepEqual(h.runs, [1]);
  const first = await h.send({ type: 'wxh.batch.worker-hello' });
  assert.equal(first.task.item.id, 'a');
  assert.equal((await h.send({ type: 'wxh.batch.chunk', itemId: 'a', offset: 0, length: 5 })).blob.size, 5);
  await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'a', kind: 'stage', status: '资料已设置', reason: '已选择原创' });
  await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'a', kind: 'save-intent' });
  await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'a', kind: 'verified', evidence: '素材列表显示本次视频' });
  assert.equal(h.get().items[0].status, '已上传');
  assert.equal(h.get().items[1].status, '待上传');
  assert.equal(h.get().phase, '待上传');
  assert.deepEqual(h.runs, [1]);

  h.tabs.set(2, { id: 2, url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=video_edit' });
  const resumed = await h.send({ type: 'wxh.batch.state' }, 2);
  assert.deepEqual(Array.from(resumed.batch.items, item => item.status), ['已上传', '待上传']);
  assert.equal((await h.send({ type: 'wxh.batch.activate', itemId: 'b' }, 2)).ok, true);
  assert.deepEqual(h.runs, [1, 2]);
  assert.equal((await h.send({ type: 'wxh.batch.chunk', itemId: 'b', offset: 0, length: 5 }, 2)).blob.size, 5);
  await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'b', kind: 'save-intent' }, 2);
  await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'b', kind: 'verified', evidence: '素材列表显示本次视频' }, 2);
  assert.equal(h.get().phase, '已完成');
  assert.deepEqual(Array.from(h.get().items, item => item.status), ['已上传', '已上传']);
});

test('uncertain saved result leaves earlier video pending verification and allows next video', async () => {
  const h = harness();
  const batchId = await staged(h, [video('a'), video('b')]);
  await h.send({ type: 'wxh.batch.activate', itemId: 'a' });
  await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'a', kind: 'save-intent' });
  await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'a', kind: 'uncertain', reason: '未找到素材' });
  assert.equal(h.get().phase, '待上传');
  assert.equal(h.get().items[0].status, '待核对');
  assert.equal(h.get().items[1].status, '待上传');
  assert.deepEqual(h.runs, [1]);
  h.tabs.set(2, { id: 2, url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=video_edit' });
  assert.equal((await h.send({ type: 'wxh.batch.activate', itemId: 'b' }, 2)).ok, true);
  assert.deepEqual(h.runs, [1, 2]);
});

test('duplicate filenames can be staged once and renamed before upload', async () => {
  const h = harness();
  await staged(h, [video('a', '相同'), video('b', '相同')]);
  const blocked = await h.send({ type: 'wxh.batch.activate', itemId: 'a' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /相同标题/);
  assert.equal((await h.send({ type: 'wxh.batch.update-item', itemId: 'a', title: '第一个视频', original: true })).ok, true);
  assert.equal((await h.send({ type: 'wxh.batch.activate', itemId: 'a' })).ok, true);
});

test('native Save reaches the material list before the next Add page without losing the queue', async () => {
  const h = harness();
  const batchId = await staged(h, [video('a'), video('b')]);
  await h.send({ type: 'wxh.batch.activate', itemId: 'a' });
  await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'a', kind: 'stage', status: '等待微信保存' });
  assert.equal(h.get().phase, '等待微信保存');
  await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'a', kind: 'save-intent' });
  h.tabs.get(1).url = 'https://mp.weixin.qq.com/cgi-bin/filepage?type=video';
  assert.equal((await h.send({ type: 'wxh.batch.worker-hello' })).task.item.status, '保存已提交');
  await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'a', kind: 'verified', evidence: '素材列表' });
  assert.equal(h.get().items[0].status, '已上传');
  h.tabs.get(1).url = 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=video_edit';
  assert.equal((await h.send({ type: 'wxh.batch.worker-hello' })).task, null);
  assert.equal(h.get().phase, '待上传');
  assert.equal((await h.send({ type: 'wxh.batch.activate', itemId: 'b' })).ok, true);
});

test('the actual action=list_video material route can verify a saved item', async () => {
  const h = harness();
  const batchId = await staged(h, [video('a'), video('b')]);
  await h.send({ type: 'wxh.batch.activate', itemId: 'a' });
  await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'a', kind: 'save-intent', savedTitle: 'a' });
  h.tabs.set(2, { id: 2, url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_video&type=15' });
  assert.equal((await h.send({ type: 'wxh.batch.worker-hello' }, 2)).task.item.id, 'a');
  assert.equal((await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'a', kind: 'verified',
    evidence: '素材库→视频显示已通过' }, 2)).ok, true);
  assert.deepEqual(Array.from(h.get().items, item => item.status), ['已上传', '待上传']);
  assert.equal(h.get().phase, '待上传');
});

test('a different material-library tab can confirm the native Save without manual queue action', async () => {
  const h = harness();
  const batchId = await staged(h, [video('a'), video('b')]);
  await h.send({ type: 'wxh.batch.activate', itemId: 'a' });
  h.tabs.set(2, { id: 2, url: 'https://mp.weixin.qq.com/cgi-bin/filepage?type=video' });
  assert.equal((await h.send({ type: 'wxh.batch.worker-hello' }, 2)).task, null);
  await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'a', kind: 'save-intent' });
  assert.equal((await h.send({ type: 'wxh.batch.worker-hello' }, 2)).task.item.id, 'a');
  assert.equal((await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'a', kind: 'verified', evidence: '匹配素材' }, 2)).ok, true);
  assert.deepEqual(Array.from(h.get().items, item => item.status), ['已上传', '待上传']);
});

test('material-list DOM signal works when WeChat changes the library URL', async () => {
  const h = harness();
  const batchId = await staged(h, [video('a')]);
  await h.send({ type: 'wxh.batch.activate', itemId: 'a' });
  await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'a', kind: 'save-intent' });
  h.tabs.set(2, { id: 2, url: 'https://mp.weixin.qq.com/cgi-bin/material_unknown' });
  assert.equal((await h.send({ type: 'wxh.batch.worker-hello', materialList: true }, 2)).task.item.id, 'a');
  assert.equal((await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'a',
    kind: 'verified', materialList: true, evidence: '匹配素材' }, 2)).ok, true);
  assert.equal(h.get().phase, '已完成');
});

test('returning to Add in another tab releases a saved video and keeps explicit retry available', async () => {
  const h = harness();
  const batchId = await staged(h, [video('a'), video('b')]);
  await h.send({ type: 'wxh.batch.activate', itemId: 'a' });
  await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'a', kind: 'save-intent', savedTitle: '更新后的标题' });
  h.tabs.set(2, { id: 2, url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=video_edit' });
  assert.equal((await h.send({ type: 'wxh.batch.worker-hello' }, 2)).task, null);
  assert.equal(h.get().items[0].status, '待核对');
  assert.equal(h.get().items[0].savedTitle, '更新后的标题');
  assert.equal(h.get().phase, '待上传');
  assert.equal((await h.send({ type: 'wxh.batch.activate', itemId: 'b' }, 2)).ok, true);
  assert.equal((await h.send({ type: 'wxh.batch.activate', itemId: 'a' }, 2)).ok, false); // A new native page is needed.
  await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'b', kind: 'save-intent' }, 2);
  h.tabs.set(3, { id: 3, url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=video_edit' });
  await h.send({ type: 'wxh.batch.worker-hello' }, 3);
  assert.equal(h.get().phase, '待核对');
  assert.equal((await h.send({ type: 'wxh.batch.activate', itemId: 'a' }, 3)).ok, false);
  assert.equal((await h.send({ type: 'wxh.batch.activate', itemId: 'a', retry: true }, 3)).ok, true);
  assert.equal(h.get().items[0].status, '等待原生上传页');
  assert.equal(h.get().items[0].saveIntentAt, undefined);
});

test('an already verified video can be explicitly uploaded again', async () => {
  const h = harness();
  const batchId = await staged(h, [video('a')]);
  await h.send({ type: 'wxh.batch.activate', itemId: 'a' });
  await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'a', kind: 'save-intent' });
  await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'a', kind: 'verified', evidence: '已入库' });
  h.tabs.set(2, { id: 2, url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=video_edit' });
  assert.equal(h.get().phase, '已完成');
  assert.equal((await h.send({ type: 'wxh.batch.activate', itemId: 'a' }, 2)).ok, false);
  assert.equal((await h.send({ type: 'wxh.batch.activate', itemId: 'a', retry: true }, 2)).ok, true);
});

test('returning to Add after an interrupted upload leaves prior item retryable', async () => {
  const h = harness();
  const batchId = await staged(h, [video('a'), video('b')]);
  await h.send({ type: 'wxh.batch.activate', itemId: 'a' });
  await h.send({ type: 'wxh.batch.worker-event', batchId, itemId: 'a', kind: 'stage', status: '微信上传中' });
  assert.equal((await h.send({ type: 'wxh.batch.worker-hello' })).task, null);
  assert.equal(h.get().phase, '待上传');
  assert.equal(h.get().items[0].status, '待核对');
  assert.equal(h.get().items[1].status, '待上传');
  assert.equal((await h.send({ type: 'wxh.batch.activate', itemId: 'b' })).ok, true);
});

test('new videos append to unfinished queue without clearing earlier cached files', async () => {
  const h = harness();
  const batchId = await staged(h, [video('a'), video('b')]);
  assert.equal((await h.send({ type: 'wxh.batch.append', items: [video('c')] })).ok, true);
  assert.equal(h.get().phase, '暂存中');
  assert.equal((await h.send({ type: 'wxh.batch.stage-chunk', batchId, itemId: 'c', index: 0,
    blob: new Blob([new Uint8Array(5)]) })).ok, true);
  assert.equal((await h.send({ type: 'wxh.batch.stage-complete', batchId, itemId: 'c' })).ok, true);
  assert.deepEqual(Array.from(h.get().items, item => item.status), ['待上传', '待上传', '待上传']);
  assert.equal(h.chunks.size, 3);
  assert.equal((await h.send({ type: 'wxh.batch.chunk', itemId: 'a', offset: 0, length: 5 })).ok, false); // No active upload.
  assert.equal((await h.send({ type: 'wxh.batch.activate', itemId: 'a' })).ok, true);
  assert.equal((await h.send({ type: 'wxh.batch.chunk', itemId: 'a', offset: 0, length: 5 })).blob.size, 5);
});

test('failed append rolls back new files and leaves previous queue usable', async () => {
  const h = harness();
  const batchId = await staged(h, [video('a')]);
  await h.send({ type: 'wxh.batch.append', items: [video('b')] });
  await h.send({ type: 'wxh.batch.stage-chunk', batchId, itemId: 'b', index: 0,
    blob: new Blob([new Uint8Array(5)]) });
  const failed = await h.send({ type: 'wxh.batch.stage-failed', batchId, itemId: 'b', reason: '磁盘写入失败' });
  assert.equal(failed.ok, true);
  assert.deepEqual(Array.from(h.get().items, item => item.id), ['a']);
  assert.equal(h.get().phase, '待上传');
  assert.equal(h.chunks.size, 1);
});
