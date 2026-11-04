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

const $view = document.getElementById('view');
const $title = document.getElementById('title');
const $crumb = document.getElementById('crumb');
const $back = document.getElementById('back');

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (a, n) => shuffle(a).slice(0, n);

// ============================================================
// 記録
//   srs   : 語句ごとの復習の箱と次の日 { key: { b: 箱 0〜7, d: 次に出す日 } }
//   steps : ユニットごとの終わった段階 { n: { learn, words, phrases, speak, test: 最高点 } }
//   gScore: 文法の確認問題の最高点 { id: [正解, 問題数] }
//   days  : 日ごとに答えた数 { 'YYYY-MM-DD': 数 }
// ============================================================
const st = Object.assign({ srs: {}, steps: {}, gScore: {}, days: {} }, load('v2', {}));
(function migrate() {   // v1（覚えた / 苦手）からの引き継ぎ
  if (load('v2', null)) return;
  const old = load('state', null);
  if (!old) return;
  const t = today();
  Object.keys(old.known || {}).forEach((k) => { st.srs[k] = { b: 2, d: t + 2 }; });
  Object.keys(old.weak || {}).forEach((k) => { st.srs[k] = { b: 0, d: t }; });
  Object.assign(st.gScore, old.gScore || {});
  keep();
})();
function keep() { save('v2', st); }

function today() { const d = new Date(); return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 864e5); }
function dayKey(n) { return new Date(n * 864e5).toISOString().slice(0, 10); }
function tick() { const k = dayKey(today()); st.days[k] = (st.days[k] || 0) + 1; }

// 間隔反復: 覚えた → 箱が 1 つ上がり、次に出すまでの日が延びる。忘れた → 箱 0 で今日もう一度
const INTERVAL = [0, 1, 2, 4, 7, 15, 30, 60];
function grade(key, g) {
  const cur = st.srs[key] || { b: 0, d: today() };
  const t = today();
  if (g === 0) st.srs[key] = { b: 0, d: t };
  else if (g === 1) st.srs[key] = { b: Math.max(1, cur.b), d: t + 1 };
  else { const b = Math.min(7, cur.b + 1); st.srs[key] = { b, d: t + INTERVAL[b] }; }
  tick(); keep();
}
const dueKeys = () => { const t = today(); return Object.keys(st.srs).filter((k) => st.srs[k].d <= t && ITEMS[k]); };
const box = (k) => (st.srs[k] ? st.srs[k].b : -1);
const LV_NAME = (b) => (b < 0 ? '' : b === 0 ? 'もう一度' : b < 3 ? '練習中' : '定着');
const lvTag = (k) => { const b = box(k); return b < 0 ? '' : `<span class="lv l${b}">${LV_NAME(b)}</span>`; };

// ============================================================
// 読み上げと音声認識（端末の機能を使う。無ければボタンを出さない）
// ============================================================
let voice = null;
function pickVoice() {
  const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  voice = vs.find((v) => v.lang === 'en-US' && /Samantha|Google US|Aria|Jenny|Ava/.test(v.name))
    || vs.find((v) => v.lang === 'en-US') || vs.find((v) => v.lang.startsWith('en')) || null;
}
if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function speak(text) {
  if (!window.speechSynthesis || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/〜/g, ' ').replace(/\//g, ','));
  u.lang = 'en-US'; u.rate = 0.92;
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-say]');
  if (b) { e.stopPropagation(); e.preventDefault(); speak(b.dataset.say); }
});
// 「英語をかくす」のとき、行をタップすると英語が見える
document.addEventListener('click', (e) => { const l = e.target.closest('.hide-en .line'); if (l && !e.target.closest('button')) l.classList.add('shown'); });
const sayBtn = (t, sm) => `<button class="say${sm ? ' sm' : ''}" data-say="${esc(t)}" aria-label="読み上げ">▶</button>`;

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function listen(onText) {
  const r = new SR();
  r.lang = 'en-US'; r.interimResults = false; r.maxAlternatives = 1;
  let got = false;
  r.onresult = (e) => { got = true; onText(e.results[0][0].transcript); };
  r.onerror = () => { if (!got) { got = true; onText(null); } };
  r.onend = () => { if (!got) onText(null); };
  r.start();
  return r;
}
const words = (t) => t.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
function compare(target, heard) {
  const hs = new Set(words(heard));
  const ws = target.replace(/〜/g, ' ').split(/\s+/).filter(Boolean);
  let ok = 0;
  const html = ws.map((w) => { const n = words(w)[0]; const hit = !n || hs.has(n); if (hit) ok++; return `<span class="w ${hit ? 'ok' : 'miss'}">${esc(w)}</span>`; }).join(' ');
  return { html, rate: ws.length ? ok / ws.length : 0 };
}

// ============================================================
// データ（文法・単語・句動詞はコアイメージ英語から、フレーズと熟語は data/phrases.js）
// ============================================================
const G = Object.fromEntries(GRAMMAR.map((g) => [g.id, g]));
const ITEMS = {};
const add = (it) => { ITEMS[it.key] = it; return it; };

const WORDS = VOCAB.map(([en, ja, rank, ex, exJa, ipa]) => add({ key: 'w:' + en, type: 'w', en, ja, rank: en === 'the' ? 0 : rank, ex, exJa, ipa }))
  .sort((a, b) => a.rank - b.rank);
const SCENE = Object.fromEntries(SCENES.map((s) => [s.id, { title: s.title, items: s.phrases.map((p) => add({ key: 'p:' + p.en, type: 'p', en: p.en, ja: p.ja, note: p.note })) }]));
const IDIOM_ITEMS = IDIOMS.map((p) => add({ key: 'i:' + p.en, type: 'i', en: p.en, ja: p.ja, ex: p.ex, exJa: p.exJa, note: p.note }));
const PV = {};
PHRASALS.forEach((p) => { (PV[p.v] = PV[p.v] || []).push(add({ key: `v:${p.v} ${p.p}`, type: 'v', en: `${p.v} ${p.p}`, ja: p.ja, ex: p.en, note: p.note })); });
const gSentences = (id) => G[id].senses.flatMap((s) => s.examples.map((e) => add({ key: 'g:' + e.en, type: 'g', en: e.en, ja: e.ja, note: e.note || s.label })));

