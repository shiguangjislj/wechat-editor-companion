/* Persistent batch coordinator. The user chooses Add in WeChat between videos;
 * this service worker keeps metadata and extension-owned file chunks, activates
 * one item on that new native page, and never equates Save-click with import. */
importScripts('video-batch-storage.js');
(() => {
  'use strict';
  const KEY = 'wxh_video_batch_v4';
  const CHUNK = 4 * 1024 * 1024;
  const read = async () => {
    const batch = (await chrome.storage.local.get(KEY))[KEY] || null;
    // Keep v0.4 batches and their cached file bytes usable after upgrade.
    batch?.items?.forEach(item => { if (item.status === '已导入') item.status = '已上传'; });
    return batch;
  };
  const write = async batch => { await chrome.storage.local.set({ [KEY]: batch }); return batch; };
  const reply = (tabId, message) => chrome.tabs.sendMessage(tabId, message).catch(() => null);
  let gate = Promise.resolve();
  function serial(work) {
    const result = gate.then(work);
    gate = result.catch(() => {});
    return result;
  }
  function publicBatch(batch) {
    if (!batch) return null;
    const { workerTabId, stagingTabId, ...view } = batch;
    return view;
  }
  async function broadcast(batch) {
    const tabs = await chrome.tabs.query({ url: 'https://mp.weixin.qq.com/*' }).catch(() => []);
    await Promise.all(tabs.map(tab => reply(tab.id, { type: 'wxh.batch.update', batch: publicBatch(batch) })));
  }
  function videoPage(sender) {
    return sender.tab?.id != null && /^https:\/\/mp\.weixin\.qq\.com\/cgi-bin\/appmsg/.test(sender.url || '') &&
      /(?:action=video_edit|videomsg_edit)/.test(sender.url || '');
  }
  function materialPage(sender, message) {
    const url = sender.url || '';
    return sender.tab?.id != null && /^https:\/\/mp\.weixin\.qq\.com\//.test(url) &&
      (/(?:\/cgi-bin\/filepage|\/cgi-bin\/filemanage|action=(?:video_list|list_video)|videomsg_list)/.test(url) ||
        message?.materialList === true);
  }
  function pending(batch) { return batch.items.some(item => item.status === '待上传'); }
  function nextPhase(batch) {
    return pending(batch) ? '待上传' : batch.items.some(item => item.status === '待核对') ? '待核对' : '已完成';
  }
  async function releaseForNextAdd(batch, reason) {
    const item = batch.items.find(entry => entry.id === batch.activeItemId);
    if (!item) return publicBatch(batch);
    item.status = '待核对';
    item.reason = reason || (item.saveIntentAt
      ? '微信保存已提交；素材库结果尚未核实，可先处理下一条。'
      : '上一页是否保存未知；可先处理下一条，也可选择重新上传。');
    batch.workerTabId = null;
    batch.activeItemId = null;
    batch.phase = nextPhase(batch);
    batch.reason = '';
    await write(batch); await broadcast(batch);
    return publicBatch(batch);
  }
  function prepareItems(raw) {
    if (!Array.isArray(raw) || !raw.length) throw new Error('请先选择视频。');
    const items = raw.map(item => ({
      id: String(item.id), title: String(item.title || '').trim().slice(0, 64),
      fileName: String(item.fileName), fileType: String(item.fileType || ''),
      fileSize: Number(item.fileSize), fileModified: Number(item.fileModified),
      chunkCount: Math.ceil(Number(item.fileSize) / CHUNK), stagedChunks: 0,
      status: '暂存中', reason: ''
    }));
    if (items.some(item => !item.title || !Number.isFinite(item.fileSize) || item.fileSize <= 0))
      throw new Error('队列里存在无效标题或空文件。');
    return items;
  }
  async function checkSpace(items) {
    let estimate = null;
    try { estimate = await navigator.storage?.estimate?.(); } catch (_) { /* Quota check is advisory. */ }
    const total = items.reduce((sum, item) => sum + item.fileSize, 0);
    if (estimate?.quota && estimate?.usage != null && total > (estimate.quota - estimate.usage) * 0.9)
      throw new Error('浏览器本地暂存空间不足，请减少本批次视频数量。');
  }
  async function pause(batch, reason, uncertain = false) {
    batch.phase = uncertain ? '结果待核对' : '已暂停';
    batch.reason = reason;
    const item = batch.items.find(entry => entry.id === batch.activeItemId);
    if (item && item.status !== '已上传') {
      item.status = uncertain ? '结果待核对' : '已暂停';
      item.reason = reason;
    }
    await write(batch); await broadcast(batch);
    return publicBatch(batch);
  }
  async function begin(message, sender) {
    if (!videoPage(sender)) throw new Error('请在微信“添加视频”页选择全部视频。');
    const old = await read();
    if (old && !['已完成', '已暂停', '结果待核对', '暂存失败'].includes(old.phase))
      throw new Error('当前批次尚未结束，请先处理已暂存的视频。');
    const items = prepareItems(message.items);
    await checkSpace(items);
    await WXHVideoStore.clear();
    const batch = {
      id: crypto.randomUUID(), stagingTabId: sender.tab.id, workerTabId: null,
      activeItemId: null, phase: '暂存中', reason: '', items,
      agreementAccepted: false, agreementSignature: null, startedAt: Date.now()
    };
    await write(batch); await broadcast(batch);
    return publicBatch(batch);
  }
  async function append(message, sender) {
    if (!videoPage(sender)) throw new Error('请在微信“添加视频”页继续添加视频。');
    const batch = await read();
    if (!batch || !['待上传', '待核对', '已完成'].includes(batch.phase) || batch.workerTabId != null)
      throw new Error('请等当前视频完成后再继续添加。');
    const items = prepareItems(message.items);
    if (items.some(item => batch.items.some(old => old.fileName === item.fileName &&
      old.fileSize === item.fileSize && old.fileModified === item.fileModified)))
      throw new Error('所选文件中已有本批次视频，请只选择新视频。');
    await checkSpace(items);
    batch.appendItemIds = items.map(item => item.id);
    batch.previousPhase = batch.phase;
    batch.stagingTabId = sender.tab.id;
    batch.phase = '暂存中';
    batch.items.push(...items);
    await write(batch); await broadcast(batch);
    return publicBatch(batch);
  }
  async function rollbackAppend(batch, reason) {
    const ids = batch.appendItemIds || [];
    await WXHVideoStore.removeItems(batch.id, ids);
    batch.items = batch.items.filter(item => !ids.includes(item.id));
    batch.phase = batch.previousPhase || nextPhase(batch);
    batch.reason = String(reason || '新视频暂存失败，原队列已保留。').slice(0, 250);
    batch.stagingTabId = null;
    delete batch.appendItemIds;
    delete batch.previousPhase;
    await write(batch); await broadcast(batch);
    return publicBatch(batch);
  }
  async function stageChunk(message, sender) {
    const batch = await read();
    if (!batch || batch.id !== message.batchId || batch.stagingTabId !== sender.tab?.id || batch.phase !== '暂存中')
      throw new Error('当前页面没有可继续的暂存任务。');
    const item = batch.items.find(entry => entry.id === message.itemId);
    if (!item || item.status !== '暂存中' || item.stagedChunks !== message.index)
      throw new Error('视频分片顺序与队列不匹配。');
    const blob = message.blob;
    const expected = Math.min(CHUNK, item.fileSize - message.index * CHUNK);
    if (!(blob instanceof Blob) || blob.size !== expected) throw new Error('视频分片大小校验失败。');
    await WXHVideoStore.put(batch.id, item.id, message.index, blob);
    item.stagedChunks += 1;
    await write(batch);
    return { ok: true, stagedChunks: item.stagedChunks };
  }
  async function stageComplete(message, sender) {
    const batch = await read();
    if (!batch || batch.id !== message.batchId || batch.stagingTabId !== sender.tab?.id)
      throw new Error('暂存批次与当前页面不匹配。');
    const item = batch.items.find(entry => entry.id === message.itemId);
    if (!item || item.stagedChunks !== item.chunkCount) throw new Error('视频暂存尚未完成。');
    item.status = '待上传';
    if (!batch.items.some(entry => entry.status === '暂存中')) {
      batch.phase = '待上传';
      batch.stagingTabId = null;
      delete batch.appendItemIds;
      delete batch.previousPhase;
    }
    await write(batch); await broadcast(batch);
    return publicBatch(batch);
  }
  async function stageFailed(message, sender) {
    const batch = await read();
    if (!batch || batch.id !== message.batchId || batch.stagingTabId !== sender.tab?.id) return null;
    if (batch.appendItemIds?.length) return rollbackAppend(batch, message.reason);
    batch.phase = '暂存失败';
    batch.reason = String(message.reason || '暂存失败。').slice(0, 250);
    const item = batch.items.find(entry => entry.id === message.itemId);
    if (item) { item.status = '暂存失败'; item.reason = batch.reason; }
    await write(batch); await broadcast(batch);
    return publicBatch(batch);
  }
  async function updateItem(message) {
    const batch = await read();
    if (!batch) throw new Error('没有已暂存的批次。');
    const item = batch.items.find(entry => entry.id === message.itemId);
    if (!item || item.status !== '待上传') throw new Error('该视频正在处理或已经导入。');
    const title = String(message.title || '').trim().slice(0, 64);
    if (!title || batch.items.some(entry => entry.id !== item.id && entry.title === title))
      throw new Error('标题为空或与本批次其他视频重复。');
    item.title = title;
    await write(batch); await broadcast(batch);
    return publicBatch(batch);
  }
  async function activate(message, sender) {
    if (!videoPage(sender)) throw new Error('请先在微信素材库点击“添加”，进入新的添加视频页。');
    const batch = await read();
    if (!batch || batch.workerTabId != null || !['待上传', '待核对', '已完成'].includes(batch.phase))
      throw new Error('请等当前视频暂存或上传完成。');
    const item = batch.items.find(entry => entry.id === message.itemId);
    const retry = item && ['待核对', '已上传'].includes(item.status) && message.retry === true;
    if (!item || (item.status !== '待上传' && !retry)) throw new Error('该视频不可上传；重传已处理视频需明确选择“重新上传”。');
    if (batch.items.some(entry => entry.id !== item.id && entry.title === item.title))
      throw new Error('本批次有相同标题，请先修改该视频标题以便核对素材。');
    if (!await WXHVideoStore.get(batch.id, item.id, 0) ||
        !await WXHVideoStore.get(batch.id, item.id, item.chunkCount - 1))
      throw new Error('暂存文件不完整，请重新建立批次。');
    batch.workerTabId = sender.tab.id;
    batch.activeItemId = item.id;
    batch.phase = '上传中';
    batch.reason = '';
    item.status = '等待原生上传页';
    item.reason = '';
    delete item.saveIntentAt;
    delete item.savedTitle;
    delete item.preparedAt;
    item.activatedAt = Date.now();
    await write(batch); await broadcast(batch);
    const accepted = await reply(sender.tab.id, { type: 'wxh.batch.run' });
    if (!accepted?.ok) return pause(batch, '上传页适配器未响应，请重新加载扩展后在新页面重试。');
    return publicBatch(batch);
  }
  async function workerEvent(message, sender) {
    const batch = await read();
    if (!batch || batch.id !== message.batchId ||
        (batch.workerTabId !== sender.tab?.id && !(message.kind === 'verified' && materialPage(sender, message)))) return { ok: false };
    const item = batch.items.find(entry => entry.id === message.itemId);
    if (!item || (message.kind !== 'verified' && batch.activeItemId !== item.id)) return { ok: false };
    if (['已暂停', '结果待核对'].includes(batch.phase) && message.kind !== 'verified') return { ok: false };
    if (message.kind === 'agreement') {
      batch.agreementAccepted = true;
      batch.agreementSignature = String(message.signature || '').slice(0, 200);
    } else if (message.kind === 'stage') {
      if (item.status === '保存已提交') return { ok: false };
      item.status = String(message.status || '处理中').slice(0, 40);
      item.reason = String(message.reason || '').slice(0, 250);
      if (item.status === '等待首次协议') batch.phase = '等待首次协议';
      else if (item.status === '等待微信保存') { item.preparedAt = Date.now(); batch.phase = '等待微信保存'; }
      else if (batch.phase === '等待首次协议') batch.phase = '上传中';
    } else if (message.kind === 'save-intent') {
      if (item.status === '保存已提交') return { ok: false };
      item.status = '保存已提交';
      item.saveIntentAt = Date.now();
      item.savedTitle = String(message.savedTitle || item.title).trim().slice(0, 64);
      batch.phase = '上传中';
    } else if (message.kind === 'verified') {
      if (!item.saveIntentAt || !['保存已提交', '结果待核对', '待核对'].includes(item.status)) return { ok: false };
      item.status = '已上传';
      item.reason = String(message.evidence || '').slice(0, 250);
      if (batch.activeItemId === item.id) {
        batch.workerTabId = null;
        batch.activeItemId = null;
      }
      if (!batch.activeItemId) { batch.phase = nextPhase(batch); batch.reason = ''; }
    } else if (message.kind === 'uncertain') {
      return { ok: true, batch: await releaseForNextAdd(batch, String(message.reason || '素材结果未能核验，可继续下一条或重传。')) };
    } else if (message.kind === 'failure') {
      return { ok: true, batch: await pause(batch, String(message.reason || '当前视频处理失败。')) };
    } else return { ok: false };
    await write(batch); await broadcast(batch);
    return { ok: true };
  }
  async function confirmUploaded(message, sender) {
    if (!videoPage(sender)) throw new Error('请先在微信素材库核对，再回到“添加视频”页确认。');
    const batch = await read();
    const item = batch?.items.find(entry => entry.id === message.itemId);
    const legacy = batch?.activeItemId === item?.id && ['已暂停', '结果待核对'].includes(batch.phase);
    if (!item || (item.status !== '待核对' && !legacy)) throw new Error('当前没有可人工核对的上传结果。');
    item.status = '已上传';
    item.reason = '由用户在微信素材库人工确认';
    if (batch.activeItemId === item.id) { batch.activeItemId = null; batch.workerTabId = null; }
    if (!batch.activeItemId) { batch.phase = nextPhase(batch); batch.reason = ''; }
    await write(batch); await broadcast(batch);
    return publicBatch(batch);
  }
  async function confirmNotUploaded(message, sender) {
    if (!videoPage(sender)) throw new Error('请先在微信素材库核对，再回到“添加视频”页。');
    const batch = await read();
    const item = batch?.items.find(entry => entry.id === message.itemId);
    const legacy = batch?.activeItemId === item?.id && ['已暂停', '结果待核对'].includes(batch.phase);
    if (!item || (item.status !== '待核对' && !legacy)) throw new Error('当前没有可人工核对的上传结果。');
    item.status = '待上传';
    item.reason = '由用户确认素材库无此视频，可重新上传';
    delete item.saveIntentAt;
    if (batch.activeItemId === item.id) { batch.activeItemId = null; batch.workerTabId = null; }
    if (!batch.activeItemId) { batch.phase = '待上传'; batch.reason = ''; }
    await write(batch); await broadcast(batch);
    return publicBatch(batch);
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message?.type?.startsWith('wxh.batch.')) return;
    serial(async () => {
      if (message.type === 'wxh.batch.state') return { ok: true, batch: publicBatch(await read()) };
      if (message.type === 'wxh.batch.begin') return { ok: true, batch: await begin(message, sender) };
      if (message.type === 'wxh.batch.append') return { ok: true, batch: await append(message, sender) };
      if (message.type === 'wxh.batch.stage-chunk') return stageChunk(message, sender);
      if (message.type === 'wxh.batch.stage-complete') return { ok: true, batch: await stageComplete(message, sender) };
      if (message.type === 'wxh.batch.stage-failed') return { ok: true, batch: await stageFailed(message, sender) };
      if (message.type === 'wxh.batch.update-item') return { ok: true, batch: await updateItem(message) };
      if (message.type === 'wxh.batch.activate') return { ok: true, batch: await activate(message, sender) };
      if (message.type === 'wxh.batch.confirm-uploaded') return { ok: true, batch: await confirmUploaded(message, sender) };
      if (message.type === 'wxh.batch.confirm-not-uploaded') return { ok: true, batch: await confirmNotUploaded(message, sender) };
      if (message.type === 'wxh.batch.worker-hello') {
        const batch = await read();
        if (!batch) return { ok: true, task: null };
        if (materialPage(sender, message)) {
          const saved = [...batch.items].reverse().find(item => item.saveIntentAt &&
            ['保存已提交', '结果待核对', '待核对'].includes(item.status));
          return { ok: true, task: saved ? { batchId: batch.id, item: saved,
            agreementAccepted: batch.agreementAccepted, agreementSignature: batch.agreementSignature } : null };
        }
        const active = batch.items.find(entry => entry.id === batch.activeItemId);
        if (videoPage(sender) && active && active.status !== '等待原生上传页' &&
            (active.saveIntentAt || batch.workerTabId === sender.tab?.id || ['已暂停', '结果待核对'].includes(batch.phase))) {
          await releaseForNextAdd(batch);
          return { ok: true, task: null };
        }
        if (!batch.activeItemId || batch.workerTabId !== sender.tab?.id ||
            ['已暂停', '结果待核对'].includes(batch.phase))
          return { ok: true, task: null };
        const item = active;
        if (videoPage(sender) && item?.status !== '等待原生上传页') {
          if (item) { await releaseForNextAdd(batch); return { ok: true, task: null }; }
          await pause(batch, '上一条视频尚未在素材库核验。请先核对，再确认其已上传。', true);
          return { ok: true, task: null };
        }
        return { ok: true, task: { batchId: batch.id, item,
          agreementAccepted: batch.agreementAccepted, agreementSignature: batch.agreementSignature } };
      }
      if (message.type === 'wxh.batch.chunk') {
        const batch = await read();
        if (!batch || batch.workerTabId !== sender.tab?.id || batch.items.find(entry => entry.id === batch.activeItemId)?.id !== message.itemId)
          throw new Error('任务与当前上传页不匹配。');
        const item = batch.items.find(entry => entry.id === message.itemId);
        const index = Number(message.offset) / CHUNK;
        if (!Number.isInteger(index) || index < 0 || index >= item.chunkCount ||
            message.length !== Math.min(CHUNK, item.fileSize - message.offset))
          throw new Error('请求的视频分片不合法。');
        const blob = await WXHVideoStore.get(batch.id, item.id, index);
        if (!(blob instanceof Blob) || blob.size !== message.length) throw new Error('暂存视频分片缺失。');
        return { ok: true, blob };
      }
      if (message.type === 'wxh.batch.worker-event') return workerEvent(message, sender);
      return { ok: false };
    }).then(respond).catch(error => respond({ ok: false, error: error.message }));
    return true;
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    serial(async () => {
      const batch = await read();
      if (!batch) return;
      if (tabId === batch.stagingTabId && batch.phase === '暂存中') {
        if (batch.appendItemIds?.length) return rollbackAppend(batch, '追加视频页面在暂存完成前关闭，原队列已保留。');
        batch.phase = '暂存失败';
        batch.reason = '暂存页面在文件写入完成前关闭，请重新选择本批次视频。';
        await write(batch); await broadcast(batch);
      } else if (tabId === batch.workerTabId && ['上传中', '等待首次协议', '等待微信保存'].includes(batch.phase)) {
        const item = batch.items.find(entry => entry.id === batch.activeItemId);
        await releaseForNextAdd(batch, '当前上传页已关闭；是否保存未知，可继续下一条或重传。');
      }
    });
  });
})();
