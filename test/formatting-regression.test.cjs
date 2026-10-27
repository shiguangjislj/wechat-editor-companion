const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { installNativeEditMock } = require('./native-edit-mock.cjs');

const source = fs.readFileSync(path.join(__dirname, '../src/editor-adapter.js'), 'utf8');
const style = { bodySize: 16, bodyColor: '#66b2b8', bodyBg: '#ffffff', align: 'left',
  headingSize: 20, headingColor: '#ffffff', headingBg: '#141917', headingAlign: 'center' };
function fixture(markup, mock = true) {
  const dom = new JSDOM(`<!doctype html><article contenteditable="true">${markup}</article>`, {
    url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit', runScripts: 'outside-only'
  });
  dom.window.Element.prototype.getBoundingClientRect = () => ({ width: 300, height: 150 });
  const commands = mock ? installNativeEditMock(dom.window) : [];
  dom.window.eval(source);
  return { dom, editor: dom.window.document.querySelector('article'), adapter: dom.window.WXHAdapter, commands };
}

test('text formatting uses native insert transaction and preserves links and article content', () => {
  const { dom, editor, adapter, commands } = fixture(
    '<p><span style="color:green!important;font-size:28px!important">正文<a href="/x" style="color:red!important"><u>链接</u></a></span></p>' +
    '<p data-wxh-heading="1"><strong>小标题</strong></p>');
  try {
    const before = adapter.audit(editor);
    const result = adapter.applyTypography(editor, adapter.collectBlocks(editor), style);
    assert.equal(result.ok, true);
    assert.equal(result.changed, 2);
    assert.equal(commands.filter(command => command === 'insertHTML').length, 2);
    assert.equal(adapter.audit(editor), before);
    assert.equal(editor.querySelector('a').getAttribute('href'), '/x');
    assert.equal(editor.querySelector('p span').style.color, 'rgb(102, 178, 184)');
    assert.equal(editor.querySelector('p span').style.fontSize, '16px');
    const heading = editor.querySelectorAll('p')[1];
    assert.equal(heading.querySelector('span span').style.backgroundColor, 'rgb(20, 25, 23)');
    assert.equal(heading.style.textAlign, 'center');
  } finally { dom.window.close(); }
});

test('native editor rejection is reported and does not fall back to DOM-only styling', () => {
  const { dom, editor, adapter } = fixture('<p>正文</p>', false);
  try {
    const before = editor.innerHTML;
    const result = adapter.applyTypography(editor, adapter.collectBlocks(editor), style);
    assert.equal(result.ok, false);
    assert.equal(editor.innerHTML, before);
    assert.match(result.reason, /未接受/);
  } finally { dom.window.close(); }
});

test('applying another template updates the same text frame without nesting frames', () => {
  const { dom, editor, adapter } = fixture('<p>正文</p><p data-wxh-heading="1">小标题</p>');
  try {
    assert.equal(adapter.applyTypography(editor, adapter.collectBlocks(editor), style).ok, true);
    const second = { ...style, bodyColor: '#111111', headingBg: '#eeeeee' };
    assert.equal(adapter.applyTypography(editor, adapter.collectBlocks(editor), second).ok, true);
    assert.equal(editor.querySelectorAll('[data-wxh-text-frame]').length, 2);
    assert.equal(editor.querySelectorAll('[data-wxh-heading-ink]').length, 1);
    assert.equal(editor.textContent, '正文小标题');
  } finally { dom.window.close(); }
});

test('heading color replaces legacy black background and native red highlight without leaving patches', () => {
  const { dom, editor, adapter } = fixture(
    '<p data-wxh-heading="1"><span data-wxh-heading-ink="1" style="background-color:#141917!important;padding:0 8px">' +
    '<span style="background-color:#ff4c41!important">切入点&文章思路</span></span><br>' +
    '<span data-wxh-heading-ink="1" style="background-color:#141917!important">一</span></p>');
  try {
    const before = adapter.audit(editor);
    const result = adapter.applyTypography(editor, adapter.collectBlocks(editor),
      { ...style, headingBg: '#ff4c41' });
    assert.equal(result.ok, true);
    assert.equal(result.reconcile().visibleCount, 1);
    assert.equal(adapter.audit(editor), before);
    const inks = editor.querySelectorAll('[data-wxh-heading-ink]');
    assert.equal(inks.length, 1);
    assert.equal(inks[0].style.backgroundColor, 'rgb(255, 76, 65)');
    assert.equal(editor.querySelectorAll('[style*="background-color: rgb(20, 25, 23)"]').length, 0);
    assert.equal(editor.querySelectorAll('br').length, 1);
    assert.equal(editor.querySelectorAll('[data-wxh-text-frame]').length, 1);
    assert.ok([...inks[0].querySelectorAll('*')].every(node => !node.style.backgroundColor));
  } finally { dom.window.close(); }
});

test('text panel invokes native edit command', async () => {
  const { dom, editor, commands } = fixture('<p><span style="color:green">正文</span></p>');
  const { window } = dom;
  window.__WXH_TEST__ = true;
  window.eval(fs.readFileSync(path.join(__dirname, '../src/content.js'), 'utf8'));
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    const shadow = window.document.querySelector('[data-wxh-ui="root"]').shadowRoot;
    shadow.querySelector('.ball').click();
    shadow.querySelector('[data-action="text"]').click();
    shadow.querySelector('[data-action="apply-text"]').click();
    assert.ok(commands.includes('insertHTML'));
    assert.equal(editor.querySelector('p span').style.fontSize, '16px');
  } finally { window.close(); }
});