// ============================================================
// コース: 20 ユニット。1 ユニット = 文法 2 つ + 単語 50 語 + 会話フレーズ（か熟語） + 句動詞
// 文法は学年順ではなく、会話で早く使える順。フレーズの場面は文法と噛み合うものを組ませた
// ============================================================
const PHASES = [
  { name: 'はじめの一歩', desc: 'あいさつと自分のことを話す', color: 'var(--p1)' },
  { name: '毎日の会話', desc: 'いま・過去・予定を話す', color: 'var(--p2)' },
  { name: '気持ちと考え', desc: 'したいこと・思うことを伝える', color: 'var(--p3)' },
  { name: '比べる・説明する', desc: '買い物や道案内で詳しく言う', color: 'var(--p4)' },
  { name: '一歩先へ', desc: '仮定やていねいな言い方', color: 'var(--p5)' },
];
const IDIOM_SET = (k) => { const n = Math.ceil(IDIOM_ITEMS.length / 4); return { title: `よく使う熟語 ${k + 1}`, items: IDIOM_ITEMS.slice(k * n, k * n + n) }; };
const UNITS = [
  ['あいさつして話し始める', ['g-order', 'g-present'], 'greet', []],
  ['自己紹介をする', ['g-do', 'g-article'], 'intro', []],
  ['相づちで会話に乗る', ['g-imp', 'g-plural'], 'react', []],
  ['身のまわりのことを話す', ['g-there', 'g-pron'], 'daily', []],
  ['今していることを話す', ['g-prog', 'g-it'], 'confirm', ['get', 'go']],
  ['昨日のことを話す', ['g-past', 'g-pastprog'], 'thanks', ['come', 'take']],
  ['お願いする・頼む', ['g-modal', 'g-tag'], 'request', ['look', 'put']],
  ['誘う・予定を決める', ['g-future', 'g-quant'], 'invite', ['turn', 'give']],
  ['気持ちを伝える', ['g-adj', 'g-perfect'], 'feel', ['make', 'have']],
  ['したいこと・好きなことを話す', ['g-inf', 'g-ing'], 0, ['keep', 'run']],
  ['意見を言う', ['g-that', 'g-wh'], 'opinion', ['bring', 'call']],
  ['話をつなげて長く話す', ['g-and', 'g-when'], 'connect', ['pick', 'set']],
  ['買い物で比べる', ['g-comp', 'g-super'], 'shopping', ['hold', 'let']],
  ['お店で注文する', ['g-as', 'g-compadv'], 'restaurant', ['work', 'play']],
  ['人や物をくわしく説明する', ['g-rel', 'g-reladv'], 1, ['break', 'stand']],
  ['道をたずねる・案内する', ['g-part', 'g-passive'], 'direction', ['leave', 'cut']],
  ['電話・オンラインで話す', ['g-svoo', 'g-svoc'], 'phone', ['pull', 'push']],
  ['人に何かをしてもらう', ['g-causative', 'g-percept'], 2, ['carry', 'fall']],
  ['困ったときに伝える', ['g-if', 'g-modalperf'], 'trouble', ['catch', 'pass']],
  ['振り返って話す', ['g-pastperf', 'g-partcon'], 3, []],
].map(([title, g, ph, verbs], i) => {
  const set = typeof ph === 'number' ? IDIOM_SET(ph) : SCENE[ph];
  const u = {
    n: i + 1, title, phase: Math.floor(i / 4),
    g: g.filter((id) => G[id]),
    words: WORDS.slice(i * 50, i * 50 + 50),
    setTitle: set.title, phrases: set.items,
    verbs, pv: verbs.flatMap((v) => PV[v] || []),
  };
  u.color = PHASES[u.phase].color;
  u.sentences = u.g.flatMap(gSentences);
  return u;
});
// どのユニットにも入らなかった文法・句動詞が無いようにする（データが増えたときの保険）
const usedG = new Set(UNITS.flatMap((u) => u.g));
GRAMMAR.filter((g) => !usedG.has(g.id)).forEach((g) => { UNITS[UNITS.length - 1].g.push(g.id); UNITS[UNITS.length - 1].sentences.push(...gSentences(g.id)); });
const usedV = new Set(UNITS.flatMap((u) => u.verbs));
Object.keys(PV).filter((v) => !usedV.has(v)).forEach((v) => { const u = UNITS[UNITS.length - 1]; u.verbs.push(v); u.pv.push(...PV[v]); });
const unitOfG = Object.fromEntries(UNITS.flatMap((u) => u.g.map((id) => [id, u.n])));

const STEPS = [
  { id: 'learn', name: '文法を理解', icon: '1' },
  { id: 'words', name: '単語 50', icon: '2' },
  { id: 'phrases', name: 'フレーズ', icon: '3' },
  { id: 'speak', name: '話す', icon: '4' },
  { id: 'test', name: 'まとめテスト', icon: '5' },
];
const PASS = 8;   // まとめテスト 10 問のうちこれ以上でユニット修了
const us = (n) => (st.steps[n] = st.steps[n] || {});
const allIn = (items) => items.every((it) => st.srs[it.key]);
function stepDone(u, id) {
  const s = st.steps[u.n] || {};
  if (id === 'learn') return u.g.every((g) => st.gScore[g]);
  if (id === 'words') return allIn(u.words);
  if (id === 'phrases') return allIn(u.phrases) && allIn(u.pv);
  if (id === 'speak') return !!s.speak;
  if (id === 'test') return (s.test || 0) >= PASS;
  return false;
}
const unitDone = (u) => stepDone(u, 'test');
const doneCount = (u) => STEPS.filter((s) => stepDone(u, s.id)).length;
const nextStep = (u) => STEPS.find((s) => !stepDone(u, s.id)) || STEPS[0];
const curUnit = () => UNITS.find((u) => !unitDone(u)) || UNITS[UNITS.length - 1];

// ============================================================
// 画面の切り替え（#/〜）
// ============================================================
function setHead(title, crumb, back) {
  $title.textContent = title;
  $crumb.textContent = crumb || '';
  $back.hidden = !back;
  $back.onclick = () => { location.hash = back; };
  document.title = title === 'talk-english' ? 'talk-english — 中学英文法・英単語1000・会話フレーズ' : `${title} — talk-english`;
}
function setTab(tab, unitN) {
  document.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  const due = dueKeys().length;
  document.querySelectorAll('[data-due]').forEach((b) => { b.hidden = !due; b.textContent = due > 99 ? '99+' : due; });
  const cur = curUnit().n;
  document.getElementById('sideunits').innerHTML = PHASES.map((p, pi) => `<div class="side__phase">${esc(p.name)}</div>` +
    UNITS.filter((u) => u.phase === pi).map((u) => `<a class="side__unit ${u.n === unitN ? 'on' : ''}" href="#/u/${u.n}" style="--pc:${u.color}">
      <span class="dot ${unitDone(u) ? 'done' : ''}">${unitDone(u) ? '✓' : u.n}</span><span>${esc(u.title)}</span>
      <span class="mini-ring">${u.n === cur && !unitDone(u) ? '▶' : `${doneCount(u)}/5`}</span></a>`).join('')).join('');
}

