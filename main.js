'use strict';

// localStorage はほかのアプリと共有される（同じ t-of.github.io のため）。
// キーは必ず 'talk-english.' で始める。
const STORE = 'talk-english.';

function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ }
}

WebAppKit.init({ title: 'talk-english', text: '中学英文法、NGSL頻出1000語、日常会話のフレーズと熟語を学べる英語学習サイト' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// 音を使うときは、鳴らす前と音の設定を切り替えたときにこれを呼ぶ（RULES.md §5「音」）。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}

// ---- ここからアプリ本体 ----

// 記録: 読んだ文法・確認問題の最高点・覚えた語句・苦手な語句
// 語句のキーは 'w:単語' 'p:フレーズ' 'i:熟語' 'v:句動詞'
const st = Object.assign({ gRead: {}, gScore: {}, known: {}, weak: {} }, load('state', {}));
const keep = () => save('state', st);

const $view = document.getElementById('view');
const $title = document.getElementById('title');
const $back = document.getElementById('back');

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---- 読み上げ（端末の英語の声を使う） ----
let voice = null;
function pickVoice() {
  const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  voice = vs.find((v) => v.lang === 'en-US' && /Samantha|Google US|Aria|Jenny/.test(v.name))
    || vs.find((v) => v.lang === 'en-US') || vs.find((v) => v.lang.startsWith('en')) || null;
}
if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function speak(text) {
  if (!window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/〜/g, ''));
  u.lang = 'en-US'; u.rate = 0.9;
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-say]');
  if (b) { e.stopPropagation(); speak(b.dataset.say); }
});
const sayBtn = (t) => `<button class="say" data-say="${esc(t)}" aria-label="読み上げ">▶</button>`;

// ---- データの整理 ----
// 文法は学年順ではなく「会話で早く使える順」に並べ直す
const G_STEPS = [
  { label: 'ステップ1 文の骨組み', ids: ['g-order', 'g-present', 'g-do', 'g-imp', 'g-there', 'g-article', 'g-plural'] },
  { label: 'ステップ2 いま・過去・これから', ids: ['g-prog', 'g-past', 'g-future', 'g-pastprog', 'g-modal'] },
  { label: 'ステップ3 人や物について話す', ids: ['g-pron', 'g-it', 'g-quant', 'g-adj', 'g-tag', 'g-perfect'] },
  { label: 'ステップ4 したいこと・思うこと', ids: ['g-inf', 'g-ing', 'g-that', 'g-wh', 'g-and', 'g-when'] },
  { label: 'ステップ5 比べる', ids: ['g-comp', 'g-super', 'g-as', 'g-compadv'] },
  { label: 'ステップ6 くわしく説明する', ids: ['g-rel', 'g-reladv', 'g-part', 'g-passive', 'g-svoo', 'g-svoc', 'g-causative', 'g-percept'] },
  { label: 'ステップ7 仮定・ていねい・振り返り', ids: ['g-if', 'g-modalperf', 'g-pastperf', 'g-partcon'] },
];
const G = Object.fromEntries(GRAMMAR.map((g) => [g.id, g]));
G_STEPS.forEach((s) => { s.ids = s.ids.filter((id) => G[id]); });
const placed = new Set(G_STEPS.flatMap((s) => s.ids));
const rest = GRAMMAR.filter((g) => !placed.has(g.id)).map((g) => g.id);
if (rest.length) G_STEPS.push({ label: 'その他', ids: rest });
const G_ORDER = G_STEPS.flatMap((s) => s.ids);

// 単語は NGSL の順位で 50 語ずつ。元データでは the が 1000 位にあるので順位で並べ直す
const WORDS = VOCAB.slice().sort((a, b) => a[2] - b[2])
  .map(([en, ja, rank, ex, exJa, ipa]) => ({ key: 'w:' + en, en, ja, rank, ex, exJa, ipa }));
const CHUNK = 50;
const CHUNKS = Math.ceil(WORDS.length / CHUNK);
const chunkWords = (c) => WORDS.slice(c * CHUNK, c * CHUNK + CHUNK);

