const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { installNativeEditMock } = require('./native-edit-mock.cjs');

const source = fs.readFileSync(path.join(__dirname, '../src/editor-adapter.js'), 'utf8');
function fixture(mock = true) {
  const dom = new JSDOM('<!doctype html><article contenteditable="true"><p>正文</p><p><img src="one.png" data-media-id="keep" style="width:300px"></p></article>', {
    url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit', runScripts: 'outside-only'
  });
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 300, height: 150 });
  const commands = mock ? installNativeEditMock(window, typeof mock === 'object' ? mock : {}) : [];
  window.eval(source);
  return { dom, editor: window.document.querySelector('article'), adapter: window.WXHAdapter, commands };
}
const options = { radius: 12, shadow: 'soft', border: 'light', align: 'center' };

test('image styling uses native insert and retains source and media attributes', () => {
  const { dom, editor, adapter, commands } = fixture();
  try {
    const before = adapter.audit(editor);
    const result = adapter.applyImageStyle(editor, [editor.querySelector('img')], options);
    assert.equal(result.ok, true);
    assert.ok(commands.includes('insertHTML'));
    assert.equal(adapter.audit(editor), before);
    const image = editor.querySelector('img');
    assert.equal(image.getAttribute('data-media-id'), 'keep');
    assert.equal(image.closest('[data-wxh-image-frame]').style.borderRadius, '12px');
    assert.match(image.closest('[data-wxh-image-frame]').style.boxShadow, /7px 18px/);
    assert.equal(result.reconcile().visibleCount, 1);
    assert.equal(result.snapshot.restore().ok, true);
    assert.equal(editor.querySelector('[data-wxh-image-frame]'), null);
  } finally { dom.window.close(); }
});

test('image style does not claim success when native editing is unavailable', () => {
  const { dom, editor, adapter } = fixture(false);
  try {
    const before = editor.innerHTML;
    const result = adapter.applyImageStyle(editor, [editor.querySelector('img')], options);
    assert.equal(result.ok, false);
    assert.equal(editor.innerHTML, before);
  } finally { dom.window.close(); }
});

test('reapplying image settings replaces the existing frame instead of nesting it', () => {
  const { dom, editor, adapter } = fixture();
  try {
    assert.equal(adapter.applyImageStyle(editor, [editor.querySelector('img')], options).ok, true);
    assert.equal(adapter.applyImageStyle(editor, [editor.querySelector('img')],
      { ...options, radius: 18, shadow: 'strong' }).ok, true);
    assert.equal(editor.querySelectorAll('[data-wxh-image-frame]').length, 1);
    assert.equal(editor.querySelector('[data-wxh-image-frame]').style.borderRadius, '18px');
  } finally { dom.window.close(); }
});

test('batch image styling survives WeChat-style source normalization and lazy loading', () => {
  let insertions = 0;
  const { dom, editor, adapter } = fixture({ afterInsert(current) {
    insertions++;
    const images = current.querySelectorAll('img');
    if (insertions === 1) {
      images[0].setAttribute('src', 'https://mmbiz.qpic.cn/mmbiz_jpg/asset-one/640?wx_fmt=jpeg');
      images[1].setAttribute('src', 'https://mmbiz.qpic.cn/mmbiz_jpg/asset-two/640?wx_fmt=jpeg');
    }
  } });
  try {
    editor.querySelector('img').setAttribute('data-src', 'https://mmbiz.qpic.cn/mmbiz_jpg/asset-one/0');
    editor.lastElementChild.insertAdjacentHTML('afterend',
      '<p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" data-src="https://mmbiz.qpic.cn/mmbiz_jpg/asset-two/0"></p>');
    const result = adapter.applyImageStyle(editor, [...editor.querySelectorAll('img')], options);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.changed, 2);
    assert.equal(result.reconcile().visibleCount, 2);
    assert.equal(editor.querySelectorAll('[data-wxh-image-frame]').length, 2);
  } finally { dom.window.close(); }
});