function route() {
  if (window.speechSynthesis) speechSynthesis.cancel();
  stopListening();
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const [a = '', b, c, d, e] = parts;
  window.scrollTo(0, 0);
  if (a === 'course') return course();
  if (a === 'review') return b === 'go' ? reviewGo() : review();
  if (a === 'library') return library(b || 'grammar');
  if (a === 'g' && G[b]) return grammarAlone(b, c === 'quiz');
  if (a === 'u') {
    const u = UNITS[(+b || 1) - 1];
    if (!u) { location.hash = '#/course'; return; }
    const step = c || nextStep(u).id;
    if (step === 'learn') return d === 'quiz' ? learnQuiz(u, +e || 0) : learn(u, +d || 0);
    if (step === 'words') return d === 'cards' ? unitCards(u, 'words') : d === 'quiz' ? wordQuiz(u) : wordsStep(u);
    if (step === 'phrases') return d === 'cards' ? unitCards(u, 'phrases') : phrasesStep(u);
    if (step === 'speak') return d === 'go' ? speakGo(u) : speakStep(u);
    if (step === 'test') return unitTest(u);
  }
  return home();
}
addEventListener('hashchange', route);

// ============================================================
// ホーム: 次にやること・今日の復習・横に流れるロードマップ
// ============================================================
function home() {
  setHead('talk-english'); setTab('home');
  const u = curUnit();
  const ns = nextStep(u);
  const due = dueKeys().length;
  const allDone = UNITS.every(unitDone);
  const learned = (t) => Object.keys(st.srs).filter((k) => k[0] === t).length;
  const settled = Object.values(st.srs).filter((s) => s.b >= 3).length;
  const gDone = GRAMMAR.filter((g) => st.gScore[g.id]).length;
  const phraseAll = IDIOM_ITEMS.length + Object.values(SCENE).reduce((a, s) => a + s.items.length, 0) + PHRASALS.length;
  const t = today();
  let streak = 0; for (let i = (st.days[dayKey(t)] ? 0 : 1); st.days[dayKey(t - i)]; i++) streak++;
  const days = [...Array(14).keys()].reverse().map((i) => { const v = st.days[dayKey(t - i)] || 0;
    return `<i class="${v >= 60 ? 'l3' : v >= 20 ? 'l2' : v ? 'l1' : ''} ${i === 0 ? 'today' : ''}" title="${dayKey(t - i)}: ${v}"></i>`; }).join('');

  $view.innerHTML = `
    <div class="home-top">
    <div class="card hero" style="--pc:${u.color}">
      <div>
        <div class="eyebrow">${allDone ? 'コース修了' : `いまのユニット ・ ${u.n} / ${UNITS.length} ・ ${esc(PHASES[u.phase].name)}`}</div>
        <h2>${allDone ? 'おつかれさま！ あとは復習で定着させよう' : esc(u.title)}</h2>
        <div class="muted">文法: ${u.g.map((g) => esc(G[g].title)).join('・')} ／ 単語 ${u.n * 50 - 49}〜${u.n * 50} ／ ${esc(u.setTitle)}</div>
        ${stepsBar(u, null, true)}
      </div>
      <a class="btn" href="#/u/${u.n}/${ns.id}">${stepDone(u, 'learn') || doneCount(u) ? '続ける' : 'はじめる'}: ${esc(ns.name)} →</a>
    </div>

    <div class="side-pair">
      <div class="card">
        <h2>今日の復習</h2>
        <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
          <div class="stat"><b>${due}<small> 個</small></b><span>${due ? '忘れかけのころ合い。今がいちばん効く' : '今日の分はおわり'}</span></div>
          <a class="btn ${due ? '' : 'sub'}" href="${due ? '#/review/go' : '#/review'}" style="margin-left:auto">${due ? '復習する' : '復習の様子'}</a>
        </div>
        <div class="days">${days}</div>
        <div class="muted" style="margin-top:6px">${streak ? `${streak} 日続いている` : '1 日 10 分でも、毎日やるのがいちばん効く'}（ここ 14 日の学習量）</div>
      </div>
      <div class="card stats" style="grid-template-columns:1fr 1fr">
        <div class="stat"><b>${gDone}<small>/${GRAMMAR.length}</small></b><span>文法</span></div>
        <div class="stat"><b>${learned('w')}<small>/${WORDS.length}</small></b><span>単語</span></div>
        <div class="stat"><b>${learned('p') + learned('i') + learned('v')}<small>/${phraseAll}</small></b><span>フレーズ・熟語</span></div>
        <div class="stat"><b>${settled}</b><span>定着した語句</span></div>
      </div>
    </div>
    </div>

    <div class="sec-title">ロードマップ <small>左から右へ。各ユニットは ① 文法 → ② 単語 → ③ フレーズ → ④ 話す → ⑤ テスト</small></div>
    ${roadmap(u.n)}

    <div class="sec-title">このコースの学び方</div>
    <div class="grid g3">
      <div class="card"><div class="eyebrow">わかる</div><b>文法は「なぜ」から</b><div class="muted">形の暗記ではなく、その形がどういう気持ちを表すかのコアから。わかったら確認問題で確かめる。</div></div>
      <div class="card"><div class="eyebrow">言える</div><b>日本語 → 英語で口に出す</b><div class="muted">会話は「わかる」より「言える」が大事。日本語を見て英語を声に出し、マイクで聞き取ってもらう。</div></div>
      <div class="card"><div class="eyebrow">忘れない</div><b>間隔をあけて復習</b><div class="muted">覚えた語句は 1・2・4・7・15・30 日…と間をあけて出す。忘れかけで思い出すと長く残る。</div></div>
    </div>`;
}

function stepsBar(u, on, compact) {
  return `<div class="steps" style="--pc:${u.color};${compact ? 'margin:12px 0 0' : ''}">${STEPS.map((s) => {
    const done = stepDone(u, s.id);
    return `<a class="step ${done ? 'done' : ''} ${s.id === on ? 'on' : ''}" href="#/u/${u.n}/${s.id}">
      <span class="step__n">${done ? '✓' : s.icon}</span><b>${esc(s.name)}</b>${compact ? '' : `<span>${stepNote(u, s.id)}</span>`}</a>`;
  }).join('')}</div>`;
}
function stepNote(u, id) {
  const cnt = (items) => `${items.filter((i) => st.srs[i.key]).length}/${items.length}`;
  if (id === 'learn') return `${u.g.filter((g) => st.gScore[g]).length}/${u.g.length} 項目`;
  if (id === 'words') return cnt(u.words);
  if (id === 'phrases') return cnt([...u.phrases, ...u.pv]);
  if (id === 'speak') return st.steps[u.n]?.speak ? '済み' : `${u.sentences.length} 文`;
  const best = st.steps[u.n]?.test;
  return best != null ? `最高 ${best}/10` : `${PASS}/10 で修了`;
}

