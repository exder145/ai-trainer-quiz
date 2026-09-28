const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = path.join(__dirname, '..');

function openApp() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error));
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
    url: 'https://quiz.example/',
    runScripts: 'outside-only',
    virtualConsole,
  });
  dom.window.scrollTo = () => {};
  for (const file of ['questions.js', 'core.js', 'sync.js', 'app.js']) {
    dom.window.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  }
  return { window: dom.window, document: dom.window.document, errors };
}

function currentQuestion(app) {
  const stem = app.document.querySelector('#practiceTitle').textContent;
  return app.window.QUESTION_BANK.find((question) => question.stem === stem);
}

function answerWrong(app) {
  const question = currentQuestion(app);
  assert.ok(question, '当前题目应在题库中');
  const exam = app.document.querySelector('#practiceModeLabel').textContent === '随机测验';
  const before = app.document.querySelector('#questionCounter').textContent;
  const wrongKey = question.type === 'judgment'
    ? (question.answer === '√' ? '×' : '√')
    : question.options.find((option) => option.key !== question.answer)?.key || question.options[0].key;
  const choice = [...app.document.querySelectorAll('#choices .choice')]
    .find((button) => button.dataset.key === wrongKey);
  choice.click();
  if (question.type === 'multiple' || app.document.querySelector('#submitAnswer').hidden === false) {
    const submit = app.document.querySelector('#submitAnswer');
    assert.equal(submit.disabled, false, `${question.type} 选中后应能用鼠标提交`);
    if (exam) assert.equal(submit.textContent, '确定');
    submit.click();
  }
  if (exam) {
    const advanced = app.document.querySelector('#questionCounter').textContent !== before;
    const finished = !app.document.querySelector('#resultView').hidden;
    assert.ok(advanced || finished, '随机测验点一次确定就应进入下一题或结果页');
    return { question, wrongKey };
  }
  const next = app.document.querySelector('#nextQuestion');
  assert.equal(next.hidden, false, '提交后应能进入下一题');
  next.click();
  return { question, wrongKey };
}

test('20 道新题结束后显示全部错题并可再次复盘', (t) => {
  const app = openApp();
  t.after(() => app.window.close());
  app.document.querySelector('#startNew').click();
  const answered = Array.from({ length: 20 }, () => answerWrong(app));
  assert.equal(app.document.querySelector('#resultView').hidden, false);
  assert.equal(app.document.querySelector('#resultCount').textContent, '0 / 20 题答对');
  const rows = [...app.document.querySelectorAll('#resultList .result-row')];
  assert.equal(rows.length, 20);
  assert.ok(rows[0].textContent.includes(answered[0].question.stem));
  assert.ok(rows[0].textContent.includes('你的答案：'));
  assert.ok(rows[0].textContent.includes('正确答案：'));
  app.document.querySelector('#resultWrong').click();
  assert.equal(app.document.querySelector('#practiceView').hidden, false);
  assert.equal(app.document.querySelector('#questionCounter').textContent, '第 1 / 20 题');
  const saved = JSON.parse(app.window.localStorage.getItem('ai-trainer-theory-progress-v1'));
  assert.equal(Object.keys(saved.items).length, 20);
  assert.deepEqual(app.errors, []);
});

test('随机 30 题均可鼠标提交并显示全部错题', (t) => {
  const app = openApp();
  t.after(() => app.window.close());
  app.document.querySelector('#startExam').click();
  const types = new Set();
  const answered = [];
  for (let i = 0; i < 30; i += 1) {
    types.add(currentQuestion(app).type);
    answered.push(answerWrong(app));
  }
  assert.ok(types.has('single'), '抽样需覆盖单选题');
  assert.ok(types.has('multiple'), '抽样需覆盖多选题');
  assert.equal(app.document.querySelector('#resultView').hidden, false);
  assert.equal(app.document.querySelector('#resultCount').textContent, '0 / 30 题答对');
  const rows = [...app.document.querySelectorAll('#resultList .result-row')];
  assert.equal(rows.length, 30);
  assert.ok(rows[29].textContent.includes(answered[29].question.stem));
  const saved = JSON.parse(app.window.localStorage.getItem('ai-trainer-theory-progress-v1'));
  assert.equal(Object.keys(saved.items).length, 30);
  assert.deepEqual(app.errors, []);
});

test('20 道全部答对也能进入结果页，且不误列错题', (t) => {
  const app = openApp();
  t.after(() => app.window.close());
  app.document.querySelector('#startNew').click();
  for (let i = 0; i < 20; i += 1) {
    const question = currentQuestion(app);
    for (const key of question.answer) {
      const choice = [...app.document.querySelectorAll('#choices .choice')]
        .find((button) => button.dataset.key === key);
      choice.click();
    }
    if (question.type === 'multiple') app.document.querySelector('#submitAnswer').click();
    app.document.querySelector('#nextQuestion').click();
  }
  assert.equal(app.document.querySelector('#resultView').hidden, false);
  assert.equal(app.document.querySelector('#resultCount').textContent, '20 / 20 题答对');
  assert.equal(app.document.querySelectorAll('#resultList .result-row').length, 0);
  assert.deepEqual(app.errors, []);
});