test('styling image one ignores an unselected image URL change before editing', () => {
  const { dom, editor, adapter } = fixture();
  try {
    editor.insertAdjacentHTML('beforeend', '<p><img src="two-preview.png"></p>');
    const [selected, unselected] = editor.querySelectorAll('img');
    const nativeGetAttribute = unselected.getAttribute.bind(unselected);
    let sourceReads = 0;
    unselected.getAttribute = name => {
      if (name === 'src' && ++sourceReads === 2)
        unselected.setAttribute('src', 'https://mmbiz.qpic.cn/mmbiz_jpg/other-asset/640');
      return nativeGetAttribute(name);
    };
    const result = adapter.applyImageStyle(editor, [selected], options);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.changed, 1);
    assert.equal(result.reconcile().visibleCount, 1);
    assert.equal(editor.querySelectorAll('[data-wxh-image-frame]').length, 1);
  } finally { dom.window.close(); }
});

test('styling image one ignores a later unselected CDN rewrite', () => {
  const { dom, editor, adapter } = fixture({ afterInsert(current) {
    current.querySelectorAll('img')[1].setAttribute('src',
      'https://mmbiz.qpic.cn/mmbiz_jpg/other-asset/640');
  } });
  try {
    editor.insertAdjacentHTML('beforeend', '<p><img src="two-preview.png"></p>');
    const result = adapter.applyImageStyle(editor, [editor.querySelector('img')], options);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.reconcile().visibleCount, 1);
    assert.equal(result.snapshot.restore().ok, true);
  } finally { dom.window.close(); }
});

test('batch stops when the native edit duplicates the selected image', () => {
  const { dom, editor, adapter } = fixture({ afterInsert(current) {
    current.insertAdjacentHTML('beforeend', '<p><img src="one.png"></p>');
  } });
  try {
    const result = adapter.applyImageStyle(editor, [editor.querySelector('img')], options);
    assert.equal(result.ok, false);
    assert.match(result.reason, /重复副本/);
    assert.equal(result.changed, 1);
  } finally { dom.window.close(); }
});

test('one click styles three images across delayed native editor redraws', async () => {
  let model = '', insertions = 0;
  const { dom, editor, adapter } = fixture({ afterInsert(current) {
    const index = insertions++;
    const modelCopy = current.ownerDocument.createElement('div');
    modelCopy.innerHTML = model;
    const styled = current.querySelectorAll('img')[index].closest('[data-wxh-image-frame]');
    modelCopy.querySelectorAll('img')[index].replaceWith(styled.cloneNode(true));
    const nextModel = modelCopy.innerHTML;
    setTimeout(() => { current.innerHTML = nextModel; model = nextModel; }, 80);
  } });
  try {
    editor.insertAdjacentHTML('beforeend', '<p><img src="two.png"></p><p><img src="three.png"></p>');
    model = editor.innerHTML;
    const progress = [];
    const result = await adapter.applyImageStyleBatch(editor, [...editor.querySelectorAll('img')],
      options, (done, total) => progress.push(`${done}/${total}`));
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.changed, 3);
    assert.equal(result.reconcile().visibleCount, 3);
    assert.equal(editor.querySelectorAll('[data-wxh-image-frame]').length, 3);
    assert.deepEqual(progress, ['1/3', '2/3', '3/3']);
  } finally { dom.window.close(); }
});

test('three selected images complete when the host adds an unrelated image', async () => {
  let insertions = 0;
  const { dom, editor, adapter } = fixture({ afterInsert(current) {
    if (++insertions === 3) current.insertAdjacentHTML('beforeend', '<p><img src="extra.png"></p>');
  } });
  try {
    editor.insertAdjacentHTML('beforeend', '<p><img src="two.png"></p><p><img src="three.png"></p>');
    const result = await adapter.applyImageStyleBatch(editor, [...editor.querySelectorAll('img')], options);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.changed, 3);
    assert.equal(result.reconcile().visibleCount, 3);
    assert.equal(editor.querySelectorAll('img').length, 4);
  } finally { dom.window.close(); }
});