function roadmap(cur) {
  return `<div class="road">${PHASES.map((p, pi) => `<div class="phase" style="--pc:${p.color}">
    <div class="eyebrow">フェーズ ${pi + 1}</div><h3>${esc(p.name)}</h3><div class="muted">${esc(p.desc)}</div>
    <div class="phase__units">${UNITS.filter((u) => u.phase === pi).map((u) => `<a class="unode ${u.n === cur ? 'cur' : ''}" href="#/u/${u.n}" style="--pc:${u.color}">
      <span class="dot ${unitDone(u) ? 'done' : ''}">${unitDone(u) ? '✓' : u.n}</span>
      <span class="unode__t">${esc(u.title)}<small>${u.g.map((g) => esc(G[g].title)).join('・')}</small></span>
      <span class="pips">${STEPS.map((s) => `<i class="${stepDone(u, s.id) ? 'on' : ''}"></i>`).join('')}</span></a>`).join('')}</div>
  </div>`).join('')}</div>`;
}

// ============================================================
// コース一覧
// ============================================================
function course() {
  setHead('コース', `全 ${UNITS.length} ユニット`); setTab('course');
  $view.innerHTML = `<p class="lead">中学英文法 ${GRAMMAR.length} 項目・よく使う単語 1000 語・会話フレーズと熟語 ${IDIOM_ITEMS.length + Object.values(SCENE).reduce((a, s) => a + s.items.length, 0)} 個・句動詞 ${PHRASALS.length} 個を、会話で早く使える順に ${UNITS.length} ユニットへ。どこから始めてもいいが、上から順にやると前のユニットの文法と単語が次で使われる。</p>
    ${roadmap(curUnit().n)}
    ${PHASES.map((p, pi) => `<div class="sec-title" style="color:${p.color}">フェーズ ${pi + 1} ${esc(p.name)} <small>${esc(p.desc)}</small></div>
      <div class="grid g2 g-wide4">${UNITS.filter((u) => u.phase === pi).map((u) => `<a class="card ucard" href="#/u/${u.n}" style="--pc:${u.color}">
        <div class="ucard__head"><span class="dot ${unitDone(u) ? 'done' : ''}">${unitDone(u) ? '✓' : u.n}</span><h3>${esc(u.title)}</h3><span class="pips">${STEPS.map((s) => `<i class="${stepDone(u, s.id) ? 'on' : ''}"></i>`).join('')}</span></div>
        <ul>
          <li><b>文法</b> ${u.g.map((g) => esc(G[g].title)).join('・')}</li>
          <li><b>単語</b> ${u.n * 50 - 49}〜${u.n * 50} 位（${u.words.slice(0, 5).map((w) => esc(w.en)).join(', ')} …）</li>
          <li><b>フレーズ</b> ${esc(u.setTitle)}（${u.phrases.length}）${u.verbs.length ? ` ＋ 句動詞 ${u.verbs.map(esc).join('・')}（${u.pv.length}）` : ''}</li>
        </ul></a>`).join('')}</div>`).join('')}`;
}

// ============================================================
// ユニットの各段階
// ============================================================
function unitHead(u, step) {
  setHead(u.title, `ユニット ${u.n} ・ ${PHASES[u.phase].name}`, '#/course'); setTab('course', u.n);
  return stepsBar(u, step);
}
function nextLink(u, step) {
  const i = STEPS.findIndex((s) => s.id === step);
  if (i < STEPS.length - 1) return `<a class="btn sub" href="#/u/${u.n}/${STEPS[i + 1].id}">次: ${esc(STEPS[i + 1].name)} →</a>`;
  return u.n < UNITS.length ? `<a class="btn sub" href="#/u/${u.n + 1}">次のユニットへ →</a>` : '';
}

// ---- ① 文法を理解 ----
function grammarBody(id, quizHref, pc) {
  const g = G[id];
  const qs = GRAMMAR_QUIZ.filter((q) => q.ref === id);
  const sc = st.gScore[id];
  return `<div class="grid g-main" style="--pc:${pc}">
    <div>
      <div class="card core-box">
        <div class="eyebrow">${esc(g.headword)}</div>
        <div class="core">${esc(g.core)}</div>
        <div>${esc(g.coreNote)}</div>
      </div>
      ${g.senses.map((s) => `<div class="card sense">
        <h3>${esc(s.label)}</h3>${s.gloss ? `<div class="muted" style="margin-bottom:8px">${esc(s.gloss)}</div>` : ''}
        ${s.examples.map((e) => `<div class="line">${sayBtn(e.en)}<div><div class="en">${esc(e.en)}</div><div class="ja">${esc(e.ja)}</div>${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}</div></div>`).join('')}
      </div>`).join('')}
    </div>
    <div class="grid">
      <div class="card">
        <h2>確認問題</h2>
        <div class="muted">読んだら、${qs.length} 問で「わかった」を確かめる。間違えたら解説がコアに戻してくれる。</div>
        ${sc ? `<div style="margin-top:8px"><span class="tag ${sc[0] === sc[1] ? 'good' : ''}">最高 ${sc[0]} / ${sc[1]}</span></div>` : ''}
        <div class="btns fill"><a class="btn" href="${quizHref}">${sc ? 'もう一度解く' : '解いてみる'}（${qs.length} 問）</a></div>
      </div>
      ${(g.trivia || []).map((t) => `<details class="card trivia"><summary>💡 ${esc(t.title)}</summary><p>${esc(t.body)}</p></details>`).join('')}
    </div>
  </div>`;
}

function learn(u, gi) {
  const id = u.g[gi] || u.g[0];
  $view.innerHTML = unitHead(u, 'learn') + `
    <div class="gtabs" style="--pc:${u.color}">${u.g.map((g, i) => `<button class="${g === id ? 'on' : ''}" data-gi="${i}">${st.gScore[g] ? '✓' : `${i + 1}.`} ${esc(G[g].title)}</button>`).join('')}</div>
    ${grammarBody(id, `#/u/${u.n}/learn/quiz/${u.g.indexOf(id)}`, u.color)}
    <div class="btns">${u.g.indexOf(id) < u.g.length - 1 ? `<a class="btn sub" href="#/u/${u.n}/learn/${u.g.indexOf(id) + 1}">次の文法: ${esc(G[u.g[u.g.indexOf(id) + 1]].title)} →</a>` : nextLink(u, 'learn')}</div>`;
  $view.querySelector('.gtabs').onclick = (e) => { const b = e.target.closest('[data-gi]'); if (b) location.hash = `#/u/${u.n}/learn/${b.dataset.gi}`; };
}