const phraseItem = (p, kind) => ({ key: kind + ':' + p.en, en: p.en, ja: p.ja, note: p.note || '', ex: p.ex, exJa: p.exJa });
const SCENE_ITEMS = Object.fromEntries((typeof SCENES === 'undefined' ? [] : SCENES).map((s) => [s.id, s.phrases.map((p) => phraseItem(p, 'p'))]));
const IDIOM_ITEMS = (typeof IDIOMS === 'undefined' ? [] : IDIOMS).map((p) => phraseItem(p, 'i'));
const PV = {};
PHRASALS.forEach((p) => { (PV[p.v] = PV[p.v] || []).push({ key: `v:${p.v} ${p.p}`, en: `${p.v} ${p.p}`, ja: p.ja, ex: p.en, note: p.note || '' }); });
const ALL_ITEMS = Object.fromEntries([...WORDS, ...Object.values(SCENE_ITEMS).flat(), ...IDIOM_ITEMS, ...Object.values(PV).flat()].map((i) => [i.key, i]));

const countKnown = (items) => items.filter((i) => st.known[i.key]).length;
const meter = (n, all) => `<div class="bar-meter"><i style="width:${all ? n / all * 100 : 0}%"></i></div>`;

// ---- 画面の切り替え（#/〜） ----
function setHead(title, back) {
  $title.textContent = title;
  $back.hidden = !back;
  $back.onclick = () => { location.hash = back; };
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#/' + (location.hash.split('/')[1] || '')));
}
function route() {
  if (window.speechSynthesis) speechSynthesis.cancel();
  const [, a = '', b, c] = location.hash.split('/').map(decodeURIComponent);
  window.scrollTo(0, 0);
  if (a === 'grammar' && b && c === 'quiz') return grammarQuiz(b);
  if (a === 'grammar' && b) return grammarPage(b);
  if (a === 'grammar') return grammarList();
  if (a === 'words' && b && c) return c === 'test' ? wordTest(+b) : cards(chunkWords(+b), `単語 ${+b * CHUNK + 1}〜`, '#/words/' + b, false);
  if (a === 'words' && b) return wordChunk(+b);
  if (a === 'words') return wordList();
  if (a === 'phrases' && b && c === 'cards') return cards(phraseGroup(b).items, phraseGroup(b).title, '#/phrases/' + b, true);
  if (a === 'phrases' && b) return phrasePage(b);
  if (a === 'phrases') return phraseList();
  if (a === 'review' && b === 'cards') return cards(shuffle(Object.keys(st.weak).map((k) => ALL_ITEMS[k]).filter(Boolean)), '苦手の復習', '#/review', null);
  if (a === 'review') return review();
  return home();
}
addEventListener('hashchange', route);

// ---- ホーム ----
function home() {
  setHead('talk-english');
  const gDone = G_ORDER.filter((id) => st.gRead[id]).length;
  const wKnown = countKnown(WORDS);
  const pAll = [...Object.values(SCENE_ITEMS).flat(), ...IDIOM_ITEMS, ...Object.values(PV).flat()];
  const pKnown = countKnown(pAll);
  const nextG = G_ORDER.find((id) => !st.gRead[id]);
  const nextW = [...Array(CHUNKS).keys()].find((c) => countKnown(chunkWords(c)) < CHUNK);
  const weak = Object.keys(st.weak).length;
  $view.innerHTML = `
    <p class="muted">中学英文法・よく使う英単語1000・日常会話のフレーズを、会話で使える順に。英文は ▶ で読み上げ。</p>
    <div class="card stats">
      <div class="stat"><b>${gDone}<small>/${G_ORDER.length}</small></b><span>文法</span></div>
      <div class="stat"><b>${wKnown}<small>/${WORDS.length}</small></b><span>覚えた単語</span></div>
      <div class="stat"><b>${pKnown}<small>/${pAll.length}</small></b><span>言えるフレーズ</span></div>
    </div>
    <h2>つづきから</h2>
    <div class="list">
      ${nextG ? `<a class="row" href="#/grammar/${nextG}"><div class="glyph">${esc(G[nextG].glyph || G[nextG].headword)}</div>
        <div class="row__main"><div class="row__title">文法: ${esc(G[nextG].title)}</div><div class="row__sub">${esc(G[nextG].core)}</div></div></a>` : ''}
      ${nextW !== undefined ? `<a class="row" href="#/words/${nextW}"><div class="glyph">A</div>
        <div class="row__main"><div class="row__title">単語 ${nextW * CHUNK + 1}〜${nextW * CHUNK + CHUNK}</div><div class="row__sub">よく出る順に50語ずつ</div></div></a>` : ''}
      ${SCENES?.length ? `<a class="row" href="#/phrases/${SCENES[0].id}"><div class="glyph">💬</div>
        <div class="row__main"><div class="row__title">場面のフレーズ</div><div class="row__sub">日本語を見て英語で言う練習</div></div></a>` : ''}
      ${weak ? `<a class="row" href="#/review/cards"><div class="glyph">↻</div>
        <div class="row__main"><div class="row__title">苦手を復習</div><div class="row__sub">${weak} 個</div></div></a>` : ''}
    </div>
    <h2>使い方</h2>
    <div class="card muted">
      文法は「なぜそうなるか」のコアから読んで、確認問題で仕上げ。単語とフレーズはカードで「覚えた / まだ」を付けると、まだのものが復習に回る。
      フレーズのページで「英語をかくす」にすると、日本語を見て声に出す練習になる。
    </div>`;
}

