(() => {
  'use strict';

  const core = globalThis.StudyCore;
  const sync = globalThis.StudySync;
  const questions = globalThis.QUESTION_BANK;
  const byId = new Map(questions.map((question) => [question.id, question]));
  const storageKey = 'ai-trainer-theory-progress-v1';
  const typeNames = { judgment: '判断题', single: '单选题', multiple: '多选题' };
  const modeNames = { new: '新题练习', wrong: '错题复习', all: '顺序练习', custom: '单题练习', exam: '随机测验' };
  const AUTO_NEXT_DELAY = 700;
  const SYNC_PUSH_DELAY = 6000;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  let state = loadState();
  let session = null;
  let selection = new Set();
  let submitted = false;
  let advanceTimer = null;
  let bankPage = 0;
  let toastTimer = null;
  let syncConfig = sync.readConfig();
  let syncTimer = null;
  let syncBusy = false;
  let syncStatusOverride = '';

  function loadState() {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? core.parseBackup(raw, questions) : core.createState();
    } catch {
      return core.createState();
    }
  }

  function saveState() {
    try {
      localStorage.setItem(storageKey, core.makeBackup(state));
    } catch {
      showToast('无法自动保存，请检查浏览器设置并导出备份。');
    }
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
  }

  function showView(name) {
    $$('.view').forEach((view) => { view.hidden = view.id !== name + 'View'; });
    $$('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.nav === name));
    if (name === 'dashboard') renderDashboard();
    if (name === 'bank') renderBank();
    if (name === 'sync') renderSyncView();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderDashboard() {
    const stats = core.getStats(questions, state);
    $('[data-stat="total"]').textContent = stats.total;
    $('[data-stat="new"]').textContent = stats.newCount;
    $('[data-stat="wrong"]').textContent = stats.wrongCount;
    $('[data-stat="activeWrong"]').textContent = stats.activeWrong;
    $('[data-stat="accuracy"]').textContent = stats.accuracy + '%';
    const percentage = Math.round((stats.answered / stats.total) * 100);
    $('#progressPercent').textContent = percentage + '%';
    $('#progressFraction').textContent = stats.answered + ' / ' + stats.total + ' 已练习';
    $('#progressRing').style.setProperty('--progress', percentage + '%');
    $('#progressHeadline').textContent = stats.answered === 0 ? '从第一题开始' : stats.newCount === 0 ? '第一轮已完成' : '已经练过 ' + stats.answered + ' 题';
    $('#progressText').textContent = stats.answered === 0 ? '先做一轮新题，错题会自动进入复习列表。' : stats.activeWrong > 0 ? '还有 ' + stats.activeWrong + ' 道错题待巩固，连续答对两次就算记牢。' : '继续攻克新题，保持学习节奏。';
    $('#startNew').disabled = stats.newCount === 0;
    $('#startWrong').disabled = stats.wrongCount === 0;
    const typeBox = $('#typeProgress');
    typeBox.replaceChildren();
    for (const type of ['judgment', 'single', 'multiple']) {
      const subset = questions.filter((question) => question.type === type);
      const done = subset.filter((question) => core.getItem(state, question.id).attempts > 0).length;
      const card = document.createElement('div');
      card.className = 'type-card';
      const head = document.createElement('div');
      head.className = 'type-card-head';
      const title = document.createElement('span');
      title.textContent = typeNames[type];
      const count = document.createElement('span');
      count.textContent = done + ' / 300';
      head.append(title, count);
      const track = document.createElement('div');
      track.className = 'type-track';
      const fill = document.createElement('div');
      fill.style.width = Math.round((done / 300) * 100) + '%';
      track.append(fill);
      card.append(head, track);
      typeBox.append(card);
    }
  }

  function startSession(options) {
    const selected = options.ids ? options.ids.map((id) => byId.get(id)).filter(Boolean) : core.selectSession(questions, state, options);
    if (!selected.length) {
      showToast(options.mode === 'wrong' ? '还没有错题，先做一轮新题吧。' : '这个分类暂时没有题目。');
      return;
    }
    session = { questions: selected, index: 0, answers: [], exam: Boolean(options.exam), mode: options.mode || 'custom' };
    renderQuestion();
    showView('practice');
  }

  function currentQuestion() {
    return session.questions[session.index];
  }

  function choicesFor(question) {
    if (question.type === 'judgment') return [{ key: '√', text: '正确' }, { key: '×', text: '错误' }];
    return question.options;
  }

  // 判断题和单选题点一下就直接判定；多选题和随机测验保留提交按钮。
  function needsSubmit(question) {
    return session.exam || question.type === 'multiple';
  }

  function answeredCount() {
    return session.answers.filter(Boolean).length;
  }

  function correctCount() {
    return session.answers.filter((row) => row && row.correct).length;
  }

  function clearAdvance() {
    if (advanceTimer !== null) {
      clearTimeout(advanceTimer);
      advanceTimer = null;
    }
  }

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function hintFor(question) {
    if (session.exam) return '随机测验 · 选择后点「提交答案」，交卷后统一揭晓对错';
    if (question.type === 'multiple') return '多选题 · 选好全部正确选项后点「提交答案」，答对自动进入下一题';
    if (question.type === 'single') return '单选题 · 点选答案后立刻判定，答对自动进入下一题';
    return '判断题 · 点选答案后立刻判定，答对自动进入下一题';
  }

  function renderQuestion() {
    clearAdvance();
    const question = currentQuestion();
    const record = session.answers[session.index] || null;
    submitted = Boolean(record);
    selection = new Set(record ? String(record.selected).split('') : []);

    $('#practiceModeLabel').textContent = session.exam ? modeNames.exam : modeNames[session.mode] || '专项练习';
    $('#questionCounter').textContent = '第 ' + (session.index + 1) + ' / ' + session.questions.length + ' 题';
    $('#questionType').textContent = typeNames[question.type];
    $('#sourceNumber').textContent = '原题第 ' + question.number + ' 题';
    $('#practiceTitle').textContent = question.stem;
    $('#choiceHint').textContent = hintFor(question);

    const starred = core.getItem(state, question.id).bookmarked;
    $('#bookmarkQuestion').classList.toggle('active', starred);
    $('#bookmarkQuestion').textContent = starred ? '★' : '☆';
    $('#bookmarkQuestion').setAttribute('aria-pressed', String(starred));

    const container = $('#choices');
    container.replaceChildren();
    for (const option of choicesFor(question)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'choice';
      button.dataset.key = option.key;
      button.setAttribute('aria-label', question.type === 'judgment' ? option.text : option.key + ' ' + option.text);
      const key = document.createElement('span');
      key.className = 'choice-key';
      key.textContent = option.key;
      const text = document.createElement('span');
      text.className = 'choice-text';
      text.textContent = option.text;
      button.append(key, text);
      button.addEventListener('click', () => choose(option.key));
      container.append(button);
    }
    paintChoices();
    paintActions();
    renderFeedbackArea(record);
    paintProgress();
  }

  function paintChoices() {
    const question = currentQuestion();
    const revealed = submitted && !session.exam;
    $$('.choice').forEach((button) => {
      const key = button.dataset.key;
      const active = selection.has(key);
      const isAnswer = question.answer.includes(key);
      button.classList.toggle('selected', active && !revealed);
      button.classList.toggle('correct-choice', revealed && isAnswer);
      button.classList.toggle('wrong-choice', revealed && active && !isAnswer);
      button.setAttribute('aria-pressed', String(active));
      button.disabled = submitted;
    });
  }

  function paintActions() {
    const last = session.index === session.questions.length - 1;
    $('#prevQuestion').hidden = session.index === 0;
    $('#submitAnswer').hidden = submitted || !needsSubmit(currentQuestion());
    $('#submitAnswer').disabled = selection.size === 0;
    $('#nextQuestion').hidden = !submitted;
    $('#nextQuestion').textContent = last ? '查看本轮结果 →' : '下一题 →';
    $('#prevQuestion').textContent = '← 上一题';
    $('#practiceActions').classList.toggle('answered', submitted);
  }

  function paintProgress() {
    $('#meterFill').style.width = Math.round((answeredCount() / session.questions.length) * 100) + '%';
    $('#practiceScore').textContent = session.exam
      ? '答案交卷后揭晓'
      : '已答 ' + answeredCount() + ' / ' + session.questions.length + ' 题 · 答对 ' + correctCount() + ' 题';
  }

  function answerText(question) {
    if (question.type === 'judgment') return question.answer === '√' ? '正确（√）' : '错误（×）';
    return question.answer.split('').join('、');
  }

  function renderFeedbackArea(record) {
    const box = $('#feedback');
    box.replaceChildren();
    box.className = 'feedback';
    box.onclick = null;
    if (!record || session.exam) {
      box.hidden = true;
      return;
    }
    const question = currentQuestion();
    box.hidden = false;
    box.className = 'feedback' + (record.correct ? '' : ' incorrect');
    const title = document.createElement('strong');
    title.textContent = record.correct ? '答对了' : '答错了';
    box.append(title);
    if (!record.correct) {
      const answer = document.createElement('p');
      answer.className = 'answer-line';
      answer.textContent = '正确答案：' + answerText(question);
      box.append(answer);
    }
    const explanation = document.createElement('p');
    explanation.textContent = question.explanation === '略' ? '原题库未提供详细解析。' : question.explanation;
    box.append(explanation);
    const hint = document.createElement('span');
    hint.className = 'tap-hint';
    hint.textContent = session.index === session.questions.length - 1 ? '轻点这里查看本轮结果 →' : '轻点这里进入下一题 →';
    box.append(hint);
    // 答错时看完答案，点一下就继续。
    box.onclick = () => goNext();
  }

  function choose(key) {
    if (!session || submitted) return;
    const question = currentQuestion();
    if (question.type === 'multiple') {
      if (selection.has(key)) selection.delete(key);
      else selection.add(key);
      paintChoices();
      $('#submitAnswer').disabled = selection.size === 0;
      return;
    }
    selection = new Set([key]);
    paintChoices();
    if (!needsSubmit(question)) commitAnswer();
  }

  function commitAnswer() {
    if (!session || submitted || selection.size === 0) return;
    const question = currentQuestion();
    const selected = [...selection].sort().join('');
    const correct = core.isCorrect(question, selected);
    state = core.recordAnswer(state, question.id, correct);
    saveState();
    session.answers[session.index] = { selected, correct };
    submitted = true;
    paintChoices();
    paintActions();
    renderFeedbackArea(session.answers[session.index]);
    paintProgress();
    scheduleSync();
    if (correct && !session.exam) {
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        goNext();
      }, AUTO_NEXT_DELAY);
    }
  }

  function goNext() {
    clearAdvance();
    if (!session || !submitted) return;
    if (session.index + 1 < session.questions.length) {
      session.index += 1;
      renderQuestion();
      scrollToTop();
    } else {
      renderResult();
      showView('result');
    }
  }

  function goPrev() {
    clearAdvance();
    if (!session || session.index === 0) return;
    session.index -= 1;
    renderQuestion();
    scrollToTop();
  }

  function renderResult() {
    const answered = session.answers.filter(Boolean);
    const total = answered.length;
    const correct = answered.filter((row) => row.correct).length;
    const wrong = answered.filter((row) => !row.correct);
    $('#resultTitle').textContent = session.exam ? '模拟测验完成' : '这一轮练完了';
    $('#resultSubtitle').textContent = wrong.length ? '有 ' + wrong.length + ' 题需要再看一遍，错题已记入错题本。' : '全部答对，保持这个节奏。';
    $('#resultRate').textContent = total ? Math.round((correct / total) * 100) + '%' : '0%';
    $('#resultCount').textContent = correct + ' / ' + total + ' 题答对';
    $('#resultWrong').hidden = wrong.length === 0;
    $('#resultWrong').onclick = () => startSession({ ids: wrong.map((row) => row.id), mode: 'wrong' });
    const list = $('#resultList');
    list.replaceChildren();
    if (wrong.length) {
      const title = document.createElement('h2');
      title.textContent = '本轮错题';
      list.append(title);
      for (const row of wrong) {
        const question = byId.get(row.id);
        const item = document.createElement('div');
        item.className = 'result-row';
        const number = document.createElement('strong');
        number.textContent = typeNames[question.type] + ' ' + question.number;
        const stem = document.createElement('span');
        stem.textContent = question.stem;
        const answer = document.createElement('p');
        answer.textContent = '正确答案：' + answerText(question) + ' · ' + (question.explanation === '略' ? '原题库未提供详细解析。' : question.explanation);
        item.append(number, stem, answer);
        list.append(item);
      }
    }
  }

  function renderBank() {
    const query = $('#bankSearch').value.trim().toLocaleLowerCase();
    const type = $('#bankType').value;
    const status = $('#bankStatus').value;
    const pool = core.getPool(questions, state, status, type).filter((question) => {
      if (!query) return true;
      return (question.stem + ' ' + question.options.map((option) => option.text).join(' ')).toLocaleLowerCase().includes(query);
    });
    $('#bankResultCount').textContent = '找到 ' + pool.length + ' 题';
    const pageSize = 30;
    const totalPages = Math.max(1, Math.ceil(pool.length / pageSize));
    bankPage = Math.min(bankPage, totalPages - 1);
    const list = $('#bankList');
    list.replaceChildren();
    if (!pool.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '<strong>没有找到题目</strong><span>试试其他关键词或筛选条件。</span>';
      list.append(empty);
    }
    for (const question of pool.slice(bankPage * pageSize, (bankPage + 1) * pageSize)) {
      const progress = core.getItem(state, question.id);
      const card = document.createElement('article');
      card.className = 'bank-item';
      const top = document.createElement('div');
      top.className = 'bank-item-top';
      const typeLabel = document.createElement('strong');
      typeLabel.textContent = typeNames[question.type] + ' · 第 ' + question.number + ' 题';
      const statusLabel = document.createElement('span');
      statusLabel.className = 'status-chip ' + (progress.wrong > 0 ? 'wrong' : progress.attempts > 0 ? 'done' : '');
      statusLabel.textContent = progress.wrong > 0 ? '做错过' : progress.attempts > 0 ? '已做' : '新题';
      top.append(typeLabel, statusLabel);
      if (progress.bookmarked) {
        const star = document.createElement('span');
        star.textContent = '★ 已收藏';
        top.append(star);
      }
      const text = document.createElement('p');
      text.textContent = question.stem;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '练习这题 →';
      button.addEventListener('click', () => startSession({ ids: [question.id], mode: 'custom' }));
      card.append(top, text, button);
      list.append(card);
    }
    const pagination = $('#bankPagination');
    pagination.replaceChildren();
    if (totalPages > 1) {
      const previous = document.createElement('button');
      previous.textContent = '上一页';
      previous.disabled = bankPage === 0;
      previous.onclick = () => { bankPage -= 1; renderBank(); window.scrollTo({ top: 0 }); };
      const position = document.createElement('span');
      position.textContent = (bankPage + 1) + ' / ' + totalPages;
      const next = document.createElement('button');
      next.textContent = '下一页';
      next.disabled = bankPage === totalPages - 1;
      next.onclick = () => { bankPage += 1; renderBank(); window.scrollTo({ top: 0 }); };
      pagination.append(previous, position, next);
    }
  }

  function formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
  }

  function setSyncStatus(text) {
    syncStatusOverride = text;
    renderSyncStatus();
  }

  function renderSyncStatus() {
    const node = $('#syncStatus');
    node.classList.remove('ok', 'warn');
    if (syncStatusOverride) {
      node.textContent = syncStatusOverride;
      return;
    }
    if (!syncConfig.code) {
      node.textContent = '还没设置同步码';
      node.classList.add('warn');
      return;
    }
    if (!sync.endpointFor(syncConfig)) {
      node.textContent = '还没设置同步服务地址';
      node.classList.add('warn');
      return;
    }
    node.textContent = syncConfig.lastSyncAt ? '上次同步：' + formatTime(syncConfig.lastSyncAt) : '已配置，等待首次同步';
    node.classList.add('ok');
  }

  function renderSyncView() {
    syncConfig = sync.readConfig();
    $('#syncCode').value = syncConfig.code;
    const endpointBox = $('#syncEndpoint');
    if (!endpointBox.value.trim()) endpointBox.value = sync.endpointFor(syncConfig);
    $('#syncAppUrl').textContent = location.protocol === 'file:' ? '当前是以文件方式打开，同步需要先部署到网上' : location.href.split('?')[0];
    renderSyncStatus();
  }

  async function runSync(options) {
    const opts = options || {};
    if (!sync.isReady(syncConfig)) {
      if (opts.notify) showToast('请先填写同步码和同步服务地址。');
      return null;
    }
    if (syncBusy) return null;
    syncBusy = true;
    setSyncStatus('正在同步…');
    const endpoint = sync.endpointFor(syncConfig);
    try {
      const result = await sync.push(endpoint, syncConfig.code, state.items);
      state = core.mergeStates(state, { items: result.items });
      saveState();
      syncConfig = sync.saveConfig({ ...syncConfig, code: syncConfig.code, endpoint, lastSyncAt: new Date().toISOString() });
      renderDashboard();
      syncStatusOverride = '';
      renderSyncStatus();
      if (opts.notify) showToast('已和云端同步完成。');
      return result;
    } catch (error) {
      setSyncStatus('同步失败：' + error.message);
      if (opts.notify) showToast('同步失败：' + error.message);
      return null;
    } finally {
      syncBusy = false;
    }
  }

  function scheduleSync() {
    if (!sync.isReady(syncConfig)) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncTimer = null; runSync(); }, SYNC_PUSH_DELAY);
  }

  function flushSync() {
    if (syncTimer === null) return;
    clearTimeout(syncTimer);
    syncTimer = null;
    runSync();
  }

  function saveSyncSettings() {
    const code = sync.normalizeCode($('#syncCode').value);
    if (!sync.isValidCode(code)) {
      showToast('同步码请使用 4-32 位字母或数字。');
      return;
    }
    const endpoint = sync.normalizeEndpoint($('#syncEndpoint').value) || sync.defaultEndpoint();
    if (!endpoint) {
      showToast('请先填写同步服务地址。');
      return;
    }
    syncConfig = sync.saveConfig({ code, endpoint, lastSyncAt: syncConfig.lastSyncAt });
    $('#syncCode').value = code;
    $('#syncEndpoint').value = endpoint;
    renderSyncStatus();
    runSync({ notify: true });
  }

  function exportBackup() {
    const blob = new Blob([core.makeBackup(state)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '训练师刷题进度-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('备份文件已导出。');
  }

  async function importBackup(file) {
    try {
      const candidate = core.parseBackup(await file.text(), questions);
      const restored = core.getStats(questions, candidate);
      if (!window.confirm('这份备份包含 ' + restored.answered + ' 道已做题。恢复后会替换当前浏览器的答题记录，继续吗？')) return;
      state = candidate;
      saveState();
      renderDashboard();
      scheduleSync();
      showToast('已恢复 ' + restored.answered + ' 道题的学习记录。');
    } catch (error) {
      showToast('导入失败：' + error.message);
    } finally {
      $('#importBackup').value = '';
    }
  }

  $$('#dashboardView [data-nav], .side-nav [data-nav]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.nav)));
  $('#startNew').addEventListener('click', () => startSession({ mode: 'new', count: 20 }));
  $('#startWrong').addEventListener('click', () => startSession({ mode: 'wrong', count: 20 }));
  $('#startExam').addEventListener('click', () => startSession({ mode: 'exam', count: 30, shuffle: true, exam: true }));
  $('#quitPractice').addEventListener('click', () => { clearAdvance(); session = null; showView('dashboard'); });
  $('#submitAnswer').addEventListener('click', commitAnswer);
  $('#nextQuestion').addEventListener('click', goNext);
  $('#prevQuestion').addEventListener('click', goPrev);
  $('#bookmarkQuestion').addEventListener('click', () => {
    if (!session) return;
    state = core.toggleBookmark(state, currentQuestion().id);
    saveState();
    const starred = core.getItem(state, currentQuestion().id).bookmarked;
    $('#bookmarkQuestion').classList.toggle('active', starred);
    $('#bookmarkQuestion').textContent = starred ? '★' : '☆';
    $('#bookmarkQuestion').setAttribute('aria-pressed', String(starred));
    showToast(starred ? '已收藏这道题。' : '已取消收藏。');
    scheduleSync();
  });
  $('#resultHome').addEventListener('click', () => { session = null; showView('dashboard'); });
  for (const selector of ['#bankSearch', '#bankType', '#bankStatus']) {
    $(selector).addEventListener(selector === '#bankSearch' ? 'input' : 'change', () => { bankPage = 0; renderBank(); });
  }
  $('#exportBackup').addEventListener('click', exportBackup);
  $('#importBackup').addEventListener('change', (event) => { if (event.target.files[0]) importBackup(event.target.files[0]); });
  $('#syncSave').addEventListener('click', saveSyncSettings);
  $('#syncNow').addEventListener('click', () => { syncConfig = sync.readConfig(); runSync({ notify: true }); });
  $('#syncGenerate').addEventListener('click', () => { $('#syncCode').value = sync.makeCode(); });
  $('#syncCode').addEventListener('input', (event) => { event.target.value = sync.normalizeCode(event.target.value); });

  document.addEventListener('keydown', (event) => {
    if ($('#practiceView').hidden || !session || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    if (/^[1-5]$/.test(event.key) && !submitted) {
      const option = choicesFor(currentQuestion())[Number(event.key) - 1];
      if (option) choose(option.key);
    } else if (event.key === 'Enter') {
      if (submitted) goNext();
      else if (needsSubmit(currentQuestion()) && selection.size) commitAnswer();
    } else if (event.key === 'ArrowLeft') {
      goPrev();
    } else if (event.key === 'ArrowRight' && submitted) {
      goNext();
    }
  });

  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSync(); });
  window.addEventListener('pagehide', flushSync);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  $('#todayLabel').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  renderDashboard();
  if (sync.isReady(syncConfig)) runSync();
})();