function grammarQuestions(id) {
  return shuffle(GRAMMAR_QUIZ.filter((q) => q.ref === id)).map((q) => ({ prompt: q.prompt, sub: q.question, choices: q.choices, answer: q.answer, explain: q.explain }));
}
function learnQuiz(u, gi) {
  const id = u.g[gi];
  setHead(`${G[id].title} の確認`, `ユニット ${u.n} ・ ① 文法を理解`, `#/u/${u.n}/learn/${gi}`); setTab('course', u.n);
  choiceDrill(grammarQuestions(id), (ok, n) => {
    const best = st.gScore[id];
    if (!best || ok >= best[0]) st.gScore[id] = [ok, n];
    keep();
    const nextG = u.g[gi + 1];
    return nextG ? `<a class="btn" href="#/u/${u.n}/learn/${gi + 1}">次の文法: ${esc(G[nextG].title)} →</a>`
      : `<a class="btn" href="#/u/${u.n}/words">次: ② 単語 50 →</a>`;
  }, `#/u/${u.n}/learn/${gi}`);
}

// ---- ② 単語 ----
function tile(w) {
  return `<div class="tile"><div class="tile__top"><b>${esc(w.en)}</b>${lvTag(w.key)}${sayBtn(w.en)}</div>
    ${w.ipa ? `<div class="ipa">${esc(w.ipa)}</div>` : ''}<div>${esc(w.ja)}</div>
    ${w.ex ? `<div class="ex">${esc(w.ex)}${sayBtn(w.ex, true)}<br>${esc(w.exJa || '')}</div>` : ''}</div>`;
}
function wordsStep(u) {
  const n = u.words.filter((w) => st.srs[w.key]).length;
  $view.innerHTML = unitHead(u, 'words') + `
    <div class="grid g-main">
      <div class="card">
        <h2>英語の文章の約 8 割はこの 1000 語でできている</h2>
        <div class="muted">NGSL（New General Service List）の頻度順 ${u.n * 50 - 49}〜${u.n * 50} 位。① ▶ で音を聞きながら一覧を眺める → ② カードで「わかる / あやしい / まだ」を付ける → ③ 4 択で確かめる。カードに出した語は、間をあけて復習に出てくる。</div>
      </div>
      <div class="card">
        <div class="stat"><b>${n}<small>/${u.words.length}</small></b><span>カードで学んだ語</span></div>
        <div class="meter" style="--pc:${u.color};margin:8px 0"><i style="width:${n / u.words.length * 100}%"></i></div>
        <div class="btns fill"><a class="btn" href="#/u/${u.n}/words/cards">カードで覚える</a><a class="btn sub" href="#/u/${u.n}/words/quiz">4 択で確認</a></div>
      </div>
    </div>
    <div class="sec-title">${u.n * 50 - 49}〜${u.n * 50} 位の 50 語</div>
    <div class="tiles">${u.words.map(tile).join('')}</div>
    <div class="btns">${nextLink(u, 'words')}</div>`;
}
function wordChoiceQs(ws, pool) {
  return ws.map((w) => {
    const others = pick(pool.filter((x) => x !== w && x.ja !== w.ja), 3);
    const opts = shuffle([w, ...others]);
    return { prompt: w.en, sub: '意味は？', say: w.en, choices: opts.map((o) => o.ja), answer: opts.indexOf(w), explain: w.ex ? `${w.ex}\n${w.exJa}` : '', key: w.key };
  });
}
function wordQuiz(u) {
  setHead('4 択で確認', `ユニット ${u.n} ・ ② 単語`, `#/u/${u.n}/words`); setTab('course', u.n);
  choiceDrill(wordChoiceQs(pick(u.words, 15), u.words), () => `<a class="btn" href="#/u/${u.n}/phrases">次: ③ フレーズ →</a>`, `#/u/${u.n}/words`);
}

// ---- ③ フレーズ ----
function lines(items) {
  return items.map((w) => `<div class="line">${sayBtn(w.en)}<div>
    <div class="en">${esc(w.en)} ${lvTag(w.key)}</div><div class="ja">${esc(w.ja)}</div>
    ${w.ex ? `<div class="note">${esc(w.ex)}${sayBtn(w.ex, true)}${w.exJa ? `<br>${esc(w.exJa)}` : ''}</div>` : ''}
    ${w.note ? `<div class="note">${esc(w.note)}</div>` : ''}</div></div>`).join('');
}
function phrasesStep(u) {
  const hide = load('hideEn', false);
  const all = [...u.phrases, ...u.pv];
  const n = all.filter((w) => st.srs[w.key]).length;
  $view.innerHTML = unitHead(u, 'phrases') + `
    <div class="grid g-main">
      <div class="card">
        <h2>そのまま使える言い回し</h2>
        <div class="muted">会話はかたまりで覚えると口から出やすい。「英語をかくす」にして日本語だけを見て声に出し、行をタップして答え合わせ。カードは日本語 → 英語で出る。</div>
      </div>
      <div class="card">
        <div class="stat"><b>${n}<small>/${all.length}</small></b><span>カードで学んだフレーズ</span></div>
        <div class="meter" style="--pc:${u.color};margin:8px 0"><i style="width:${n / all.length * 100}%"></i></div>
        <div class="btns fill"><a class="btn" href="#/u/${u.n}/phrases/cards">カードで練習</a><button class="btn sub" id="hide">${hide ? '英語を見せる' : '英語をかくす'}</button></div>
      </div>
    </div>
    <div class="grid ${u.pv.length ? 'g2' : ''}" style="margin-top:14px">
      <div class="card ${hide ? 'hide-en' : ''}"><h2>${esc(u.setTitle)}</h2>${lines(u.phrases)}</div>
      ${u.pv.length ? `<div class="card ${hide ? 'hide-en' : ''}"><h2>句動詞 ${u.verbs.map(esc).join('・')} <span class="muted">動詞＋前置詞・副詞</span></h2>${lines(u.pv)}</div>` : ''}
    </div>
    <div class="btns">${nextLink(u, 'phrases')}</div>`;
  $view.querySelector('#hide').onclick = () => { save('hideEn', !hide); phrasesStep(u); };
}

function unitCards(u, which) {
  const items = which === 'words' ? u.words : [...u.phrases, ...u.pv];
  const back = `#/u/${u.n}/${which}`;
  setHead(which === 'words' ? '単語カード' : 'フレーズカード', `ユニット ${u.n} ・ ${which === 'words' ? '② 単語' : '③ フレーズ'}`, back); setTab('course', u.n);
  // まだ学んでいない語を先に、学んだ語は箱の低い順に
  const order = shuffle(items).sort((a, b) => box(a.key) - box(b.key));
  cardDrill(order, () => `<a class="btn" href="#/u/${u.n}/${which === 'words' ? 'words/quiz' : 'speak'}">次: ${which === 'words' ? '4 択で確認' : '④ 話す'} →</a>`, back);
}