// ---- 文法 ----
function grammarList() {
  setHead('文法');
  $view.innerHTML = `<p class="muted">中学で習う文法を、会話で早く使える順に並べた。形の暗記より「どういう気持ちの形か」から。</p>` +
    G_STEPS.map((s) => `<h2>${esc(s.label)}</h2><div class="list">${s.ids.map((id) => {
      const g = G[id]; const sc = st.gScore[id];
      return `<a class="row ${st.gRead[id] ? 'done' : ''}" href="#/grammar/${id}"><div class="glyph">${esc(g.glyph || g.headword)}</div>
        <div class="row__main"><div class="row__title">${esc(g.title)}</div><div class="row__sub">${esc(g.headword)} ── ${esc(g.core)}</div></div>
        <div class="row__end">${sc ? `${sc[0]}/${sc[1]}` : st.gRead[id] ? '✓' : ''}</div></a>`;
    }).join('')}</div>`).join('');
}

function grammarPage(id) {
  const g = G[id];
  if (!g) { location.hash = '#/grammar'; return; }
  setHead(g.title, '#/grammar');
  st.gRead[id] = 1; keep();
  const qs = GRAMMAR_QUIZ.filter((q) => q.ref === id);
  const i = G_ORDER.indexOf(id); const next = G_ORDER[i + 1];
  $view.innerHTML = `
    <div class="card">
      <div class="muted">${esc(g.headword)}</div>
      <div class="core">${esc(g.core)}</div>
      <div>${esc(g.coreNote)}</div>
    </div>
    ${g.senses.map((s) => `<div class="card sense">
      <h3>${esc(s.label)}</h3>${s.gloss ? `<div class="muted">${esc(s.gloss)}</div>` : ''}
      ${s.examples.map((e) => `<div class="line">${sayBtn(e.en)}<div><div class="en">${esc(e.en)}</div><div class="ja">${esc(e.ja)}</div>${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}</div></div>`).join('')}
    </div>`).join('')}
    ${(g.trivia || []).map((t) => `<details class="card trivia"><summary>💡 ${esc(t.title)}</summary><p>${esc(t.body)}</p></details>`).join('')}
    <div class="btns">
      ${qs.length ? `<a class="btn" href="#/grammar/${id}/quiz">確認問題（${qs.length}問）</a>` : ''}
      ${next ? `<a class="btn sub" href="#/grammar/${next}">次: ${esc(G[next].title)}</a>` : ''}
    </div>`;
}

