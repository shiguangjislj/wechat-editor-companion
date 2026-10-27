const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('video panel accepts one file selection without plugin originality controls', async () => {
  const dom = new JSDOM('<!doctype html><body><h1>添加视频</h1></body>', {
    url: 'http://localhost:4180/test/video-upload-fixture.html?action=video_edit', runScripts: 'outside-only'
  });
  const { window } = dom;
  window.__WXH_TEST__ = true;
  window.__WXH_VIDEO_TEST__ = true;
  window.URL.createObjectURL = () => '/mock-video';
  window.URL.revokeObjectURL = () => {};
  window.crypto.randomUUID = () => String(Math.random());
  window.eval(fs.readFileSync(path.join(__dirname, '../src/editor-adapter.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(__dirname, '../src/content.js'), 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 20));
  try {
    const shadow = window.document.querySelector('[data-wxh-ui="root"]').shadowRoot;
    assert.equal(shadow.querySelector('.panel').classList.contains('open'), true);
    assert.match(shadow.querySelector('h2.title').textContent, /批量上传视频/);
    const input = shadow.querySelector('#wxh-files');
    assert.ok(input);
    const file = new window.File([new Uint8Array(64)], '日常记录.mov', { type: 'video/quicktime', lastModified: 1 });
    Object.defineProperty(input, 'files', { get: () => [file] });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(shadow.querySelector('.video-main input').value, '日常记录');
    assert.equal(shadow.querySelector('[data-original-id]'), null);
    assert.equal(shadow.querySelector('[data-action="original-all"]'), null);
    assert.equal(shadow.querySelector('[data-action="upload-next"]').disabled, true); // Fixture cannot submit to WeChat.
  } finally { window.close(); }
});
