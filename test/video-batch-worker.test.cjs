const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('one native page selects first cover, fills defaults, saves, and verifies material identity', async () => {
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dom = new JSDOM(`<!doctype html><body><aside>历史记录：视频上传或转码失败</aside><main>
    <div class="row"><label>上传视频</label><input id="video" type="file" accept="video/mp4"><span id="upload">等待上传</span></div>
    <div class="row"><label>封面</label><img id="cover" src="data:image/png;base64,AA=="><img src="data:image/png;base64,AA=="></div>
    <div class="row"><label>标题</label><input id="title" type="text" maxlength="64" placeholder="视频标题"></div>
    <div class="row"><label>原创声明</label><input id="original" type="checkbox"></div>
    <label><input id="rules" type="checkbox" checked>我已阅读并同意公众号平台视频上传服务规则</label>
    <button id="save">保存</button></main></body>`, {
    url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=video_edit', runScripts: 'outside-only'
  });
  const { window } = dom;
  window.Element.prototype.getClientRects = () => [{ width: 100, height: 30 }];
  Object.defineProperty(window.HTMLImageElement.prototype, 'naturalWidth', { get: () => 100 });
  window.DataTransfer = class {
    constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; }
  };
  let nativeFile, coverChosen = false, titleAtSave, originalAtSave, rulesAtSave, originalBeforeUserChoice;
  const input = window.document.querySelector('#video');
  Object.defineProperty(input, 'files', { get: () => nativeFile ? [nativeFile] : [], set: files => { nativeFile = files[0]; } });
  input.onchange = () => { window.document.querySelector('#upload').textContent = '视频上传成功'; };
  window.document.querySelector('#cover').onclick = () => { coverChosen = true; };
  window.document.querySelector('#save').onclick = () => {
    titleAtSave = window.document.querySelector('#title').value;
    originalAtSave = window.document.querySelector('#original').checked;
    rulesAtSave = window.document.querySelector('#rules').checked;
    window.history.replaceState(null, '', '/cgi-bin/appmsg?action=video_list');
    window.document.body.innerHTML = `<main><article class="video-card">测试视频 · ${timestamp} · 转码中</article></main>`;
  };
  const events = [];
  window.chrome = { runtime: { onMessage: { addListener: () => {} }, sendMessage: async message => {
    if (message.type === 'wxh.batch.worker-hello') return { ok: true, task: {
      batchId: 'batch', item: { id: 'one', title: '测试视频', fileName: '测试视频.mp4', fileType: 'video/mp4',
        fileSize: 5, fileModified: 1, duration: 20, status: '等待原生上传页', activatedAt: Date.now() }, agreementAccepted: false
    } };
    if (message.type === 'wxh.batch.chunk') return { ok: true, blob: new window.Blob([new Uint8Array(5)]) };
    if (message.type === 'wxh.batch.worker-event') { events.push(message); return { ok: true }; }
    throw new Error(`Unexpected message: ${message.type}`);
  } } };
  const source = fs.readFileSync(path.join(__dirname, '../src/video-batch-worker.js'), 'utf8');
  window.eval(source);
  const manualSave = setInterval(() => {
    if (!events.some(event => event.kind === 'stage' && event.status === '等待微信保存')) return;
    originalBeforeUserChoice = window.document.querySelector('#original').checked;
    window.document.querySelector('#original').checked = true; // User's native choice.
    window.document.querySelector('#save').click();
    clearInterval(manualSave);
  }, 10);
  try {
    const until = Date.now() + 4000;
    while (!events.some(event => event.kind === 'verified') && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(nativeFile?.name, '测试视频.mp4');
    assert.equal(coverChosen, true);
    assert.equal(titleAtSave, '测试视频');
    assert.equal(originalBeforeUserChoice, false);
    assert.equal(originalAtSave, true);
    assert.equal(rulesAtSave, true);
    assert.ok(events.some(event => event.kind === 'agreement'));
    assert.ok(events.some(event => event.kind === 'save-intent' && event.savedTitle === '测试视频'));
    assert.ok(events.some(event => event.kind === 'verified'));
    assert.equal(events.some(event => ['failure', 'uncertain'].includes(event.kind)), false);
  } finally { clearInterval(manualSave); window.close(); }
});