function grammarQuiz(id) {
  const g = G[id];
  const qs = shuffle(GRAMMAR_QUIZ.filter((q) => q.ref === id));
  setHead(g.title + ' の確認', '#/grammar/' + id);
  let n = 0, ok = 0;
  const show = () => {
    if (n >= qs.length) {
      const best = st.gScore[id];
      if (!best || ok >= best[0]) { st.gScore[id] = [ok, qs.length]; keep(); }
      const i = G_ORDER.indexOf(id); const next = G_ORDER[i + 1];
      $view.innerHTML = `<div class="card flash"><div class="big">${ok} / ${qs.length}</div><div class="muted">${ok === qs.length ? '全問正解！' : '間違えたところは本文をもう一度'}</div></div>
        <div class="btns"><a class="btn sub" href="#/grammar/${id}">本文にもどる</a>${next ? `<a class="btn" href="#/grammar/${next}">次: ${esc(G[next].title)}</a>` : ''}</div>`;
      return;
    }
    const q = qs[n];
    $view.innerHTML = `<div class="progress">${n + 1} / ${qs.length}</div>
      <div class="card"><div class="quiz-q">${esc(q.prompt)}</div><div class="muted">${esc(q.question)}</div></div>
      <div class="choices">${q.choices.map((c, i) => `<button data-i="${i}">${esc(c)}</button>`).join('')}</div>
      <div id="after"></div>`;
    $view.querySelector('.choices').onclick = (e) => {
      const b = e.target.closest('button'); if (!b || $view.querySelector('.choices').dataset.done) return;
      $view.querySelector('.choices').dataset.done = 1;
      const right = +b.dataset.i === q.answer; if (right) ok++;
      $view.querySelectorAll('.choices button').forEach((x) => { if (+x.dataset.i === q.answer) x.classList.add('ok'); });
      if (!right) b.classList.add('ng');
      $view.querySelector('#after').innerHTML = `<div class="card"><b style="color:var(--${right ? 'good' : 'bad'})">${right ? '正解' : '不正解'}</b><div>${esc(q.explain)}</div></div>
        <div class="btns"><button class="btn" id="nx">${n + 1 < qs.length ? '次へ' : '結果を見る'}</button></div>`;
      $view.querySelector('#nx').onclick = () => { n++; show(); window.scrollTo(0, 0); };
    };
  };
  show();
}

// ---- 単語 ----
function wordList() {
  setHead('単語');
  $view.innerHTML = `<p class="muted">NGSL（New General Service List）の頻度順・上位1000語。英語の文章の約8割はこの1000語でできていると言われる。</p>
    <div class="list">${[...Array(CHUNKS).keys()].map((c) => {
      const ws = chunkWords(c); const k = countKnown(ws);
      return `<a class="row ${k === ws.length ? 'done' : ''}" href="#/words/${c}"><div class="glyph">${c + 1}</div>
        <div class="row__main"><div class="row__title">${c * CHUNK + 1}〜${c * CHUNK + ws.length} 位</div>
        <div class="row__sub">${ws.slice(0, 6).map((w) => esc(w.en)).join(', ')} …</div>${meter(k, ws.length)}</div>
        <div class="row__end">${k}/${ws.length}</div></a>`;
    }).join('')}</div>`;
}

function itemLines(items, opts = {}) {
  return items.map((w) => `<div class="line" data-key="${esc(w.key)}">${sayBtn(w.en)}<div>
    <div class="en">${esc(w.en)}${w.ipa ? ` <span class="muted">${esc(w.ipa)}</span>` : ''}</div>
    <div class="ja">${esc(w.ja)}</div>
    ${w.ex ? `<div class="note">${esc(w.ex)} ${sayBtn(w.ex).replace('class="say"', 'class="say" style="display:inline-grid;width:26px;height:26px;font-size:11px;vertical-align:middle"')}${w.exJa ? `<br>${esc(w.exJa)}` : ''}</div>` : ''}
    ${w.note && !opts.noNote ? `<div class="note">${esc(w.note)}</div>` : ''}
    </div><button class="mark ${st.known[w.key] ? 'on' : ''}" data-known="${esc(w.key)}">${st.known[w.key] ? '覚えた' : '未'}</button></div>`).join('');
}
function bindMarks(root) {
  root.addEventListener('click', (e) => {
    const m = e.target.closest('[data-known]'); if (!m) return;
    const k = m.dataset.known;
    if (st.known[k]) delete st.known[k]; else { st.known[k] = 1; delete st.weak[k]; }
    keep();
    m.classList.toggle('on', !!st.known[k]); m.textContent = st.known[k] ? '覚えた' : '未';
  });
}

