const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function load(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {
    url: 'http://localhost:4180/test/fixture.html', runScripts: 'outside-only'
  });
  const { window } = dom;
  window.__WXH_TEST__ = true;
  window.Element.prototype.getBoundingClientRect = function () {
    return { top: 50, left: 200, width: 90, height: 30, right: 290, bottom: 80 };
  };
  window.eval(fs.readFileSync(path.join(__dirname, '../src/editor-adapter.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(__dirname, '../src/content.js'), 'utf8'));
  return dom;
}

test('video card opens the native toolbar, library tab, and local upload in order', async () => {
  const dom = load('<nav><button id="toolbarVideo">视频</button></nav><article contenteditable="true"><p>正文中的视频文字</p></article>');
  const { window } = dom;
  const { document } = window;
  const actions = [];
  document.querySelector('#toolbarVideo').onclick = () => {
    actions.push('视频');
    window.setTimeout(() => {
      const dialog = document.createElement('div');
      dialog.innerHTML = '<div class="tabs"><button id="library">素材库</button><button>视频链接</button></div><div id="libraryBody"></div>';
      document.body.appendChild(dialog);
      dialog.querySelector('#library').onclick = () => {
        actions.push('素材库');
        window.setTimeout(() => {
          const upload = document.createElement('button');
          upload.textContent = '本地上传';
          upload.onclick = () => actions.push('本地上传');
          dialog.querySelector('#libraryBody').appendChild(upload);
        }, 10);
      };
    }, 10);
  };
  try {
    await new Promise(resolve => window.setTimeout(resolve, 20));
    const shadow = document.querySelector('[data-wxh-ui="root"]').shadowRoot;
    shadow.querySelector('[data-action="videos"]').click();
    await new Promise(resolve => window.setTimeout(resolve, 300));
    assert.deepEqual(actions, ['视频', '素材库', '本地上传']);
    assert.match(shadow.querySelector('#notice').textContent, /已点击“本地上传”/);
  } finally { window.close(); }
});

test('video card uses an already open native picker without reopening the toolbar', async () => {
  const dom = load('<button id="toolbarVideo">视频</button><div><button id="upload">本地上传</button></div>');
  const { window } = dom;
  let toolbarClicks = 0, uploadClicks = 0;
  window.document.querySelector('#toolbarVideo').onclick = () => toolbarClicks++;
  window.document.querySelector('#upload').onclick = () => uploadClicks++;
  try {
    await new Promise(resolve => window.setTimeout(resolve, 20));
    const shadow = window.document.querySelector('[data-wxh-ui="root"]').shadowRoot;
    shadow.querySelector('[data-action="videos"]').click();
    await new Promise(resolve => window.setTimeout(resolve, 20));
    assert.equal(toolbarClicks, 0);
    assert.equal(uploadClicks, 1);
  } finally { window.close(); }
});

test('missing native video toolbar stops with a manual fallback', async () => {
  const dom = load('<article contenteditable="true"><p>视频</p></article>');
  try {
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));
    const shadow = dom.window.document.querySelector('[data-wxh-ui="root"]').shadowRoot;
    shadow.querySelector('[data-action="videos"]').click();
    await new Promise(resolve => dom.window.setTimeout(resolve, 10));
    assert.match(shadow.querySelector('#notice').textContent, /未找到正文工具栏/);
  } finally { dom.window.close(); }
});