test('native Save is observed even when WeChat never shows the expected upload-success wording', async () => {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dom = new JSDOM('<!doctype html><body><main><div><label>上传视频</label><input id="video" type="file" accept="video/mp4"><span>处理中</span></div><div><label>标题</label><input id="title" type="text" placeholder="视频标题" value="已保存视频"></div><button id="save">保存</button></main></body>', {
    url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=video_edit', runScripts: 'outside-only'
  });
  const { window } = dom;
  window.Element.prototype.getClientRects = () => [{ width: 100, height: 30 }];
  window.DataTransfer = class {
    constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; }
  };
  let nativeFile;
  Object.defineProperty(window.document.querySelector('#video'), 'files', {
    get: () => nativeFile ? [nativeFile] : [], set: files => { nativeFile = files[0]; }
  });
  const task = { batchId: 'batch', item: { id: 'one', title: '已保存视频', fileName: '已保存视频.mp4',
    fileType: 'video/mp4', fileSize: 5, fileModified: 1, status: '等待原生上传页' } };
  const events = [];
  window.chrome = { runtime: { onMessage: { addListener: () => {} }, sendMessage: async message => {
    if (message.type === 'wxh.batch.worker-hello') return { ok: true, task };
    if (message.type === 'wxh.batch.chunk') return { ok: true, blob: new window.Blob([new Uint8Array(5)]) };
    if (message.type === 'wxh.batch.worker-event') { events.push(message); return { ok: true }; }
    throw new Error(`Unexpected message: ${message.type}`);
  } } };
  window.document.querySelector('#save').onclick = () => {
    window.history.replaceState(null, '', '/cgi-bin/appmsg?action=list_video');
    window.document.body.innerHTML = `<h1>素材库</h1><input placeholder="搜索视频"><h2>视频（共16条）</h2><div class="material-entry"><span>00:00</span><span>已保存视频</span><span>已通过</span><span>${stamp.slice(11)}</span></div>`;
  };
  window.eval(fs.readFileSync(path.join(__dirname, '../src/video-batch-worker.js'), 'utf8'));
  try {
    const untilUpload = Date.now() + 1500;
    while (!events.some(event => event.kind === 'stage' && event.status === '微信上传中') && Date.now() < untilUpload)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(nativeFile);
    window.document.querySelector('#save').click();
    const untilVerified = Date.now() + 2500;
    while (!events.some(event => event.kind === 'verified') && Date.now() < untilVerified)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(events.some(event => event.kind === 'save-intent'));
    assert.ok(events.some(event => event.kind === 'verified'));
  } finally { window.close(); }
});

test('explicit activation is not lost while the new Add page initial probe is pending', async () => {
  const dom = new JSDOM('<!doctype html><body><h1>添加视频</h1></body>', {
    url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=video_edit', runScripts: 'outside-only'
  });
  const { window } = dom;
  let resolveFirst, listener, hellos = 0;
  window.chrome = { runtime: {
    sendMessage: async message => {
      if (message.type !== 'wxh.batch.worker-hello') throw new Error('unexpected request');
      hellos++;
      return hellos === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : { ok: true, task: null };
    },
    onMessage: { addListener: handler => { listener = handler; } }
  } };
  window.eval(fs.readFileSync(path.join(__dirname, '../src/video-batch-worker.js'), 'utf8'));
  try {
    let response;
    listener({ type: 'wxh.batch.run' }, {}, value => { response = value; });
    assert.equal(response.ok, true);
    resolveFirst({ ok: true, task: null });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(hellos, 2);
  } finally { window.close(); }
});

test('material-library page verifies saved item when Save intent arrives from another tab', async () => {
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dom = new JSDOM(`<!doctype html><body><h1>素材库</h1><nav>视频</nav><input placeholder="搜索视频"><h2>视频（共15条）</h2><main><div class="material-entry"><div><span>00:40</span><span>跨页素材</span></div><div>审核中</div><div>${timestamp.slice(11)}</div></div></main></body>`, {
    url: 'https://mp.weixin.qq.com/cgi-bin/material_unknown', runScripts: 'outside-only'
  });
  const { window } = dom;
  window.Element.prototype.getClientRects = () => [{ width: 100, height: 30 }];
  let listener;
  const events = [];
  const task = { batchId: 'batch', item: { id: 'one', title: '原文件名', savedTitle: '跨页素材',
    status: '保存已提交', saveIntentAt: Date.now() } };
  window.chrome = { runtime: {
    onMessage: { addListener: handler => { listener = handler; } },
    sendMessage: async message => {
      if (message.type === 'wxh.batch.worker-hello') {
        assert.equal(message.materialList, true);
        return { ok: true, task };
      }
      if (message.type === 'wxh.batch.worker-event') { events.push(message); return { ok: true }; }
      throw new Error(`Unexpected message: ${message.type}`);
    }
  } };
  window.eval(fs.readFileSync(path.join(__dirname, '../src/video-batch-worker.js'), 'utf8'));
  try {
    listener({ type: 'wxh.batch.update', batch: { phase: '上传中', activeItemId: 'one', items: [task.item] } }, {}, () => {});
    const until = Date.now() + 1000;
    while (!events.some(event => event.kind === 'verified') && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(events.some(event => event.kind === 'verified'));
  } finally { window.close(); }
});