function wordChunk(c) {
  const ws = chunkWords(c);
  setHead(`単語 ${c * CHUNK + 1}〜${c * CHUNK + ws.length}`, '#/words');
  $view.innerHTML = `<div class="btns"><a class="btn" href="#/words/${c}/cards">カードで覚える</a><a class="btn sub" href="#/words/${c}/test">4択テスト</a></div>
    <div class="card">${itemLines(ws)}</div>
    ${c + 1 < CHUNKS ? `<div class="btns"><a class="btn sub" href="#/words/${c + 1}">次の50語</a></div>` : ''}`;
  bindMarks($view);
}

function wordTest(c) {
  const ws = shuffle(chunkWords(c)).slice(0, 10);
  setHead('4択テスト', '#/words/' + c);
  let n = 0, ok = 0;
  const show = () => {
    if (n >= ws.length) {
      $view.innerHTML = `<div class="card flash"><div class="big">${ok} / ${ws.length}</div><div class="muted">間違えた語は苦手として復習に入れた</div></div>
        <div class="btns"><a class="btn sub" href="#/words/${c}">一覧へ</a><button class="btn" id="again">もう一度</button></div>`;
      $view.querySelector('#again').onclick = () => wordTest(c);
      return;
    }
    const w = ws[n];
    const others = shuffle(WORDS.filter((x) => x !== w && x.ja !== w.ja)).slice(0, 3);
    const opts = shuffle([w, ...others]);
    $view.innerHTML = `<div class="progress">${n + 1} / ${ws.length}</div>
      <div class="card flash"><div class="big">${esc(w.en)}</div>${sayBtn(w.en)}</div>
      <div class="choices">${opts.map((o) => `<button data-k="${esc(o.key)}">${esc(o.ja)}</button>`).join('')}</div><div id="after"></div>`;
    speak(w.en);
    const box = $view.querySelector('.choices');
    box.onclick = (e) => {
      const b = e.target.closest('button'); if (!b || box.dataset.done) return;
      box.dataset.done = 1;
      const right = b.dataset.k === w.key;
      if (right) ok++; else { st.weak[w.key] = 1; delete st.known[w.key]; keep(); b.classList.add('ng'); }
      box.querySelectorAll('button').forEach((x) => { if (x.dataset.k === w.key) x.classList.add('ok'); });
      $view.querySelector('#after').innerHTML = `<div class="card"><div class="en">${esc(w.ex)}</div><div class="ja">${esc(w.exJa)}</div></div>
        <div class="btns"><button class="btn" id="nx">次へ</button></div>`;
      $view.querySelector('#nx').onclick = () => { n++; show(); };
    };
  };
  show();
}

// ---- カード（単語は英→日、フレーズは日→英で「言えるか」） ----
// jaFirst: true=日本語を見て英語、false=英語を見て日本語、null=語句ごとに決める（復習）
function cards(items, title, back, jaFirst) {
  setHead(title, back);
  if (!items.length) { $view.innerHTML = `<div class="card muted">カードがない。</div>`; return; }
  const deck = shuffle(items);
  let n = 0, flipped = false, got = 0;
  const show = () => {
    if (n >= deck.length) {
      $view.innerHTML = `<div class="card flash"><div class="big">${got} / ${deck.length}</div><div class="muted">「まだ」にしたものは復習タブに入る</div></div>
        <div class="btns"><a class="btn sub" href="${back}">もどる</a><button class="btn" id="again">もう一周</button></div>`;
      $view.querySelector('#again').onclick = () => cards(items, title, back, jaFirst);
      return;
    }
    const w = deck[n];
    const jf = jaFirst ?? !w.key.startsWith('w:');
    const front = jf ? `<div class="big" style="font-size:22px">${esc(w.ja)}</div><div class="muted">英語で言ってみて、タップで答え</div>`
      : `<div class="big">${esc(w.en)}</div><div class="muted">意味は？ タップで答え</div>`;
    const backSide = `<div class="big" style="font-size:${w.en.length > 18 ? 20 : 26}px">${esc(w.en)}</div>${sayBtn(w.en)}<div>${esc(w.ja)}</div>
      ${w.ex ? `<div class="note" style="text-align:left">${esc(w.ex)}${w.exJa ? `<br>${esc(w.exJa)}` : ''}</div>` : ''}
      ${w.note ? `<div class="note" style="text-align:left">${esc(w.note)}</div>` : ''}`;
    $view.innerHTML = `<div class="progress">${n + 1} / ${deck.length}</div>
      <div class="card flash" id="fc">${flipped ? backSide : front}</div>
      <div class="btns" ${flipped ? '' : 'hidden'}><button class="btn sub" id="no">まだ</button><button class="btn" id="yes">覚えた</button></div>`;
    if (!jf && !flipped) speak(w.en);
    $view.querySelector('#fc').onclick = (e) => { if (e.target.closest('[data-say]') || flipped) return; flipped = true; show(); speak(w.en); };
    const next = (good) => {
      if (good) { st.known[w.key] = 1; delete st.weak[w.key]; got++; } else { st.weak[w.key] = 1; delete st.known[w.key]; }
      keep(); n++; flipped = false; show();
    };
    if (flipped) { $view.querySelector('#no').onclick = () => next(false); $view.querySelector('#yes').onclick = () => next(true); }
  };
  show();
}

