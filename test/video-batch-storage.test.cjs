const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { indexedDB } = require('fake-indexeddb');

test('extension IndexedDB keeps every video chunk across service-worker restart', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/video-batch-storage.js'), 'utf8');
  function load() {
    const scope = { indexedDB, Blob };
    scope.globalThis = scope;
    vm.runInNewContext(source, scope);
    return scope.WXHVideoStore;
  }
  const first = load();
  await first.clear();
  await first.put('batch', 'one', 0, new Blob(['first']));
  await first.put('batch', 'two', 0, new Blob(['second']));
  const restarted = load();
  assert.equal(await (await restarted.get('batch', 'one', 0)).text(), 'first');
  assert.equal(await (await restarted.get('batch', 'two', 0)).text(), 'second');
  await restarted.clear();
  assert.equal(await restarted.get('batch', 'one', 0), null);
});
