const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('a new native Add page opens the video panel with imported and pending items', async () => {
  const dom = new JSDOM('<!doctype html><body><h1>添加视频</h1></body>', {
    url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=video_edit', runScripts: 'outside-only'
  });
  const { window } = dom;
  window.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } }, runtime: {
    getURL: file => `https://example.test/${file}`,
    sendMessage: async () => ({ ok: true, batch: { phase: '待上传', items: [
      { id: 'one', title: '已保存视频', fileName: '已保存视频.mp4', duration: 20, status: '已上传' },
      { id: 'two', title: '下一段视频', fileName: '下一段视频.mp4', duration: 20, status: '待上传' }
    ] } }),
    onMessage: { addListener: () => {} }
  } };
  window.eval(fs.readFileSync(path.join(__dirname, '../src/editor-adapter.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(__dirname, '../src/content.js'), 'utf8'));
  try {
    await new Promise(resolve => setTimeout(resolve, 40));
    const shadow = window.document.querySelector('[data-wxh-ui="root"]').shadowRoot;
    assert.equal(shadow.querySelector('.panel').classList.contains('open'), true);
    assert.match(shadow.querySelector('h2.title').textContent, /批量上传视频/);
    assert.deepEqual([...shadow.querySelectorAll('.badge')].map(node => node.textContent), ['已上传', '待上传']);
    assert.match(shadow.querySelector('#queueCount').textContent, /1个已上传 · 0个待核对 · 1个待上传/);
    assert.equal(shadow.querySelector('[data-action="original-all"]'), null);
    assert.equal(shadow.querySelector('[data-original-id]'), null);
    assert.ok(shadow.querySelector('#wxh-files'));
    assert.match(shadow.querySelector('.file-zone').textContent, /继续添加视频/);
    assert.ok(shadow.querySelector('[data-action="upload-this"]').classList.contains('upload-inline'));
    assert.equal(shadow.querySelector('.tip'), null);
    assert.equal(shadow.querySelector('[data-action="upload-next"]').disabled, false);
  } finally { window.close(); }
});

test('pending verification does not hide the next upload or retry controls', async () => {
  const dom = new JSDOM('<!doctype html><body><h1>添加视频</h1></body>', {
    url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=video_edit', runScripts: 'outside-only'
  });
  const { window } = dom;
  window.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } }, runtime: {
    getURL: file => `https://example.test/${file}`,
    sendMessage: async () => ({ ok: true, batch: { phase: '待上传', items: [
      { id: 'one', title: '前一条', fileName: '前一条.mp4', status: '待核对', reason: '尚未核验' },
      { id: 'two', title: '下一条', fileName: '下一条.mp4', status: '待上传' }
    ] } }),
    onMessage: { addListener: () => {} }
  } };
  window.eval(fs.readFileSync(path.join(__dirname, '../src/editor-adapter.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(__dirname, '../src/content.js'), 'utf8'));
  try {
    await new Promise(resolve => setTimeout(resolve, 40));
    const shadow = window.document.querySelector('[data-wxh-ui="root"]').shadowRoot;
    assert.equal(shadow.querySelector('[data-action="upload-next"]').disabled, false);
    assert.equal(shadow.querySelector('[data-video-id="one"] [data-action="retry-upload"]').disabled, false);
    assert.equal(shadow.querySelector('[data-video-id="two"] [data-action="upload-this"]').disabled, false);
    assert.match(shadow.querySelector('#queueCount').textContent, /1个待核对 · 1个待上传/);
  } finally { window.close(); }
});