// ---- フレーズ・熟語・句動詞 ----
function phraseGroup(id) {
  if (id === 'idioms') return { title: 'よく使う熟語', items: IDIOM_ITEMS };
  if (id.startsWith('pv-')) { const v = id.slice(3); return { title: `句動詞 ${v} 〜`, items: PV[v] || [] }; }
  const s = (SCENES || []).find((x) => x.id === id);
  return s ? { title: s.title, items: SCENE_ITEMS[id] } : { title: '', items: [] };
}

function phraseList() {
  setHead('フレーズ');
  const row = (href, glyph, title, items) => { const k = countKnown(items);
    return `<a class="row ${k === items.length ? 'done' : ''}" href="${href}"><div class="glyph">${esc(glyph)}</div>
      <div class="row__main"><div class="row__title">${esc(title)}</div>${meter(k, items.length)}</div><div class="row__end">${k}/${items.length}</div></a>`; };
  $view.innerHTML = `<p class="muted">日常会話でそのまま使える言い回し。場面ごとに、日本語を見て英語で言えるまで。</p>
    <h2>場面のフレーズ</h2><div class="list">${(SCENES || []).map((s, i) => row('#/phrases/' + s.id, String(i + 1), s.title, SCENE_ITEMS[s.id])).join('')}</div>
    <h2>熟語</h2><div class="list">${row('#/phrases/idioms', 'id', 'よく使う熟語', IDIOM_ITEMS)}</div>
    <h2>句動詞（動詞＋前置詞・副詞）</h2><div class="list">${Object.keys(PV).map((v) => row('#/phrases/pv-' + v, v, `${v} 〜`, PV[v])).join('')}</div>`;
}

function phrasePage(id) {
  const g = phraseGroup(id);
  if (!g.items.length) { location.hash = '#/phrases'; return; }
  setHead(g.title, '#/phrases');
  const hide = load('hideEn', false);
  $view.innerHTML = `<div class="btns"><a class="btn" href="#/phrases/${id}/cards">カードで練習</a><button class="btn sub" id="hide">${hide ? '英語を見せる' : '英語をかくす'}</button></div>
    <p class="muted" id="hint" ${hide ? '' : 'hidden'}>日本語を見て英語を声に出し、行をタップして答え合わせ。</p>
    <div class="card ${hide ? 'hide-en' : ''}" id="lines">${itemLines(g.items)}</div>`;
  bindMarks($view);
  $view.querySelector('#hide').onclick = () => { save('hideEn', !hide); phrasePage(id); };
  $view.querySelector('#lines').addEventListener('click', (e) => {
    const l = e.target.closest('.line'); if (!l || e.target.closest('button')) return;
    l.classList.add('shown');
  });
}

// ---- 復習 ----
function review() {
  setHead('復習');
  const ks = Object.keys(st.weak).filter((k) => ALL_ITEMS[k]);
  $view.innerHTML = ks.length ? `<div class="btns"><a class="btn" href="#/review/cards">カードで復習（${ks.length}）</a></div>
    <div class="card">${itemLines(ks.map((k) => ALL_ITEMS[k]))}</div>`
    : `<div class="card muted">苦手はまだない。カードで「まだ」にしたもの、テストで間違えたものがここに集まる。</div>`;
  bindMarks($view);
}

route();