// ---- ④ 話す ----
function speakStep(u) {
  $view.innerHTML = unitHead(u, 'speak') + `
    <div class="grid g-main">
      <div class="card">
        <h2>日本語を見て、英語で言う</h2>
        <div class="muted">このユニットの文法の例文 ${u.sentences.length} 文を、日本語から英語にして声に出す（瞬間英作文）。
        ${SR ? '🎤 を押して話すと、聞き取れた語を緑、抜けた語を赤で示す。' : 'このブラウザは音声の聞き取りに対応していないので、声に出してから答えを見る。'}
        考え込まずに 3 秒で言えるのが目標。言えなかった文は復習に回る。</div>
        <div class="btns"><a class="btn" href="#/u/${u.n}/speak/go">はじめる（${u.sentences.length} 文）</a></div>
      </div>
      <div class="card"><h2>出てくる文</h2>${u.sentences.slice(0, 6).map((s) => `<div class="line"><div><div class="ja">${esc(s.ja)}</div></div></div>`).join('')}<div class="muted">…ほか ${Math.max(0, u.sentences.length - 6)} 文</div></div>
    </div>
    <div class="btns">${nextLink(u, 'speak')}</div>`;
}
function speakGo(u) {
  setHead('話す練習', `ユニット ${u.n} ・ ④ 話す`, `#/u/${u.n}/speak`); setTab('course', u.n);
  speakDrill(shuffle(u.sentences), () => { us(u.n).speak = 1; keep(); return `<a class="btn" href="#/u/${u.n}/test">次: ⑤ まとめテスト →</a>`; }, `#/u/${u.n}/speak`);
}

// ---- ⑤ まとめテスト ----
function unitTest(u) {
  const head = unitHead(u, 'test');
  const gq = u.g.flatMap((id) => pick(GRAMMAR_QUIZ.filter((q) => q.ref === id), 2))
    .map((q) => ({ prompt: q.prompt, sub: q.question, choices: q.choices, answer: q.answer, explain: q.explain, tag: '文法' }));
  const wq = wordChoiceQs(pick(u.words, 3), u.words).map((q) => ({ ...q, tag: '単語' }));
  const pool = [...u.phrases, ...u.pv];
  const pq = pick(pool, 3).map((p) => {
    const opts = shuffle([p, ...pick(pool.filter((x) => x !== p), 3)]);
    return { prompt: p.ja, sub: '英語で言うと？', choices: opts.map((o) => o.en), answer: opts.indexOf(p), explain: p.note || '', say: null, sayAfter: p.en, tag: 'フレーズ', key: p.key };
  });
  const qs = [...gq, ...wq, ...pq].slice(0, 10);
  const best = st.steps[u.n]?.test;
  $view.innerHTML = head + `<div class="card drill" style="text-align:center">
    <h2>まとめテスト（10 問）</h2>
    <div class="muted">文法 4 問・単語 3 問・フレーズ 3 問。${PASS} 問以上でユニット修了。${best != null ? `これまでの最高は ${best} 問。` : ''}</div>
    <div class="btns" style="justify-content:center"><button class="btn" id="go">はじめる</button></div></div>`;
  $view.querySelector('#go').onclick = () => {
    setHead('まとめテスト', `ユニット ${u.n} ・ ⑤ まとめ`, `#/u/${u.n}/test`);
    choiceDrill(qs, (ok) => {
      const s = us(u.n); s.test = Math.max(s.test || 0, ok); keep();
      setTab('course', u.n);
      if (ok >= PASS) return u.n < UNITS.length ? `<a class="btn" href="#/u/${u.n + 1}">ユニット ${u.n + 1} へ →</a>` : `<a class="btn" href="#/">ホームへ</a>`;
      return `<a class="btn" href="#/u/${u.n}/test">もう一度</a>`;
    }, `#/u/${u.n}/test`, (ok) => (ok >= PASS ? `🎉 ユニット ${u.n} 修了！` : `あと ${PASS - ok} 問。間違えた所を見直してもう一度`));
  };
}

// ============================================================
// 練習の部品（4 択・カード・話す）
// ============================================================
function drillBar(i, n, back) {
  return `<div class="drill__bar"><span>${Math.min(i + 1, n)} / ${n}</span><div class="meter"><i style="width:${i / n * 100}%"></i></div><a class="muted" href="${back}">やめる</a></div>`;
}
function resultView(big, msg, nextHtml, back) {
  $view.innerHTML = `<div class="drill"><div class="card result"><div class="big">${big}</div><div class="muted" style="font-size:15px">${msg}</div>
    <div class="btns" style="justify-content:center"><a class="btn sub" href="${back}">もどる</a>${nextHtml || ''}</div></div></div>`;
}

// 4 択。単語・フレーズの問題は答えた結果を復習の記録にも入れる
function choiceDrill(qs, onEnd, back, msgFn) {
  let i = 0, ok = 0;
  const show = () => {
    if (i >= qs.length) {
      const next = onEnd(ok, qs.length);
      resultView(`${ok} / ${qs.length}`, msgFn ? msgFn(ok) : ok === qs.length ? '全問正解！' : '間違えた問題は解説を読み直そう', next, back);
      return;
    }
    // 元の問題は正解が前の方に偏っているので、選択肢は毎回並べ替える
    const q0 = qs[i];
    const order = shuffle(q0.choices.map((_, k) => k));
    const q = { ...q0, choices: order.map((k) => q0.choices[k]), answer: order.indexOf(q0.answer) };
    $view.innerHTML = `<div class="drill">${drillBar(i, qs.length, back)}
      <div class="card">${q.tag ? `<span class="tag">${q.tag}</span>` : ''}<div class="quiz-q">${esc(q.prompt)} ${q.say ? sayBtn(q.say, true) : ''}</div><div class="muted">${esc(q.sub || '')}</div></div>
      <div class="choices">${q.choices.map((c, k) => `<button data-k="${k}">${esc(c)}</button>`).join('')}</div><div id="after"></div></div>`;
    if (q.say) speak(q.say);
    const box = $view.querySelector('.choices');
    box.onclick = (e) => {
      const b = e.target.closest('button'); if (!b || box.dataset.done) return;
      box.dataset.done = 1;
      const right = +b.dataset.k === q.answer;
      if (right) ok++;
      if (q.key) grade(q.key, right ? 2 : 0); else { tick(); keep(); }
      box.querySelectorAll('button').forEach((x) => { if (+x.dataset.k === q.answer) x.classList.add('ok'); });
      if (!right) b.classList.add('ng');
      if (q.sayAfter) speak(q.sayAfter);
      $view.querySelector('#after').innerHTML = `<div class="card feedback ${right ? '' : 'ng'}"><b style="color:var(--${right ? 'good' : 'bad'})">${right ? '正解' : '不正解'}</b>
        ${q.explain ? `<div style="white-space:pre-line">${esc(q.explain)}</div>` : ''}</div>
        <div class="btns fill"><button class="btn" id="nx">${i + 1 < qs.length ? '次へ' : '結果を見る'}</button></div>`;
      const nx = $view.querySelector('#nx'); nx.focus({ preventScroll: true });
      nx.onclick = () => { i++; show(); window.scrollTo(0, 0); };
    };
  };
  show();
}

