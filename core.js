(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.StudyCore = core;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const VERSION = 1;

  function createState() {
    return { version: VERSION, items: {} };
  }

  function emptyItem() {
    return { attempts: 0, correct: 0, wrong: 0, streak: 0, lastAt: null, lastWasCorrect: null, bookmarked: false, markAt: null };
  }

  function getItem(state, id) {
    return state.items[id] || emptyItem();
  }

  function normalizeAnswer(value) {
    if (Array.isArray(value)) return [...new Set(value)].sort().join('');
    return String(value || '').split('').sort().join('');
  }

  function isCorrect(question, selection) {
    return normalizeAnswer(selection) === normalizeAnswer(question.answer);
  }

  function recordAnswer(state, id, correct, at = new Date().toISOString()) {
    const before = getItem(state, id);
    const item = {
      ...before,
      attempts: before.attempts + 1,
      correct: before.correct + (correct ? 1 : 0),
      wrong: before.wrong + (correct ? 0 : 1),
      streak: correct ? before.streak + 1 : 0,
      lastAt: at,
      lastWasCorrect: Boolean(correct),
    };
    return { ...state, items: { ...state.items, [id]: item } };
  }

  function toggleBookmark(state, id, at = new Date().toISOString()) {
    const item = getItem(state, id);
    return { ...state, items: { ...state.items, [id]: { ...item, bookmarked: !item.bookmarked, markAt: at } } };
  }

  // 合并同一道题在两台设备上的记录：作答按 lastAt 取新的，收藏按 markAt 取新的。
  function mergeItem(left, right) {
    const leftAt = left.lastAt || '';
    const rightAt = right.lastAt || '';
    let base;
    if (leftAt === rightAt) base = left.attempts >= right.attempts ? left : right;
    else base = rightAt > leftAt ? right : left;

    const leftMark = left.markAt || '';
    const rightMark = right.markAt || '';
    let bookmarked;
    if (leftMark === rightMark) bookmarked = left.bookmarked || right.bookmarked;
    else bookmarked = (rightMark > leftMark ? right : left).bookmarked;
    return { ...base, bookmarked, markAt: leftMark >= rightMark ? left.markAt : right.markAt };
  }

  function mergeItems(left, right) {
    const items = { ...left };
    for (const [id, other] of Object.entries(right || {})) {
      if (!other || typeof other !== 'object') continue;
      items[id] = items[id] ? mergeItem(items[id], other) : other;
    }
    return items;
  }

  function mergeStates(left, right) {
    return { version: VERSION, items: mergeItems((left && left.items) || {}, (right && right.items) || {}) };
  }

  function getPool(questions, state, mode = 'all', type = 'all') {
    return questions.filter((question) => {
      if (type !== 'all' && question.type !== type) return false;
      const item = getItem(state, question.id);
      if (mode === 'new') return item.attempts === 0;
      if (mode === 'wrong') return item.wrong > 0;
      if (mode === 'review') return item.wrong > 0 && item.streak < 2;
      if (mode === 'starred') return item.bookmarked;
      return true;
    });
  }

  function selectSession(questions, state, options = {}) {
    const pool = getPool(questions, state, options.mode || 'all', options.type || 'all').slice();
    if (options.shuffle) {
      const random = options.random || Math.random;
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
    }
    const count = Number.isInteger(options.count) && options.count > 0 ? options.count : pool.length;
    return pool.slice(0, count);
  }

  function getStats(questions, state) {
    const items = questions.map((question) => getItem(state, question.id));
    const attempts = items.reduce((sum, item) => sum + item.attempts, 0);
    const correct = items.reduce((sum, item) => sum + item.correct, 0);
    const answered = items.filter((item) => item.attempts > 0).length;
    return {
      total: questions.length,
      answered,
      newCount: questions.length - answered,
      wrongCount: items.filter((item) => item.wrong > 0).length,
      activeWrong: items.filter((item) => item.wrong > 0 && item.streak < 2).length,
      mastered: items.filter((item) => item.attempts > 0 && item.streak >= 2).length,
      starred: items.filter((item) => item.bookmarked).length,
      attempts,
      correct,
      accuracy: attempts ? Math.round((correct / attempts) * 100) : 0,
    };
  }

  function makeBackup(state) {
    return JSON.stringify({ format: 'ai-trainer-study-backup', version: VERSION, exportedAt: new Date().toISOString(), items: state.items }, null, 2);
  }

  function parseBackup(raw, questions) {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data || data.version !== VERSION || !data.items || typeof data.items !== 'object' || Array.isArray(data.items)) {
      throw new Error('备份文件格式或版本不正确');
    }
    const known = new Set(questions.map((question) => question.id));
    const items = {};
    for (const [id, item] of Object.entries(data.items)) {
      if (!known.has(id) || !item || typeof item !== 'object') throw new Error(`备份中的题目编号无效：${id}`);
      const { attempts, correct, wrong, streak, lastAt, lastWasCorrect, bookmarked, markAt } = item;
      if (![attempts, correct, wrong, streak].every((value) => Number.isInteger(value) && value >= 0) ||
          attempts !== correct + wrong || streak > correct ||
          (lastAt !== null && typeof lastAt !== 'string') ||
          (lastWasCorrect !== null && typeof lastWasCorrect !== 'boolean') ||
          (markAt !== undefined && markAt !== null && typeof markAt !== 'string') ||
          typeof bookmarked !== 'boolean') {
        throw new Error(`备份中的答题记录无效：${id}`);
      }
      items[id] = { attempts, correct, wrong, streak, lastAt, lastWasCorrect, bookmarked, markAt: markAt || null };
    }
    return { version: VERSION, items };
  }

  return { createState, getItem, isCorrect, recordAnswer, toggleBookmark, mergeItem, mergeItems, mergeStates, getPool, selectSession, getStats, makeBackup, parseBackup };
});