test('batch undo restores three images across delayed native redraws', async () => {
  let model = '', insertions = 0;
  const { dom, editor, adapter } = fixture({ afterInsert(current) {
    if (insertions >= 3) {
      insertions++;
      const nextModel = current.innerHTML;
      setTimeout(() => { current.innerHTML = nextModel; model = nextModel; }, 80);
      return;
    }
    const index = insertions < 3 ? insertions : 5 - insertions;
    insertions++;
    const modelCopy = current.ownerDocument.createElement('div');
    modelCopy.innerHTML = model;
    const image = current.querySelectorAll('img')[index];
    const modelImage = modelCopy.querySelectorAll('img')[index];
    (modelImage.closest('[data-wxh-image-frame]') || modelImage).replaceWith(
      (image.closest('[data-wxh-image-frame]') || image).cloneNode(true));
    const nextModel = modelCopy.innerHTML;
    setTimeout(() => { current.innerHTML = nextModel; model = nextModel; }, 80);
  } });
  try {
    editor.insertAdjacentHTML('beforeend', '<p><img src="two.png"></p><p><img src="three.png"></p>');
    model = editor.innerHTML;
    const result = await adapter.applyImageStyleBatch(editor, [...editor.querySelectorAll('img')], options);
    assert.equal(result.ok, true, result.reason);
    const undone = await result.snapshot.restore();
    assert.equal(undone.ok, true, undone.reason);
    assert.equal(undone.restored, 3);
    assert.equal(editor.querySelectorAll('[data-wxh-image-frame]').length, 0);
    assert.equal(editor.querySelectorAll('img').length, 3);
  } finally { dom.window.close(); }
});

test('undo does not claim success if the host redraws the applied style back', async () => {
  let insertions = 0, appliedHtml = '';
  const { dom, editor, adapter } = fixture({ afterInsert(current) {
    insertions++;
    if (insertions === 1) appliedHtml = current.innerHTML;
    else setTimeout(() => { current.innerHTML = appliedHtml; }, 80);
  } });
  try {
    const result = await adapter.applyImageStyleBatch(editor, [editor.querySelector('img')], options);
    assert.equal(result.ok, true, result.reason);
    const undone = await result.snapshot.restore();
    assert.equal(undone.ok, false);
    assert.match(undone.reason, /撤销未完成/);
    assert.equal(editor.querySelectorAll('[data-wxh-image-frame]').length, 1);
  } finally { dom.window.close(); }
});

test('batch undo preserves later unselected images and article edits', async () => {
  const { dom, editor, adapter } = fixture();
  try {
    editor.insertAdjacentHTML('beforeend',
      '<p><img src="two.png"></p><p><img src="three.png"></p><p><img src="four.png"></p>');
    const selected = [...editor.querySelectorAll('img')].slice(0, 3);
    const result = await adapter.applyImageStyleBatch(editor, selected, options);
    assert.equal(result.ok, true, result.reason);
    editor.querySelectorAll('img')[3].src = 'https://mmbiz.qpic.cn/mmbiz_jpg/other/640';
    editor.insertAdjacentHTML('beforeend', '<p>后来补充的正文</p>');
    const undone = await result.snapshot.restore();
    assert.equal(undone.ok, true, undone.reason);
    assert.equal(editor.querySelectorAll('[data-wxh-image-frame]').length, 0);
    assert.equal(editor.querySelectorAll('img')[3].getAttribute('src'),
      'https://mmbiz.qpic.cn/mmbiz_jpg/other/640');
    assert.match(editor.textContent, /后来补充的正文/);
  } finally { dom.window.close(); }
});

test('batch undo restores an earlier image style instead of removing it', async () => {
  const { dom, editor, adapter } = fixture();
  try {
    assert.equal(adapter.applyImageStyle(editor, [editor.querySelector('img')], options).ok, true);
    const previous = editor.querySelector('[data-wxh-image-frame]').style.borderRadius;
    const result = await adapter.applyImageStyleBatch(editor, [editor.querySelector('img')],
      { ...options, radius: 24 });
    assert.equal(result.ok, true, result.reason);
    const undone = await result.snapshot.restore();
    assert.equal(undone.ok, true, undone.reason);
    assert.equal(editor.querySelectorAll('[data-wxh-image-frame]').length, 1);
    assert.equal(editor.querySelector('[data-wxh-image-frame]').style.borderRadius, previous);
  } finally { dom.window.close(); }
});