// カード。単語は英語 → 意味、フレーズ・文は日本語 → 英語（言えるか）
const GRADE_BTNS = `<div class="grade"><button class="btn bad" data-g="0">まだ<small>今日もう一度</small></button>
  <button class="btn warn" data-g="1">あやしい<small>明日</small></button><button class="btn good" data-g="2">わかる<small>間をあける</small></button></div>`;
function cardDrill(items, onEnd, back) {
  const deck = items.slice();
  const total = deck.length;
  let i = 0, flipped = false, good = 0;
  const again = new Set();
  const show = () => {
    if (i >= deck.length) {
      resultView(`${good} / ${total}`, '「わかる」の数。まだの語句は時間をおいて復習に出てくる', onEnd(), back);
      return;
    }
    const w = deck[i];
    const jaFirst = w.type !== 'w';
    const front = jaFirst
      ? `<div class="mid">${esc(w.ja)}</div><div class="hint">英語で言ってから、タップで答え（Space）</div>`
      : `<div class="big">${esc(w.en)}</div><div class="hint">意味は？ タップで答え</div>`;
    const backSide = `<div class="${w.en.length > 16 ? 'mid' : 'big'}">${esc(w.en)} ${sayBtn(w.en, true)}</div>${w.ipa ? `<div class="hint">${esc(w.ipa)}</div>` : ''}
      <div style="font-size:16px">${esc(w.ja)}</div>
      ${w.ex ? `<div class="note" style="text-align:left">${esc(w.ex)}${sayBtn(w.ex, true)}${w.exJa ? `<br>${esc(w.exJa)}` : ''}</div>` : ''}
      ${w.note ? `<div class="note" style="text-align:left">${esc(w.note)}</div>` : ''}`;
    $view.innerHTML = `<div class="drill">${drillBar(Math.min(i, total - 1), total, back)}
      <div class="card flash" id="fc">${lvTag(w.key)}${flipped ? backSide : front}</div>
      ${flipped ? GRADE_BTNS : `<div class="btns fill"><button class="btn sub" id="flip">答えを見る</button></div>`}</div>`;
    if (!jaFirst && !flipped) speak(w.en);
    const flip = () => { if (flipped) return; flipped = true; show(); speak(w.en); };
    $view.querySelector('#fc').onclick = (e) => { if (!e.target.closest('[data-say]')) flip(); };
    const fb = $view.querySelector('#flip'); if (fb) fb.onclick = flip;
    if (flipped) $view.querySelector('.grade').onclick = (e) => {
      const b = e.target.closest('[data-g]'); if (!b) return;
      const g = +b.dataset.g;
      grade(w.key, g);
      if (g === 2 && !again.has(w.key)) good++;
      if (g === 0 && !again.has(w.key)) { again.add(w.key); deck.push(w); }   // 1 回だけ最後にもう一度出す
      i++; flipped = false; show();
    };
  };
  show();
}

// 話す: 日本語を見て英語を言う → 聞き取り（対応していれば）→ 答え合わせ → 自己採点
let rec = null;
function stopListening() { try { rec && rec.abort(); } catch { /* 止まっている */ } rec = null; }
function speakDrill(items, onEnd, back) {
  let i = 0, good = 0;
  const show = (heard) => {
    if (i >= items.length) { resultView(`${good} / ${items.length}`, '言えた文の数。言えなかった文は復習に回した', onEnd(), back); return; }
    const w = items[i];
    const revealed = heard !== undefined;
    const cmp = heard ? compare(w.en, heard) : null;
    $view.innerHTML = `<div class="drill">${drillBar(i, items.length, back)}
      <div class="card flash" style="cursor:default">
        <div class="hint">英語で言うと？</div>
        <div class="mid">${esc(w.ja)}</div>
        ${w.note && !revealed ? `<div class="hint">ヒント: ${esc(w.note)}</div>` : ''}
        ${revealed ? `<div class="en" style="font-size:20px">${esc(w.en)} ${sayBtn(w.en, true)}</div>
          ${cmp ? `<div class="heard">${cmp.html}</div><div class="hint">聞き取れた: “${esc(heard)}” ・ 一致 ${Math.round(cmp.rate * 100)}%</div>` : heard === null ? '<div class="hint">聞き取れなかった。答えを見て自分で採点しよう</div>' : ''}` : ''}
      </div>
      ${revealed ? GRADE_BTNS.replace('まだ<small>今日もう一度</small>', '言えなかった<small>復習へ</small>').replace('あやしい<small>明日</small>', 'おしい<small>明日</small>').replace('わかる<small>間をあける</small>', '言えた<small>間をあける</small>')
        : `<div class="btns fill">${SR ? '<button class="mic" id="mic" aria-label="話す">🎤</button>' : ''}<button class="btn sub" id="show">答えを見る</button></div>
           ${SR ? '<div class="hint" id="mhint" style="text-align:center">🎤 を押して英語で話す</div>' : ''}`}
    </div>`;
    if (!revealed) {
      $view.querySelector('#show').onclick = () => { stopListening(); show(''); speak(w.en); };
      const mic = $view.querySelector('#mic');
      if (mic) mic.onclick = () => {
        if (rec) { stopListening(); mic.classList.remove('rec'); return; }
        if (window.speechSynthesis) speechSynthesis.cancel();
        mic.classList.add('rec'); $view.querySelector('#mhint').textContent = '聞いています… 話し終えたら少し待つ';
        try {
          rec = listen((t) => { rec = null; show(t); if (t) speak(w.en); });
        } catch { rec = null; show(null); }
      };
    } else {
      $view.querySelector('.grade').onclick = (e) => {
        const b = e.target.closest('[data-g]'); if (!b) return;
        const g = +b.dataset.g; grade(w.key, g); if (g === 2) good++;
        i++; show();
      };
    }
  };
  show();
}

