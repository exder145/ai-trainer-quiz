const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const core = require(path.join(root, 'core.js'));
const sync = require(path.join(root, 'sync.js'));

function item(lastAt, markAt, bookmarked) {
  return {
    attempts: 1, correct: 0, wrong: 1, streak: 0,
    lastAt, lastWasCorrect: false, bookmarked, markAt,
  };
}

test('跨设备合并保留最近收藏时间，旧设备不能改回收藏状态', () => {
  const newerAnswer = item('2026-09-28T12:00:00Z', '2026-09-28T09:00:00Z', true);
  const newerBookmark = item('2026-09-28T08:00:00Z', '2026-09-28T11:00:00Z', false);
  const merged = core.mergeItem(newerAnswer, newerBookmark);
  assert.equal(merged.bookmarked, false);
  assert.equal(merged.markAt, '2026-09-28T11:00:00Z');
  const staleDevice = item('2026-09-28T07:00:00Z', '2026-09-28T10:00:00Z', true);
  assert.equal(core.mergeItem(merged, staleDevice).bookmarked, false);
});

test('云端读取失败时不能向 KV 写入空记录', async () => {
  const source = fs.readFileSync(path.join(root, 'worker', 'index.js'), 'utf8');
  const worker = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
  let writes = 0;
  const env = {
    STUDY_KV: {
      get: async () => { throw new Error('temporary KV read failure'); },
      put: async () => { writes += 1; },
    },
  };
  const response = await worker.fetch(new Request('https://quiz.example/api/state?code=TEST1', {
    method: 'POST',
    body: JSON.stringify({ items: { J001: item('2026-09-28T12:00:00Z', null, false) } }),
  }), env);
  assert.equal(response.status, 503);
  assert.equal(writes, 0);
});

test('云端返回写入失败提示时，客户端报告同步失败', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ items: {}, warning: '云端写入失败' }),
  });
  await assert.rejects(sync.push('https://quiz.example/api/state', 'TEST1', {}, fakeFetch), /云端写入失败/);
});