test('native URL rewrite is accepted for the submitted image even if WeChat strips optional keys', () => {
  const { dom, editor, adapter } = fixture({ afterInsert(current) {
    const frame = current.querySelector('[data-wxh-image-frame]');
    const image = frame.querySelector('img');
    image.setAttribute('src', 'https://mmbiz.qpic.cn/mmbiz_jpg/new-media-id/640');
    image.removeAttribute('data-wxh-asset-key');
    frame.removeAttribute('data-wxh-asset-key');
  } });
  try {
    const result = adapter.applyImageStyle(editor, [editor.querySelector('img')], options);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.reconcile().visibleCount, 1);
    assert.equal(editor.querySelectorAll('img').length, 1);
  } finally { dom.window.close(); }
});

test('image panel sends selected image through native edit command', async () => {
  const { dom, editor, commands } = fixture();
  const { window } = dom;
  window.__WXH_TEST__ = true;
  window.eval(fs.readFileSync(path.join(__dirname, '../src/content.js'), 'utf8'));
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    const shadow = window.document.querySelector('[data-wxh-ui="root"]').shadowRoot;
    shadow.querySelector('.ball').click();
    shadow.querySelector('[data-action="images"]').click();
    shadow.querySelector('[data-action="apply-images"]').click();
    assert.ok(commands.includes('insertHTML'));
    assert.equal(editor.querySelector('img').closest('[data-wxh-image-frame]').style.borderRadius, '12px');
  } finally { window.close(); }
});

test('image panel processes three checked images from a single click', async () => {
  const { dom, editor, commands } = fixture();
  const { window } = dom;
  window.__WXH_TEST__ = true;
  editor.insertAdjacentHTML('beforeend', '<p><img src="two.png"></p><p><img src="three.png"></p>');
  window.eval(fs.readFileSync(path.join(__dirname, '../src/content.js'), 'utf8'));
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    const shadow = window.document.querySelector('[data-wxh-ui="root"]').shadowRoot;
    shadow.querySelector('.ball').click();
    shadow.querySelector('[data-action="images"]').click();
    assert.equal(shadow.querySelector('#imageCount').textContent, '3/3张已选');
    shadow.querySelector('[data-action="apply-images"]').click();
    const deadline = Date.now() + 3500;
    while (editor.querySelectorAll('[data-wxh-image-frame]').length < 3 && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(editor.querySelectorAll('[data-wxh-image-frame]').length, 3);
    assert.equal(commands.filter(command => command === 'insertHTML').length, 3);
  } finally { window.close(); }
});

test('image panel enables undo until the restored style is verified', async () => {
  const { dom, editor } = fixture();
  const { window } = dom;
  window.__WXH_TEST__ = true;
  window.eval(fs.readFileSync(path.join(__dirname, '../src/content.js'), 'utf8'));
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    const shadow = window.document.querySelector('[data-wxh-ui="root"]').shadowRoot;
    shadow.querySelector('.ball').click();
    shadow.querySelector('[data-action="images"]').click();
    shadow.querySelector('[data-action="apply-images"]').click();
    const deadline = Date.now() + 3500;
    while (shadow.querySelector('[data-action="undo-images"]')?.disabled && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(shadow.querySelector('[data-action="undo-images"]').disabled, false);
    shadow.querySelector('[data-action="undo-images"]').click();
    while (editor.querySelector('[data-wxh-image-frame]') && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(editor.querySelector('[data-wxh-image-frame]'), null);
    while (!shadow.querySelector('#notice')?.textContent.includes('已复核恢复') && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(shadow.querySelector('#notice').textContent, /已复核恢复1张图片/);
    assert.equal(shadow.querySelector('[data-action="undo-images"]').disabled, true);
  } finally { window.close(); }
});