// ============================================================
// 復習
// ============================================================
function review() {
  setHead('復習', '間隔をあけて思い出す'); setTab('review');
  const due = dueKeys();
  const keys = Object.keys(st.srs).filter((k) => ITEMS[k]);
  const counts = [...Array(8).keys()].map((b) => keys.filter((k) => st.srs[k].b === b).length);
  const max = Math.max(1, ...counts);
  const t = today();
  const soon = [1, 2, 3, 7].map((d) => [d, keys.filter((k) => st.srs[k].d > t && st.srs[k].d <= t + d).length]);
  const weak = keys.filter((k) => st.srs[k].b === 0).map((k) => ITEMS[k]);
  $view.innerHTML = `<div class="grid g-main">
    <div class="card">
      <h2>今日の復習 ${due.length} 個</h2>
      <div class="muted">カード・テスト・話す練習で学んだ語句を、覚え具合に合わせて 1・2・4・7・15・30・60 日あとに出す。「わかる」で間隔が延び、「まだ」で最初からやり直し。</div>
      <div class="btns"><a class="btn ${due.length ? '' : 'sub'}" href="#/review/go" ${due.length ? '' : 'aria-disabled="true"'}>${due.length ? `復習する（${Math.min(due.length, 40)}）` : '今日の分はおわり'}</a></div>
      <div class="muted">これから: ${soon.map(([d, n]) => `${d} 日以内 ${n}`).join(' ・ ')}</div>
    </div>
    <div class="card">
      <h2>覚え具合の分布 <span class="muted">（全 ${keys.length}）</span></h2>
      <div class="boxes">${counts.map((c, b) => `<div><span>${c}</span><i style="height:${c / max * 70}%;background:${b === 0 ? 'var(--bad)' : b < 3 ? 'var(--warn)' : 'var(--good)'}"></i><span>${b === 0 ? '0' : INTERVAL[b] + '日'}</span></div>`).join('')}</div>
      <div class="muted" style="margin-top:6px">下は次に出すまでの間隔。右にいくほど定着している。</div>
    </div></div>
    ${weak.length ? `<div class="sec-title">いま苦手な語句 <small>${weak.length}</small></div><div class="card">${lines(weak.slice(0, 60))}</div>` : ''}`;
  if (!due.length) $view.querySelector('.btns .btn').onclick = (e) => e.preventDefault();
}
function reviewGo() {
  setHead('復習', '今日の分', '#/review'); setTab('review');
  const due = dueKeys().sort((a, b) => st.srs[a].b - st.srs[b].b).slice(0, 40).map((k) => ITEMS[k]);
  if (!due.length) { location.hash = '#/review'; return; }
  cardDrill(shuffle(due), () => (dueKeys().length ? `<a class="btn" href="#/review/go">続けて復習</a>` : ''), '#/review');
}

// ============================================================
// ライブラリ: 全部の文法・単語・フレーズを探す
// ============================================================
function grammarAlone(id, quiz) {
  const u = UNITS[unitOfG[id] - 1];
  if (quiz) {
    setHead(`${G[id].title} の確認`, 'ライブラリ ・ 文法', `#/g/${id}`); setTab('library');
    choiceDrill(grammarQuestions(id), (ok, n) => { const best = st.gScore[id]; if (!best || ok >= best[0]) st.gScore[id] = [ok, n]; keep(); return ''; }, `#/g/${id}`);
    return;
  }
  setHead(G[id].title, `ライブラリ ・ 文法 ・ ユニット ${u.n}`, '#/library/grammar'); setTab('library');
  $view.innerHTML = grammarBody(id, `#/g/${id}/quiz`, u.color) + `<div class="btns"><a class="btn sub" href="#/u/${u.n}">ユニット ${u.n}「${esc(u.title)}」へ</a></div>`;
}
function library(tab) {
  setHead('ライブラリ', 'すべての文法・単語・フレーズ'); setTab('library');
  const TABS = [['grammar', '文法'], ['words', '単語'], ['phrases', '会話フレーズ'], ['idioms', '熟語'], ['phrasal', '句動詞']];
  const q = load('libQ', '');
  $view.innerHTML = `<div class="seg">${TABS.map(([id, name]) => `<button class="${id === tab ? 'on' : ''}" data-t="${id}">${name}</button>`).join('')}</div>
    <input class="search" id="q" type="search" placeholder="英語か日本語で探す" value="${esc(q)}" autocomplete="off">
    <div id="lib"></div>`;
  $view.querySelector('.seg').onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) location.hash = '#/library/' + b.dataset.t; };
  const input = $view.querySelector('#q');
  const draw = () => {
    const s = input.value.trim().toLowerCase();
    save('libQ', input.value);
    const hit = (it) => !s || it.en.toLowerCase().includes(s) || (it.ja || '').includes(s);
    const out = $view.querySelector('#lib');
    if (tab === 'grammar') {
      out.innerHTML = PHASES.map((p, pi) => {
        const gs = UNITS.filter((u) => u.phase === pi).flatMap((u) => u.g).filter((id) => { const g = G[id]; return !s || (g.title + g.headword + g.core).toLowerCase().includes(s); });
        return gs.length ? `<div class="sec-title" style="color:${p.color}">${esc(p.name)}</div><div class="grid g2">${gs.map((id) => { const g = G[id]; const sc = st.gScore[id];
          return `<a class="row" href="#/g/${id}" style="--pc:${p.color}"><div class="glyph">${esc(g.glyph || g.headword)}</div><div class="row__main"><div class="row__title">${esc(g.title)}</div><div class="row__sub">${esc(g.headword)} ── ${esc(g.core)}</div></div>${sc ? `<span class="tag ${sc[0] === sc[1] ? 'good' : ''}">${sc[0]}/${sc[1]}</span>` : ''}</a>`; }).join('')}</div>` : '';
      }).join('') || '<div class="muted">見つからない</div>';
    } else if (tab === 'words') {
      const ws = WORDS.filter(hit);
      out.innerHTML = `<div class="muted" style="margin-bottom:8px">${ws.length} 語</div><div class="tiles">${ws.slice(0, 200).map(tile).join('')}</div>${ws.length > 200 ? '<div class="muted" style="margin-top:8px">ほかは検索でしぼる</div>' : ''}`;
    } else if (tab === 'phrases') {
      out.innerHTML = Object.values(SCENE).map((sc) => { const its = sc.items.filter(hit); return its.length ? `<div class="sec-title">${esc(sc.title)}</div><div class="card">${lines(its)}</div>` : ''; }).join('') || '<div class="muted">見つからない</div>';
    } else if (tab === 'idioms') {
      const its = IDIOM_ITEMS.filter(hit);
      out.innerHTML = its.length ? `<div class="card">${lines(its)}</div>` : '<div class="muted">見つからない</div>';
    } else {
      out.innerHTML = Object.keys(PV).map((v) => { const its = PV[v].filter(hit); return its.length ? `<div class="sec-title">${esc(v)} 〜</div><div class="card">${lines(its)}</div>` : ''; }).join('') || '<div class="muted">見つからない</div>';
    }
  };
  input.oninput = draw;
  draw();
}

// PC ではキーボードでも進められる: Space / Enter でめくる・次へ、1〜4 で選ぶ・採点、R で読み上げ
addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const q = (sel) => $view.querySelector(sel);
  const click = (el) => { if (el) { e.preventDefault(); el.click(); } };
  if (e.key === ' ' || e.key === 'Enter') return click(q('#nx') || q('#flip') || q('#show'));
  if (/^[1-4]$/.test(e.key)) {
    const k = +e.key - 1;
    if (q('.grade')) return click(q(`.grade [data-g="${k}"]`));
    if (q('.choices') && !q('.choices').dataset.done) return click(q(`.choices [data-k="${k}"]`));
  }
  if (e.key === 'r' || e.key === 'R') click(q('.drill [data-say]'));
});

route();
