/* One native WeChat upload page handles one video. This adapter performs only
 * visible DOM actions and checks each result; it never calls private APIs. */
(() => {
  'use strict';
  if (location.hostname !== 'mp.weixin.qq.com' || window.top !== window) return;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const onMaterialPage = () => /(?:\/cgi-bin\/filepage|\/cgi-bin\/filemanage|action=(?:video_list|list_video)|videomsg_list)/.test(location.href) ||
    ([...document.querySelectorAll('input[placeholder]')].some(input => /搜索视频/.test(input.placeholder)) &&
      /视频\s*[（(]\s*共\s*\d+\s*条/.test(document.body?.textContent || ''));
  const rpc = async payload => {
    const reply = await chrome.runtime.sendMessage(payload);
    if (!reply?.ok) throw new Error(reply?.error || '批次通信失败。');
    return reply;
  };
  const text = node => (node?.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = node => Boolean(node && node.isConnected && node.getClientRects().length &&
    getComputedStyle(node).visibility !== 'hidden');
  const outsidePanel = node => !node.closest('[data-wxh-ui]');
  const controls = () => [...document.querySelectorAll('button,a,label,[role="button"],input')]
    .filter(node => outsidePanel(node) && visible(node));
  const findButton = label => controls().find(node => !node.disabled && text(node) === label);
  const findLabel = pattern => [...document.querySelectorAll('label,span,div,p')]
    .filter(node => outsidePanel(node) && visible(node) && pattern.test(text(node)) && text(node).length < 90)
    .sort((a, b) => text(a).length - text(b).length)[0];
  const send = (task, kind, extra = {}) => rpc({ type: 'wxh.batch.worker-event', batchId: task.batchId,
    itemId: task.item.id, kind, materialList: onMaterialPage(), ...extra });
  async function waitFor(check, limitMs, message) {
    const until = Date.now() + limitMs;
    while (Date.now() < until) {
      const value = check();
      if (value) return value;
      await pause(900);
    }
    throw new Error(message);
  }
  function nativeVideoInput() {
    return [...document.querySelectorAll('input[type="file"]')].find(input => {
      const accept = (input.accept || '').toLowerCase();
      return outsidePanel(input) && (accept.includes('video') || accept.includes('.mp4') || accept.includes('.mov'));
    });
  }
  async function receiveFile(task) {
    const parts = [];
    const size = task.item.fileSize;
    for (let offset = 0; offset < size; offset += 4 * 1024 * 1024) {
      const length = Math.min(4 * 1024 * 1024, size - offset);
      const result = await rpc({ type: 'wxh.batch.chunk', itemId: task.item.id, offset, length });
      if (!(result.blob instanceof Blob) || result.blob.size !== length) throw new Error('文件分片校验失败，未送入微信。');
      parts.push(result.blob);
      if (parts.length % 8 === 0) await send(task, 'stage', { status: '传递文件', reason: `${Math.round((offset + length) / size * 100)}%` });
    }
    return new File(parts, task.item.fileName, { type: task.item.fileType || 'application/octet-stream', lastModified: task.item.fileModified });
  }
  function setFile(input, file) {
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.files?.[0]?.size === file.size;
  }
  function uploadFinished() {
    // Check only the native upload area. Old/hidden errors elsewhere in
    // WeChat's document must not stop a successfully uploaded current video.
    const input = nativeVideoInput();
    const uploadArea = text(input?.parentElement?.parentElement);
    if (/上传失败|视频上传失败|转码失败/.test(uploadArea) && !/上传成功/.test(uploadArea))
      throw new Error('当前视频的微信上传控件显示失败。');
    const cover = coverRow();
    return Boolean(cover && cover.querySelectorAll('img').length > 0 &&
      /上传成功|重新上传/.test(uploadArea));
  }
  function coverRow() {
    const label = findLabel(/^封面$/);
    if (!label) return null;
    let node = label;
    for (let i = 0; node && i < 5; i++, node = node.parentElement) {
      if (node.querySelectorAll('img').length >= 1 && node.querySelectorAll('img').length <= 12 &&
          text(node).length < 350 && !/原创声明|服务规则/.test(text(node))) return node;
    }
    return null;
  }
  function firstRecommendedCover() {
    const row = coverRow();
    if (!row) return null;
    const image = [...row.querySelectorAll('img')].find(img => visible(img) && img.naturalWidth !== 0);
    return image?.closest('button,[role="button"],li,label') || image || null;
  }
  function titleInput() {
    const inputs = [...document.querySelectorAll('input[type="text"],input:not([type]),textarea')]
      .filter(input => outsidePanel(input) && visible(input));
    return inputs.find(input => /标题/.test(`${input.placeholder || ''} ${input.ariaLabel || ''}`)) ||
      inputs.find(input => input.maxLength === 64 && /标题/.test(text(input.parentElement?.parentElement)));
  }
  function fillTitle(input, title) {
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, title);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value === title;
  }
  function checkboxNear(labelPattern, allowSwitch = false) {
    const label = findLabel(labelPattern);
    if (!label) return null;
    if (label.matches('label') && label.querySelector('input[type="checkbox"]')) return label.querySelector('input[type="checkbox"]');
    let node = label;
    for (let i = 0; node && i < 4; i++, node = node.parentElement) {
      const input = node.querySelector(allowSwitch ? 'input[type="checkbox"],[role="switch"],button[aria-checked]' : 'input[type="checkbox"]');
      if (input && outsidePanel(input)) return input;
    }
    return null;
  }
  function checked(input) {
    if (!input) return false;
    return input.matches('input') && input.type === 'checkbox' ? input.checked : input.getAttribute('aria-checked') === 'true';
  }
  function nativeClick(input) {
    if (!checked(input) && !input.disabled && input.getAttribute('aria-disabled') !== 'true') input.click();
    return checked(input);
  }
  function agreement() {
    const label = findLabel(/我已阅读并同意.*公众号平台视频上传服务规则/);
    if (!label) return null;
    const input = label.matches('label') ? label.querySelector('input[type="checkbox"]') : checkboxNear(/我已阅读并同意.*公众号平台视频上传服务规则/);
    const href = label.querySelector('a[href]')?.getAttribute('href') || '';
    return input ? { input, signature: `${text(label)}|${href}` } : null;
  }
  function savedInLibrary(task) {
    if (!onMaterialPage()) return false;
    const after = task.item.saveIntentAt;
    if (!after) return false;
    const title = task.item.savedTitle || task.item.title;
    const selector = 'tr,[role="row"],li,article,[class*="item"],[class*="row"],[class*="video"]';
    const rows = [...document.querySelectorAll(selector)];
    // The material list may use unnamed divs instead of tr/item classes.
    // Walk upward from a short title element to include sibling status/time.
    const titleNodes = [...document.querySelectorAll('span,a,div,p')]
      .filter(node => outsidePanel(node) && visible(node) && text(node).includes(title) && text(node).length < 180);
    for (const node of titleNodes) {
      let parent = node.parentElement;
      for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
        if (text(parent).length > 650) break;
        rows.push(parent);
      }
    }
    const matches = rows.filter(node => outsidePanel(node) && visible(node) && text(node).includes(title) && text(node).length < 400)
      .sort((a, b) => text(a).length - text(b).length);
    return matches.some(node => {
      const content = text(node);
      if (!/转码中|审核中|已通过|已保存|原创校验失败|处理中/.test(content)) return false;
      const full = content.match(/(20\d{2})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
      // textContent joins adjacent cells without spaces. The last clock value
      // is the update time; an earlier one can be the video's duration.
      const clocks = [...content.matchAll(/(?:^|[^\d])(\d{1,2}):(\d{2})(?!\d)/g)];
      if (clocks.length > 2) return false; // This is likely a list wrapper containing multiple videos.
      const short = clocks.at(-1);
      if (!full && !short) return false;
      const saved = new Date(after);
      const time = full ? new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4]), Number(full[5])).getTime() :
        new Date(saved.getFullYear(), saved.getMonth(), saved.getDate(), Number(short[1]), Number(short[2])).getTime();
      return time >= after - 120000 && time <= Date.now() + 120000;
    });
  }
  async function verify(task) {
    const found = await waitFor(() => savedInLibrary(task), 60000,
      '当前“素材库→视频”页未匹配到本次视频；状态保留为待核对，可继续下一条或重传。');
    if (found) await send(task, 'verified', { evidence: `素材库→视频列表已匹配：${task.item.savedTitle || task.item.title}` });
  }
  let saveSubmitted = false;
  async function upload(task) {
    const input = await waitFor(nativeVideoInput, 30000, '未找到微信原生视频文件控件。');
    await send(task, 'stage', { status: '传递文件' });
    const file = await receiveFile(task);
    if (!setFile(input, file)) throw new Error('微信原生文件控件没有接受视频。');
    saveSubmitted = false;
    let saveIntent = null;
    const onNativeSave = event => {
      const control = event.target.closest?.('button,a,[role="button"]');
      if (!control || !outsidePanel(control) || text(control) !== '保存') return;
      saveSubmitted = true;
      task.item.saveIntentAt = Date.now();
      saveIntent = send(task, 'save-intent', { savedTitle: titleInput()?.value?.trim() || task.item.title });
      document.removeEventListener('click', onNativeSave, true);
    };
    // Watch Save as soon as WeChat receives the file. Its progress wording or
    // recommended covers may differ, while a user can still finish and save.
    document.addEventListener('click', onNativeSave, true);
    try {
      await send(task, 'stage', { status: '微信上传中' });
      await waitFor(() => saveSubmitted || uploadFinished(), 15 * 60 * 1000,
        '微信上传、转码或推荐封面生成超过15分钟，请在原生页面核对。');
      if (!saveSubmitted) {
        const first = await waitFor(() => saveSubmitted || firstRecommendedCover(), 30000,
          '未能确认微信生成的第1张推荐封面，已停止自动设置。');
        if (!saveSubmitted) first.click();
      }
      if (!saveSubmitted) {
        const title = await waitFor(() => saveSubmitted || titleInput(), 15000, '微信原生标题框未出现。');
        if (!saveSubmitted && !fillTitle(title, task.item.title)) throw new Error('标题未被微信控件接受，已停止自动设置。');
      }
      if (!saveSubmitted) {
        const rule = await waitFor(() => saveSubmitted || agreement(), 15000, '未找到微信视频上传服务规则复选框。');
        if (!saveSubmitted && task.agreementAccepted && task.agreementSignature === rule.signature) {
          if (!nativeClick(rule.input)) throw new Error('微信协议复选框未接受自动勾选。');
        } else if (!saveSubmitted) {
          await send(task, 'stage', { status: '等待首次协议', reason: '请在微信原生页面亲自阅读并勾选服务规则。' });
          const confirmed = await waitFor(() => {
            if (saveSubmitted) return true;
            const current = agreement();
            return current?.signature === rule.signature && current.input.checked ? current : null;
          }, 10 * 60 * 1000, '等待用户确认微信服务规则超时。');
          if (!saveSubmitted) await send(task, 'agreement', { signature: confirmed.signature });
        }
      }
      if (!saveSubmitted) {
        await waitFor(() => saveSubmitted || findButton('保存'), 30000, '微信原生保存按钮未就绪。');
        if (!saveSubmitted) await send(task, 'stage', { status: '等待微信保存', reason: '请在微信页面选择是否原创，然后点击原生“保存”。' });
      }
      // Originality and the final Save remain native user decisions.
      await waitFor(() => saveSubmitted, 10 * 60 * 1000, '等待用户在微信页面保存视频超时。');
      if (saveIntent) await saveIntent;
      await verify(task);
    } finally { document.removeEventListener('click', onNativeSave, true); }
  }
  async function boot() {
    const task = (await rpc({ type: 'wxh.batch.worker-hello', materialList: onMaterialPage() })).task;
    if (!task) return;
    const addPage = /(?:action=video_edit|videomsg_edit)/.test(location.href);
    try {
      if (addPage && task.item.status === '等待原生上传页') await upload(task);
      else if (!addPage && task.item.status !== '等待原生上传页') await verify(task);
      // An Add page can be opened after a prior page navigated. Do not mistake
      // the old item's transient status for a new upload or a failed reload.
    } catch (error) {
      const unknown = saveSubmitted || !addPage || task.item.status === '保存已提交';
      await send(task, unknown ? 'uncertain' : 'failure', { reason: error.message }).catch(() => {});
    }
  }
  let running = false, rerun = false;
  function start() {
    // Activation can arrive while the initial no-task probe is finishing.
    // Queue that explicit run so the second video's Add page never idles.
    if (running) { rerun = true; return; }
    running = true;
    boot().catch(() => {}).finally(() => {
      running = false;
      if (rerun) { rerun = false; start(); }
    });
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'wxh.batch.update' && onMaterialPage() &&
        message.batch?.phase === '上传中' &&
        message.batch.items?.some(item => item.id === message.batch.activeItemId && item.status === '保存已提交')) {
      start();
      return;
    }
    if (message?.type !== 'wxh.batch.run') return;
    respond({ ok: true });
    start();
  });
  // A fresh material-list page resumes only a previously submitted Save.
  // A fresh Add page waits for the user's explicit "上传此视频" choice.
  start();
})();
