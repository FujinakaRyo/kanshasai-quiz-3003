// オールスター感謝祭風 クイズアプリ（リアルタイム同期 / ホスト進行型）
// Node.js 標準モジュールのみ。npm install 不要。
//   起動:  node server.js
//   管理者: http://localhost:3000/admin
//   参加者: http://<このPCのIP>:3000/     (同じWiFiのスマホから)

const http = require('http');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const nodePath = require('path');

const PORT = Number(process.env.PORT) || 3003;
const SECRET_TOKEN = process.env.SECRET_TOKEN || '';
const UPLOADS_DIR = nodePath.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const DATA_FILE = nodePath.join(__dirname, 'kanshasai-quiz-3003.json');
const TEMPLATE_PPTX = 'C:\\Users\\r-fujinaka\\Documents\\本部レククイズ案\\コンサル本部感謝祭_部対抗クイズ_template.pptx';
const PPTX_GEN_JS = nodePath.join(__dirname, 'pptx-gen.js');
const TEMPLATE_MEDIA_DIR = nodePath.join(__dirname, 'uploads');
function saveQuestions() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify({ questions: state.questions, periods: state.periods }, null, 2)); } catch (e) { console.error('問題保存失敗:', e.message); }
}

// ---------------------------------------------------------------------------
// 状態（すべてメモリ上。サーバーを止めると消えます）
// ---------------------------------------------------------------------------
const state = {
  phase: 'lobby',        // lobby | question | reveal | ranking | finished | award
  questions: [],         // { id, text, choices:[], correctIndex, timeLimit }
  periods: [],           // { id, name, questionIds: string[] }
  activePeriodId: null,  // currently running period id
  players: {},           // id -> { id, name, score }
  answers: {},           // qid -> { playerId -> { choice, at, correct, points } }
  currentIndex: -1,
  startedAt: 0,
  scored: {},            // qid -> true（二重採点防止）
  emergencyMode: false,  // true → 全プレイヤーを簡易版(/emergency)へリダイレクト
  pubUrl: '',            // 管理者が設定した公開URL（present画面のQR用）
  awardStep: -1,         // 表彰式ステップ
  deptAdjustments: {},   // 部署名 → 調整点数
};

try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (Array.isArray(saved)) {
    state.questions = saved;
    state.periods = [];
  } else {
    state.questions = saved.questions || [];
    state.periods = saved.periods || [];
  }
} catch (e) {}

// ---------------------------------------------------------------------------
// 進行状態の保存/復元（サーバーが落ちても再起動で続きから再開できるように）
//   参加者・得点・回答・フェーズを STATE_FILE に1秒ごと（変更時のみ）書き出す。
//   まっさらに始めたいときは STATE_FILE を消すか、FRESH=1 node server.js で起動。
// ---------------------------------------------------------------------------
const STATE_FILE = nodePath.join(__dirname, 'kanshasai-quiz-3003.state.json');
const PERSIST_KEYS = ['phase', 'activePeriodId', 'players', 'answers', 'currentIndex', 'startedAt', 'scored', 'emergencyMode', 'pubUrl', 'awardStep', 'deptAdjustments'];
let stateDirty = false;
function markStateDirty() { stateDirty = true; }
function saveState() {
  if (!stateDirty) return;
  stateDirty = false;
  const snapshot = {};
  PERSIST_KEYS.forEach((k) => { snapshot[k] = state[k]; });
  try {
    // 書き込み途中で落ちても壊れないよう、一時ファイルに書いてから置き換える
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(snapshot));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (e) { console.error('進行状態の保存失敗:', e.message); }
}
let restoredPlayers = 0;
if (process.env.FRESH !== '1') {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    PERSIST_KEYS.forEach((k) => { if (saved[k] !== undefined) state[k] = saved[k]; });
    restoredPlayers = Object.keys(state.players).length;
  } catch (e) {}
}
setInterval(saveState, 1000);
process.on('SIGINT', () => { saveState(); process.exit(0); });
process.on('SIGTERM', () => { saveState(); process.exit(0); });
// 想定外の例外1つでイベント中にサーバーごと落ちないようにする（ログだけ残して継続）
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e && e.stack || e); });
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e && e.stack || e); });

const clients = [];      // { res, role:'admin'|'player', id }
const playerConns = new Map(); // playerId -> Set<client>（接続人数と個別送信をO(1)にする）

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------
function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}
const LAN_IP = getLanIp();
const JOIN_URL = 'http://' + LAN_IP + ':' + PORT + '/';

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 8e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); }
      catch (e) { resolve({}); }
    });
  });
}
function sendJson(res, obj, code) {
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
// 接続中の参加者ID（.size / .has だけ使う）
function connectedIds() { return playerConns; }

// 一斉配信の最中だけ有効な共有計算キャッシュ。
// 参加者N人に配るとき、集計/ランキングを1人ごとに作り直すと O(N^2) になるため、配信1回につき1回だけ計算する。
// 配信ループは同期処理なので、その間に state が変わることはない。
let snap = null;
function memo(key, fn) {
  if (!snap) return fn();
  if (!(key in snap)) snap[key] = fn();
  return snap[key];
}
function withSnapshot(fn) {
  snap = {};
  try { fn(); } finally { snap = null; }
}
function currentQuestion() {
  if (state.currentIndex < 0 || !state.activePeriodId) return null;
  const period = state.periods.find(p => p.id === state.activePeriodId);
  if (!period) return null;
  const qid = period.questionIds[state.currentIndex];
  return state.questions.find(q => q.id === qid) || null;
}
function remainingMs() {
  const q = currentQuestion();
  if (!q || state.phase !== 'question') return 0;
  return Math.max(0, q.timeLimit * 1000 - (Date.now() - state.startedAt));
}
function choiceCounts() { return memo('counts', computeChoiceCounts); }
function computeChoiceCounts() {
  const q = currentQuestion();
  if (!q) return [];
  if (q.type === 'rentan') return [];
  const counts = q.choices.map(() => 0);
  const ans = state.answers[q.id] || {};
  Object.keys(ans).forEach((pid) => {
    const c = ans[pid].choice;
    if (c >= 0 && c < counts.length) counts[c]++;
  });
  return counts;
}
function rankingList() { return memo('ranking', computeRankingList); }
function rankById() {
  return memo('rankById', () => new Map(rankingList().map((r) => [r.id, r.rank])));
}
function computeRankingList() {
  return Object.values(state.players)
    .sort((a, b) => b.score - a.score || (a.totalAnswerMs || 0) - (b.totalAnswerMs || 0))
    .map((p, i) => ({ rank: i + 1, name: p.name, dept: p.dept || '', score: p.score, id: p.id, totalAnswerMs: p.totalAnswerMs || 0 }));
}
function deptRankingList() { return memo('deptRanking', computeDeptRankingList); }
function computeDeptRankingList() {
  const deptMap = {};
  Object.values(state.players).forEach((p) => {
    const dept = p.dept || '未設定';
    if (!deptMap[dept]) deptMap[dept] = { dept, total: 0, count: 0 };
    deptMap[dept].total += p.score;
    deptMap[dept].count += 1;
  });
  return Object.values(deptMap)
    .map((d) => {
      const adjustment = state.deptAdjustments[d.dept] || 0;
      const adjustedTotal = d.total + adjustment;
      return { dept: d.dept, avg: Math.round(adjustedTotal / d.count), total: adjustedTotal, count: d.count, adjustment };
    })
    .sort((a, b) => b.avg - a.avg)
    .map((d, i) => ({ rank: i + 1, dept: d.dept, avg: d.avg, total: d.total, count: d.count, adjustment: d.adjustment }));
}

// ---------------------------------------------------------------------------
// ビュー生成（役割ごとに見せる情報を変える）
// ---------------------------------------------------------------------------
function adminView() {
  const q = currentQuestion();
  const connected = connectedIds();
  const activePeriod = state.activePeriodId ? state.periods.find(p => p.id === state.activePeriodId) : null;
  const periodTotal = activePeriod ? activePeriod.questionIds.length : 0;
  // 出題中/発表中はロースター一覧を描画しないので players を省いてホットパスのペイロードを軽くする。
  // ロースターを見せる lobby/ranking/finished/award だけ含め、それも先頭80件に制限する。
  const showRoster = state.phase === 'lobby' || state.phase === 'ranking' || state.phase === 'finished' || state.phase === 'award';
  const players = showRoster
    ? Object.values(state.players).map((p) => ({
        name: p.name, dept: p.dept || '', score: p.score, connected: connected.has(p.id),
      })).sort((a, b) => b.score - a.score).slice(0, 80)
    : undefined;
  return {
    role: 'admin',
    phase: state.phase,
    joinUrl: JOIN_URL,
    pubUrl: state.pubUrl || '',
    joinCount: connected.size,
    total: periodTotal,
    currentIndex: state.currentIndex,
    periods: state.periods,
    activePeriodId: state.activePeriodId,
    questions: state.questions.map((qq) => ({
      id: qq.id, text: qq.text, img: qq.img || null, intro: qq.intro || null, choices: qq.choices, type: qq.type || 'single',
      correctIndex: qq.correctIndex, correctOrder: qq.correctOrder, rankCount: qq.rankCount,
      timeLimit: qq.timeLimit, points: qq.points || 100, reference: qq.reference || null,
    })),
    players: players,
    current: q ? {
      index: state.currentIndex, total: periodTotal,
      text: q.text, img: q.img || null, choices: q.choices, type: q.type || 'single',
      correctIndex: q.correctIndex, correctOrder: q.correctOrder, rankCount: q.rankCount,
      timeLimit: q.timeLimit, remainingMs: remainingMs(),
      counts: choiceCounts(), answeredCount: Object.keys(state.answers[q.id] || {}).length, reference: q.reference || null,
    } : null,
    ranking: rankingList(),
    deptRanking: deptRankingList(),
    emergencyMode: state.emergencyMode,
    awardStep: state.awardStep || -1,
  };
}

function playerView(pid) {
  const q = currentQuestion();
  const me = state.players[pid] || { name: '', dept: '', score: 0 };
  const activePeriod = state.activePeriodId ? state.periods.find(p => p.id === state.activePeriodId) : null;
  const periodTotal = activePeriod ? activePeriod.questionIds.length : 0;
  const view = {
    role: 'player',
    phase: state.phase,
    joinCount: connectedIds().size,
    total: periodTotal,
    me: { name: me.name, dept: me.dept || '', score: me.score },
    periodName: activePeriod ? activePeriod.name : null,
  };
  if (q && (state.phase === 'question' || state.phase === 'reveal' || state.phase === 'stats')) {
    const ans = (state.answers[q.id] || {})[pid] || null;
    const isRentan = q.type === 'rentan';
    view.q = {
      index: state.currentIndex, total: periodTotal,
      text: q.text, img: q.img || null, choices: q.choices, timeLimit: q.timeLimit,
      remainingMs: remainingMs(), type: q.type || 'single', rankCount: q.rankCount,
    };
    view.myAnswer = ans ? (isRentan ? ans.choices : ans.choice) : null;
    if (state.phase === 'reveal' || state.phase === 'stats') {
      view.reveal = {
        correctIndex: q.correctIndex, correctOrder: q.correctOrder,
        counts: choiceCounts(),
        myCorrect: ans ? ans.correct : false,
        myPoints: ans ? (ans.points || 0) : 0,
        myMatchCount: ans ? (ans.matchCount || 0) : 0,
        myAnswerMs: ans ? Math.max(0, (ans.at || 0) - state.startedAt) : null,
      };
    }
  }
  if (state.phase === 'ranking' || state.phase === 'finished') {
    view.ranking = memo('ranking50', () => rankingList().slice(0, 50));
    view.myRank = rankById().get(pid) || null;
    view.deptRanking = deptRankingList();
  }
  view.emergencyMode = state.emergencyMode;
  return view;
}

function viewFor(client) {
  if (client.role === 'admin' || client.role === 'present') return adminView();
  return playerView(client.id);
}

// ---------------------------------------------------------------------------
// 配信
// ---------------------------------------------------------------------------
function addClient(client) {
  clients.push(client);
  if (client.role === 'player' && client.id) {
    if (!playerConns.has(client.id)) playerConns.set(client.id, new Set());
    playerConns.get(client.id).add(client);
  }
}
function removeClient(client) {
  const i = clients.indexOf(client);
  if (i >= 0) clients.splice(i, 1);
  const set = client.role === 'player' && playerConns.get(client.id);
  if (set) { set.delete(client); if (set.size === 0) playerConns.delete(client.id); }
}
function push(client) {
  try {
    // 管理/投影画面は全員同じ内容なので、配信1回につき1回だけシリアライズする
    const json = (client.role === 'admin' || client.role === 'present')
      ? memo('adminJson', () => JSON.stringify(adminView()))
      : JSON.stringify(playerView(client.id));
    client.res.write('data: ' + json + '\n\n');
  } catch (e) {
    // 書き込みに失敗＝死んだ接続。clientsから除去してリークを防ぐ。
    client.dead = true;
    removeClient(client);
  }
}
function broadcastAll() { markStateDirty(); withSnapshot(() => clients.slice().forEach(push)); }
function broadcastAdmins() { withSnapshot(() => clients.slice().forEach((c) => { if (c.role === 'admin' || c.role === 'present') push(c); })); }
function sendToPlayer(id) { const set = playerConns.get(id); if (set) Array.from(set).forEach(push); }

// 管理者向け更新は回答バーストで殺到するので、dirtyフラグで最大 ~300ms に1回へ集約する。
let adminDirty = false;
function markAdminDirty() { adminDirty = true; markStateDirty(); }
function startAdminFlusher() {
  setInterval(() => {
    if (!adminDirty) return;
    adminDirty = false;
    broadcastAdmins();
  }, 300);
}

// ---------------------------------------------------------------------------
// SSE 接続
// ---------------------------------------------------------------------------
function handleSSE(req, res, u) {
  const rp = u.searchParams.get('role');
  const role = rp === 'admin' ? 'admin' : rp === 'present' ? 'present' : 'player';
  const id = u.searchParams.get('id') || '';
  const name = (u.searchParams.get('name') || '').slice(0, 24);
  const dept = (u.searchParams.get('dept') || '').slice(0, 20);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // 中間プロキシ/トンネルでのバッファリングを抑止
  });
  res.write(': connected\n\n');

  if (role === 'player' && id) {
    if (!state.players[id]) state.players[id] = { id, name: name || 'ゲスト', dept: dept || '', score: 0, totalAnswerMs: 0 };
    else { if (name) state.players[id].name = name; if (dept) state.players[id].dept = dept; }
  }

  const client = { res, role, id };
  addClient(client);
  push(client);
  if (role === 'player') markAdminDirty();

  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 15000);

  req.on('close', () => {
    clearInterval(hb);
    removeClient(client);
    if (role === 'player') markAdminDirty();
  });
}

// ---------------------------------------------------------------------------
// ゲーム操作
// ---------------------------------------------------------------------------
function scoreCurrent() {
  const q = currentQuestion();
  if (!q || state.scored[q.id]) return;
  state.scored[q.id] = true;
  const ans = state.answers[q.id] || {};
  if (q.type === 'rentan') {
    const correct = q.correctOrder || [];
    const k = q.rankCount || correct.length;
    Object.keys(ans).forEach((pid) => {
      const a = ans[pid];
      const pc = a.choices || [];
      let match = 0;
      for (let i = 0; i < Math.min(k, correct.length, pc.length); i++) {
        if (pc[i] === correct[i]) match++; else break;
      }
      a.matchCount = match;
      a.correct = match === k;
      const base = q.points || 100;
      a.points = match === 0 ? 0 : Math.round(base * match / k);
      if (state.players[pid]) {
        state.players[pid].score += a.points;
        if (a.at) state.players[pid].totalAnswerMs = (state.players[pid].totalAnswerMs || 0) + Math.max(0, a.at - (state.startedAt || a.at));
      }
    });
  } else {
    Object.keys(ans).forEach((pid) => {
      const a = ans[pid];
      if (a.choice === q.correctIndex) {
        a.points = q.points || 100;
        a.correct = true;
      } else {
        a.points = 0;
        a.correct = false;
      }
      if (state.players[pid]) {
        state.players[pid].score += a.points;
        if (a.at) state.players[pid].totalAnswerMs = (state.players[pid].totalAnswerMs || 0) + Math.max(0, a.at - (state.startedAt || a.at));
      }
    });
  }
}

function handlePost(path, body, res) {
  switch (path) {
    case '/api/answer': {
      const q = currentQuestion();
      const pid = body.id;
      if (state.phase !== 'question' || !q || !state.players[pid]) return sendJson(res, { ok: false });
      if (Date.now() - state.startedAt > q.timeLimit * 1000 + 500) return sendJson(res, { ok: false, late: true });
      if (!state.answers[q.id]) state.answers[q.id] = {};
      if (state.answers[q.id][pid]) return sendJson(res, { ok: false, already: true });
      if (q.type === 'rentan') {
        const choices = Array.isArray(body.choices) ? body.choices.map(Number) : [];
        const k = q.rankCount || (q.correctOrder || []).length;
        if (choices.length !== k || choices.some((c) => !(c >= 0 && c < q.choices.length))) return sendJson(res, { ok: false });
        state.answers[q.id][pid] = { choices, at: Date.now() };
      } else {
        const choice = Number(body.choice);
        if (!(choice >= 0 && choice < q.choices.length)) return sendJson(res, { ok: false });
        state.answers[q.id][pid] = { choice, at: Date.now() };
      }
      sendJson(res, { ok: true });
      sendToPlayer(pid);
      markAdminDirty();
      return;
    }
    case '/api/admin/addQuestion': {
      const choices = (body.choices || []).map((c) => {
        if (typeof c === 'object') return { text: String(c.text || '').trim(), img: c.img || null };
        return { text: String(c || '').trim(), img: null };
      }).filter((c) => c.text.length > 0 || c.img);
      const text = String(body.text || '').trim();
      const timeLimit = Math.min(120, Math.max(5, Number(body.timeLimit) || 20));
      const points = Math.max(1, Math.min(99999, Number(body.points) || 100));
      const qtype = body.type === 'rentan' ? 'rentan' : 'single';
      if (!text || choices.length < 2) {
        return sendJson(res, { ok: false, error: '問題文・選択肢2つ以上が必要です' });
      }
      let qdata;
      if (qtype === 'rentan') {
        const correctOrder = (body.correctOrder || []).map(Number);
        const rankCount = Math.min(choices.length, Math.max(1, Number(body.rankCount) || correctOrder.length));
        if (correctOrder.length !== rankCount || correctOrder.some((c) => !(c >= 0 && c < choices.length))) {
          return sendJson(res, { ok: false, error: '連単の正解順序が不正です' });
        }
        qdata = { id: crypto.randomUUID(), text, img: body.img || null, intro: String(body.intro || '').trim() || null, choices, type: 'rentan', correctOrder, rankCount, timeLimit, points, reference: String(body.reference || '').trim() || null };
      } else {
        const correctIndex = Number(body.correctIndex);
        if (!(correctIndex >= 0 && correctIndex < choices.length)) {
          return sendJson(res, { ok: false, error: '正解の指定が必要です' });
        }
        qdata = { id: crypto.randomUUID(), text, img: body.img || null, intro: String(body.intro || '').trim() || null, choices, type: 'single', correctIndex, timeLimit, points, reference: String(body.reference || '').trim() || null };
      }
      state.questions.push(qdata);
      saveQuestions();
      sendJson(res, { ok: true });
      markAdminDirty();
      return;
    }
    case '/api/admin/deleteQuestion': {
      if (state.phase !== 'lobby' && state.phase !== 'finished') return sendJson(res, { ok: false, error: 'ゲーム中は削除できません' });
      state.questions = state.questions.filter((q) => q.id !== body.id);
      saveQuestions();
      sendJson(res, { ok: true });
      markAdminDirty();
      return;
    }
    case '/api/admin/addPeriod': {
      const id = 'per_' + Date.now().toString(36);
      const name = String(body.name || 'Period').trim() || 'Period';
      const topic0 = String(body.topic || '').trim();
      state.periods.push({ id, name, topic: topic0, questionIds: [] });
      saveQuestions();
      sendJson(res, { ok: true });
      markAdminDirty();
      return;
    }
    case '/api/admin/deletePeriod': {
      const idx = state.periods.findIndex(p => p.id === body.id);
      if (idx >= 0) { state.periods.splice(idx, 1); saveQuestions(); }
      sendJson(res, { ok: true });
      markAdminDirty();
      return;
    }
    case '/api/admin/updatePeriod': {
      const p = state.periods.find(p => p.id === body.id);
      if (!p) return sendJson(res, { ok: false, error: 'Not found' });
      if (body.name) p.name = String(body.name).trim();
      if (body.topic !== undefined) p.topic = String(body.topic || '').trim();
      if (Array.isArray(body.questionIds)) {
        p.questionIds = body.questionIds.filter(qid => state.questions.find(q => q.id === qid));
      }
      saveQuestions();
      sendJson(res, { ok: true });
      markAdminDirty();
      return;
    }
    case '/api/admin/startPeriod': {
      const period = state.periods.find(p => p.id === body.periodId);
      if (!period) return sendJson(res, { ok: false, error: 'Period not found' });
      const validQids = period.questionIds.filter(qid => state.questions.find(q => q.id === qid));
      if (validQids.length === 0) return sendJson(res, { ok: false, error: '問題を選択してください' });
      period.questionIds = validQids;
      state.activePeriodId = period.id;
      state.currentIndex = 0;
      state.phase = 'question';
      state.startedAt = Date.now();
      state.answers = {};
      state.scored = {};
      sendJson(res, { ok: true });
      broadcastAll();
      return;
    }
    case '/api/admin/finish': {
      state.phase = 'finished';
      sendJson(res, { ok: true });
      broadcastAll();
      return;
    }
    case '/api/admin/reveal': {
      if (state.phase !== 'question') return sendJson(res, { ok: false });
      state.phase = 'stats';   // まず解答率フェーズへ
      sendJson(res, { ok: true });
      broadcastAll();
      return;
    }
    case '/api/admin/stats': {
      if (state.phase !== 'stats') return sendJson(res, { ok: false });
      scoreCurrent();
      state.phase = 'reveal';  // 正解発表フェーズへ（スコア加算と同時）
      sendJson(res, { ok: true });
      broadcastAll();
      return;
    }
    case '/api/admin/ranking': {
      state.phase = 'ranking';
      sendJson(res, { ok: true });
      broadcastAll();
      return;
    }
    case '/api/admin/award': {
      state.phase = 'award';
      state.awardStep = 0;
      sendJson(res, { ok: true });
      broadcastAll();
      return;
    }
    case '/api/admin/nextAward': {
      if (state.phase !== 'award') return sendJson(res, { ok: false });
      state.awardStep = (state.awardStep || 0) + 1;
      sendJson(res, { ok: true });
      broadcastAll();
      return;
    }
    case '/api/admin/next': {
      const ap = state.periods.find(p => p.id === state.activePeriodId);
      if (ap && state.currentIndex + 1 < ap.questionIds.length) {
        state.currentIndex += 1;
        state.phase = 'question';
        state.startedAt = Date.now();
      } else {
        state.phase = 'ranking';
        state.activePeriodId = null;
      }
      sendJson(res, { ok: true });
      broadcastAll();
      return;
    }
    case '/api/admin/updateQuestionAnswer': {
      const q = currentQuestion();
      if (!q || state.phase !== 'question') return sendJson(res, { ok: false, error: '出題中のみ変更可能です' });
      if (q.type === 'rentan') {
        const newOrder = (body.correctOrder || []).map(Number);
        if (newOrder.length !== (q.rankCount || newOrder.length) || newOrder.some((c) => !(c >= 0 && c < q.choices.length))) {
          return sendJson(res, { ok: false, error: '連単の正解順序が不正です' });
        }
        q.correctOrder = newOrder;
        delete q.correctIndex;
      } else {
        const newIndex = Number(body.correctIndex);
        if (!(newIndex >= 0 && newIndex < q.choices.length)) {
          return sendJson(res, { ok: false, error: '正解インデックスが不正です' });
        }
        q.correctIndex = newIndex;
      }
      saveQuestions();
      sendJson(res, { ok: true });
      broadcastAdmins();
      return;
    }
    case '/api/admin/adjustDeptScore': {
      if (state.phase !== 'ranking') return sendJson(res, { ok: false, error: 'ランキング表示中のみ設定可能です' });
      const adjustments = body.adjustments || {};
      state.deptAdjustments = adjustments;
      markStateDirty();
      sendJson(res, { ok: true });
      broadcastAll();
      return;
    }
    case '/api/admin/emergency': {
      state.emergencyMode = !state.emergencyMode;
      sendJson(res, { ok: true, emergencyMode: state.emergencyMode });
      broadcastAll();
      return;
    }
    case '/api/admin/setpub': {
      state.pubUrl = (body.pubUrl || '').trim();
      sendJson(res, { ok: true });
      broadcastAdmins();
      return;
    }
    case '/api/admin/reset': {
      state.phase = 'lobby';
      state.currentIndex = -1;
      state.activePeriodId = null;
      state.answers = {};
      state.scored = {};
      state.deptAdjustments = {};
      state.awardStep = -1;
      Object.values(state.players).forEach((p) => { p.score = 0; });
      sendJson(res, { ok: true });
      broadcastAll();
      return;
    }
    case '/api/admin/editQuestion': {
      if (state.phase !== 'lobby' && state.phase !== 'finished') return sendJson(res, { ok: false, error: 'ゲーム中は編集できません' });
      const eq = state.questions.find((q) => q.id === body.id);
      if (!eq) return sendJson(res, { ok: false, error: '問題が見つかりません' });
      const eChoices = (body.choices || []).map((c) => {
        if (typeof c === 'object') return { text: String(c.text || '').trim(), img: c.img || null };
        return { text: String(c || '').trim(), img: null };
      }).filter((c) => c.text.length > 0 || c.img);
      const eText = String(body.text || '').trim();
      const eTime = Math.min(120, Math.max(5, Number(body.timeLimit) || 20));
      const ePts = Math.max(1, Math.min(99999, Number(body.points) || 100));
      const eType = body.type === 'rentan' ? 'rentan' : 'single';
      if (!eText || eChoices.length < 2) {
        return sendJson(res, { ok: false, error: '問題文・選択肢2つ以上が必要です' });
      }
      eq.text = eText; eq.img = body.img !== undefined ? (body.img || null) : (eq.img || null); eq.intro = body.intro !== undefined ? (String(body.intro || '').trim() || null) : (eq.intro || null); eq.reference = body.reference !== undefined ? (String(body.reference || '').trim() || null) : (eq.reference || null); eq.choices = eChoices; eq.type = eType; eq.timeLimit = eTime; eq.points = ePts;
      if (eType === 'rentan') {
        const eOrder = (body.correctOrder || []).map(Number);
        const eRankCount = Math.min(eChoices.length, Math.max(1, Number(body.rankCount) || eOrder.length));
        if (eOrder.length !== eRankCount || eOrder.some((c) => !(c >= 0 && c < eChoices.length))) {
          return sendJson(res, { ok: false, error: '連単の正解順序が不正です' });
        }
        eq.correctOrder = eOrder; eq.rankCount = eRankCount;
        delete eq.correctIndex;
      } else {
        const eCorrect = Number(body.correctIndex);
        if (!(eCorrect >= 0 && eCorrect < eChoices.length)) {
          return sendJson(res, { ok: false, error: '正解の指定が必要です' });
        }
        eq.correctIndex = eCorrect;
        delete eq.correctOrder; delete eq.rankCount;
      }
      saveQuestions();
      sendJson(res, { ok: true });
      markAdminDirty();
      return;
    }
    case '/api/upload': {
      const { dataUrl, name } = body;
      if (!dataUrl || !dataUrl.startsWith('data:image/')) return sendJson(res, { ok: false, error: '画像データが不正です' });
      const [hdr, b64] = dataUrl.split(',');
      const ext = ((hdr.match(/image\/(\w+)/) || [])[1] || 'jpg').replace('jpeg', 'jpg');
      const fname = crypto.randomUUID() + '.' + ext;
      const fpath = nodePath.join(UPLOADS_DIR, fname);
      try {
        fs.writeFileSync(fpath, Buffer.from(b64, 'base64'));
        return sendJson(res, { ok: true, url: '/uploads/' + fname });
      } catch (e) {
        return sendJson(res, { ok: false, error: 'ファイル保存に失敗しました' });
      }
    }
    default:
      return sendJson(res, { ok: false, error: 'unknown' }, 404);
  }
}

// ---------------------------------------------------------------------------
// ルーティング
// ---------------------------------------------------------------------------
function checkToken(u) {
  if (!SECRET_TOKEN) return true;  // トークン設定なし = チェックなし
  const token = u.searchParams.get('token');
  return token === SECRET_TOKEN;
}
function denyAccess(res) {
  res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Access Denied</title></head><body style="background:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh"><div style="text-align:center;background:white;padding:40px;border-radius:10px"><h1>🔒 Access Denied</h1><p>このページは保護されています。</p><p>URLが正しいか確認してください。</p></div></body></html>`);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const path = u.pathname;

  if (req.method === 'GET' && path === '/') { if (!checkToken(u)) return denyAccess(res); return sendHtml(res, PLAYER_HTML); }
  if (req.method === 'GET' && path === '/admin') { if (!checkToken(u)) return denyAccess(res); return sendHtml(res, ADMIN_HTML); }
  if (req.method === 'GET' && path === '/events') { if (!checkToken(u)) return denyAccess(res); return handleSSE(req, res, u); }
  if (req.method === 'GET' && path === '/api/info') return sendJson(res, { joinUrl: JOIN_URL, port: PORT });
  if (req.method === 'GET' && path.startsWith('/uploads/')) {
    const fname = nodePath.basename(path);
    const fpath = nodePath.join(UPLOADS_DIR, fname);
    try {
      const data = fs.readFileSync(fpath);
      const ext = fname.split('.').pop().toLowerCase();
      const mimes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
      res.writeHead(200, { 'Content-Type': mimes[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
      return res.end(data);
    } catch (e) { res.writeHead(404); return res.end('Not found'); }
  }
  if (req.method === 'GET' && path === '/pptx-gen.js') {
    try {
      const data = fs.readFileSync(PPTX_GEN_JS);
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' });
      return res.end(data);
    } catch (e) { res.writeHead(500); return res.end('pptx-gen.js not found'); }
  }
  if (req.method === 'GET' && path === '/api/admin/template-pptx') {
    try {
      const data = fs.readFileSync(TEMPLATE_PPTX);
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'Content-Length': data.length });
      return res.end(data);
    } catch (e) { res.writeHead(404); return res.end('Template not found: ' + TEMPLATE_PPTX); }
  }
  if (req.method === 'GET' && path === '/present') { if (!checkToken(u)) return denyAccess(res); return sendHtml(res, PRESENT_HTML); }
  if (req.method === 'GET' && path === '/emergency') { if (!checkToken(u)) return denyAccess(res); return sendHtml(res, EMERGENCY_HTML); }
  if (req.method === 'GET' && path === '/api/view') {
    if (!checkToken(u)) return sendJson(res, { error: 'Access Denied' }, 403);
    const id = u.searchParams.get('id');
    const name = u.searchParams.get('name');
    const dept = u.searchParams.get('dept');
    if (id) {
      if (!state.players[id]) state.players[id] = { id, name: name || 'ゲスト', dept: dept || '', score: 0, totalAnswerMs: 0 };
      else { if (name) state.players[id].name = name; if (dept) state.players[id].dept = dept; }
      markAdminDirty();
    }
    return sendJson(res, id ? playerView(id) : { phase: state.phase, emergencyMode: state.emergencyMode });
  }
  if (req.method === 'GET' && path.startsWith('/api/media/')) {
    const fname = nodePath.basename(path);
    if (!/\.(mp3|mp4)$/i.test(fname)) { res.writeHead(404); return res.end('Media not found'); }
    const fpath = [nodePath.join(__dirname, fname), nodePath.join(TEMPLATE_MEDIA_DIR, fname)].find(p => fs.existsSync(p)) || '';
    try {
      const stat = fs.statSync(fpath);
      const size = stat.size;
      const ext = fname.split('.').pop().toLowerCase();
      const mime = { mp3: 'audio/mpeg', mp4: 'video/mp4' }[ext] || 'application/octet-stream';
      const range = req.headers['range'];
      if (range) {
        const m = range.match(/bytes=(\d+)-(\d*)/);
        const start = m ? Number(m[1]) : 0;
        const end = (m && m[2]) ? Number(m[2]) : size - 1;
        res.writeHead(206, { 'Content-Range': 'bytes '+start+'-'+end+'/'+size, 'Accept-Ranges': 'bytes', 'Content-Length': end-start+1, 'Content-Type': mime });
        return fs.createReadStream(fpath, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Length': size });
      return fs.createReadStream(fpath).pipe(res);
    } catch (e) { res.writeHead(404); return res.end('Media not found'); }
  }
  if (req.method === 'GET' && path === '/api/admin/export') {
    const data = { questions: state.questions, periods: state.periods };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="kanshasai-quiz-export-' + Date.now() + '.json"' });
    res.end(JSON.stringify(data, null, 2));
    return;
  }
  if (req.method === 'GET' && path === '/api/admin/exportResults') {
    const ranking = rankingList();
    const deptRanking = deptRankingList();
    let csv = '【台本】\n問題,Period,問題文,正解,参考情報\n';
    state.questions.forEach((q, idx) => {
      const period = state.periods.find(p => p.questionIds.includes(q.id))?.name || '未設定';
      const correctAnswer = q.type === 'rentan'
        ? (q.correctOrder || []).map(ci => (ci + 1)).join('-')
        : ((q.correctIndex || 0) + 1);
      const line = [
        idx + 1,
        '"' + (period || '').replace(/"/g, '""') + '"',
        '"' + (q.text || '').replace(/"/g, '""') + '"',
        correctAnswer,
        '"' + (q.reference || '').replace(/"/g, '""') + '"'
      ].join(',');
      csv += line + '\n';
    });
    csv += '\n【個人結果】\nフルネーム,部署,得点,順位\n';
    ranking.forEach((p, i) => {
      const line = [
        '"' + (p.name || '').replace(/"/g, '""') + '"',
        '"' + (p.dept || '').replace(/"/g, '""') + '"',
        p.score,
        i + 1
      ].join(',');
      csv += line + '\n';
    });
    csv += '\n【部別結果】\n部署,参加人数,合計得点,平均得点,順位\n';
    deptRanking.forEach((d, i) => {
      const line = [
        '"' + (d.dept || '').replace(/"/g, '""') + '"',
        d.count,
        d.total,
        d.avg,
        i + 1
      ].join(',');
      csv += line + '\n';
    });
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="kanshasai-quiz-results-' + Date.now() + '.csv"' });
    res.end(csv);
    return;
  }
  if (req.method === 'POST') {
    const body = await readBody(req);
    markStateDirty();
    return handlePost(path, body, res);
  }
  res.writeHead(404); res.end('Not found');
});

// 長時間の常時接続(SSE)がリクエストタイムアウトで強制切断されないように無効化する。
server.requestTimeout = 0;
server.headersTimeout = 0;

server.listen(PORT, () => {
  startAdminFlusher();
  console.log('');
  console.log('  ★ オールスター感謝祭風クイズ 起動しました ★');
  console.log('  ---------------------------------------------');
  console.log('  管理者(この端末):  http://localhost:' + PORT + '/admin');
  console.log('  投影ディスプレイ:  http://localhost:' + PORT + '/present');
  console.log('  参加者(スマホ):    ' + JOIN_URL);
  console.log('  ---------------------------------------------');
  console.log('  ※ 同一WiFi、または公開URL(Cloudflare Tunnel等)から参加できます。');
  console.log('  ※ 終了は Ctrl+C。');
  if (restoredPlayers) {
    console.log('  ※ 前回の進行状態を復元しました（参加者 ' + restoredPlayers + ' 人 / フェーズ: ' + state.phase + '）。');
    console.log('    まっさらに始めるなら Ctrl+C で止めて  FRESH=1 node server.js  で起動。');
  }
  console.log('');
});

// ===========================================================================
// 感謝祭風 共通テーマ CSS（両ページで共有）
// ===========================================================================
const STARDOTS = `
    radial-gradient(1.6px 1.6px at 12% 18%, rgba(255,255,255,.95), transparent),
    radial-gradient(1.5px 1.5px at 72% 12%, rgba(255,255,255,.8), transparent),
    radial-gradient(2px 2px at 38% 55%, rgba(255,255,255,.85), transparent),
    radial-gradient(1px 1px at 84% 48%, rgba(255,255,255,.7), transparent),
    radial-gradient(2px 2px at 22% 78%, rgba(255,255,255,.8), transparent),
    radial-gradient(1.5px 1.5px at 62% 82%, rgba(255,255,255,.7), transparent),
    radial-gradient(1px 1px at 90% 78%, rgba(255,255,255,.6), transparent),
    radial-gradient(1.5px 1.5px at 50% 32%, rgba(255,255,255,.7), transparent),
    radial-gradient(1px 1px at 8% 62%, rgba(255,255,255,.6), transparent),
    radial-gradient(1.6px 1.6px at 55% 6%, rgba(255,255,255,.75), transparent),
    radial-gradient(1px 1px at 33% 90%, rgba(255,255,255,.6), transparent),
    radial-gradient(1.4px 1.4px at 78% 62%, rgba(255,255,255,.7), transparent)`;

const KANSHA_CSS = `
  .kanshasai-bg{ background:
    radial-gradient(ellipse 130% 95% at 50% 8%, #3ec6f2 0%, #1ca0e8 15%, #1278d8 29%, #0d54bc 45%, #0a3691 62%, #061f66 80%, #030f3d 100%); }
  .starfield{ position:absolute; inset:0; pointer-events:none; background-image:${STARDOTS}; }
  .spark{ position:absolute; pointer-events:none; color:#d3f0ff; text-shadow:0 0 10px #86dcff,0 0 20px #4fb8ff;
    animation:twinkle 2.6s ease-in-out infinite; }
  @keyframes twinkle{0%,100%{opacity:.25;transform:scale(.7)}50%{opacity:1;transform:scale(1.2)}}

  .q-frame{ display:flex; align-items:stretch; gap:10px; padding:10px;
    background:linear-gradient(160deg,#8b3ff0,#5b1fb0 55%,#3d1487);
    border-radius:20px; border:2px solid rgba(190,150,255,.55);
    box-shadow:0 0 26px rgba(130,70,240,.5),0 8px 18px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.25); }
  .q-badge{ flex:none; width:58px; display:flex; align-items:center; justify-content:center;
    font-size:34px; font-weight:900; font-style:italic; color:#4fe6d0;
    background:linear-gradient(160deg,#3a1d8f,#22105e); border-radius:14px;
    text-shadow:0 0 10px rgba(79,230,208,.85); box-shadow:inset 0 2px 4px rgba(255,255,255,.2),inset 0 -3px 6px rgba(0,0,0,.4); }
  .q-pill{ display:flex; align-items:center; justify-content:center; text-align:center; padding:14px 18px;
    font-weight:900; color:#0b2a6b; line-height:1.35;
    background:linear-gradient(#ffffff,#dbe6fb); border-radius:12px;
    box-shadow:inset 0 2px 6px rgba(30,50,120,.22),inset 0 -2px 3px rgba(0,0,0,.08); }

  .choice{ position:relative; display:flex; align-items:center; gap:14px; width:100%;
    background:linear-gradient(180deg,#26428f 0%,#182f6e 48%,#0e1f4c 100%);
    border:2px solid rgba(120,160,255,.4); border-radius:14px; color:#eef4ff;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 5px 12px rgba(0,0,0,.4); transition:transform .08s; }
  .choice:not(:disabled):active{ transform:scale(.98); }
  .choice-dim{ opacity:.45; filter:saturate(.6); }
  .choice-picked{ border-color:#ffe07a; box-shadow:0 0 0 3px #ffe07a,0 0 18px rgba(255,210,90,.6); }
  .choice-correct{ border-color:#4ade80; box-shadow:0 0 0 3px #4ade80,0 0 22px rgba(74,222,128,.7);
    background:linear-gradient(180deg,#1c7a3e,#0f5028); }
  .choice-wrong{ opacity:.4; }

  .num{ flex:none; width:42px; height:42px; border-radius:9999px; display:flex; align-items:center; justify-content:center;
    font-weight:900; color:#fff; border:2px solid rgba(255,255,255,.75);
    box-shadow:inset 0 2px 3px rgba(255,255,255,.55),inset 0 -3px 5px rgba(0,0,0,.4),0 2px 5px rgba(0,0,0,.45);
    text-shadow:0 1px 2px rgba(0,0,0,.5); }
  .n1{ background:radial-gradient(circle at 35% 28%,#8fc0ff,#1c63e6 72%); }
  .n2{ background:radial-gradient(circle at 35% 28%,#ff9a9a,#e11d1d 72%); }
  .n3{ background:radial-gradient(circle at 35% 28%,#8ceaa0,#16a23a 72%); }
  .n4{ background:radial-gradient(circle at 35% 28%,#ffe38f,#f0a600 72%); }
  .n5{ background:radial-gradient(circle at 35% 28%,#c4b5fd,#7c3aed 72%); }
  .n6{ background:radial-gradient(circle at 35% 28%,#f9a8d4,#db2777 72%); }
  .n7{ background:radial-gradient(circle at 35% 28%,#67e8f9,#0891b2 72%); }
  .n8{ background:radial-gradient(circle at 35% 28%,#fdba74,#ea580c 72%); }
  .n9{ background:radial-gradient(circle at 35% 28%,#bef264,#65a30d 72%); }
  .n10{ background:radial-gradient(circle at 35% 28%,#a5b4fc,#4f46e5 72%); }

  .timer-ball{ display:flex; align-items:center; justify-content:center; border-radius:9999px;
    font-weight:900; color:#fff; background:radial-gradient(circle at 38% 28%,#ff8080,#d31414 66%);
    border:3px solid #fff; box-shadow:inset 0 -5px 10px rgba(0,0,0,.4),inset 0 4px 8px rgba(255,255,255,.5),0 5px 14px rgba(0,0,0,.5);
    text-shadow:0 2px 3px rgba(0,0,0,.5); }
  .timer-sm{ width:52px; height:52px; font-size:24px; }
  .timer-lg{ width:88px; height:88px; font-size:44px; }
  .timer-ball.urgent{ animation:tpulse .5s ease-in-out infinite; background:radial-gradient(circle at 38% 28%,#ffb3b3,#cc0000 66%); }
  @keyframes tpulse{0%,100%{transform:scale(1)}50%{transform:scale(1.14)}}

  .gold-row{ background:linear-gradient(90deg,#ffd76a,#f0a500); color:#3a2600; box-shadow:0 3px 10px rgba(0,0,0,.35); }
  .panel-row{ background:rgba(255,255,255,.09); border:1px solid rgba(255,255,255,.14); color:#eaf2ff; }
`;

// ===========================================================================
// 参加者ページ（モバイル）
// ===========================================================================
const PLAYER_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>感謝祭クイズ</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  ${KANSHA_CSS}
  html,body{ -webkit-tap-highlight-color:transparent; }
  body{ min-height:100vh; }
  .pop{ animation:pop .25s ease; } @keyframes pop{ from{transform:scale(.9);opacity:.4} to{transform:scale(1);opacity:1} }
</style>
</head>
<body class="kanshasai-bg text-white min-h-screen">
<div class="starfield" style="position:fixed"></div>
<span class="spark" style="left:8%;top:14%;font-size:22px">✦</span>
<span class="spark" style="left:88%;top:22%;font-size:16px;animation-delay:.6s">✦</span>
<span class="spark" style="left:16%;top:70%;font-size:14px;animation-delay:1.1s">✦</span>
<span class="spark" style="left:80%;top:66%;font-size:20px;animation-delay:.3s">✦</span>
<div id="app" class="relative z-10 max-w-md mx-auto px-4 py-6 min-h-screen flex flex-col"></div>
<script>
var DEPTS=['グロ事企・海外拠点・出向','サビコン','金コン','ヘル産','ICTコン','UIコン','エネ産','社シス1','社シス2','経コン','業務IT','マーケコン','AI戦略','本部付・国内スタッフ部室'];
var S = { id:null, name:null, dept:null, es:null, answeredQ:-1, timer:null, rankTab:'player', lastV:null, rentanPicks:[] };
var app = document.getElementById('app');

function esc(s){ var d=document.createElement('div'); d.textContent=(s==null?'':String(s)); return d.innerHTML; }
function ct(c){ return typeof c==='object'?(c.text||''):(c==null?'':String(c)); }
function ci(c){ return typeof c==='object'?c.img:null; }
function hasImg(cs){ return cs.some(function(c){ return ci(c); }); }

function boot(){
  try { S.id=localStorage.getItem('kq_id'); S.name=localStorage.getItem('kq_name'); S.dept=localStorage.getItem('kq_dept'); } catch(e){}
  if(!S.id){ S.id=(crypto.randomUUID?crypto.randomUUID():String(Math.random()).slice(2)); try{ localStorage.setItem('kq_id',S.id); }catch(e){} }
  if(S.name&&S.dept){ connect(); } else { renderJoin(); }
}

function renderJoin(){
  var opts=DEPTS.map(function(d){ return '<option value="'+d+'">'+d+'</option>'; }).join('');
  app.innerHTML=
    '<div class="flex-1 flex flex-col justify-center">'
    +'<div class="text-center mb-6"><div class="text-6xl mb-3">🎉</div>'
    +'<h1 class="text-3xl font-black tracking-wide" style="text-shadow:0 0 18px rgba(120,220,255,.7)">感謝祭クイズ</h1>'
    +'<p class="text-cyan-200/90 text-sm mt-2">部署とフルネームを入力して参加</p></div>'
    +'<select id="dept" class="w-full text-center text-lg bg-white/10 border-2 border-white/25 rounded-xl py-4 mb-3 outline-none focus:ring-2 ring-amber-400 text-white">'
    +'<option value="" disabled selected style="color:#333">部署を選択してください</option>'+opts
    +'</select>'
    +'<input id="nm" maxlength="12" placeholder="フルネーム（例. 水石 仁）" class="w-full text-center text-xl bg-white/10 border-2 border-white/25 rounded-xl py-4 mb-4 outline-none focus:ring-2 ring-amber-400 placeholder-white/40">'
    +'<button onclick="doJoin()" class="w-full bg-gradient-to-b from-amber-300 to-amber-500 active:from-amber-400 active:to-amber-600 text-slate-900 font-black text-xl rounded-xl py-4 shadow-lg">エントリー</button>'
    +'<div id="joinErr" class="text-red-300 text-sm text-center mt-2"></div>'
    +'</div>';
  document.getElementById('nm').addEventListener('keydown',function(e){ if(e.key==='Enter') doJoin(); });
}
function doJoin(){
  var dept=document.getElementById('dept').value;
  var nm=document.getElementById('nm').value.trim();
  var err=document.getElementById('joinErr');
  if(!dept){ err.textContent='部署を選択してください'; return; }
  if(!nm){ err.textContent='フルネームを入力してください'; return; }
  S.name=nm; S.dept=dept;
  try{ localStorage.setItem('kq_name',nm); localStorage.setItem('kq_dept',dept); }catch(e){}
  connect();
}
function connect(){
  if(S.es){ try{ S.es.close(); }catch(e){} }
  clearTimeout(S.retry);
  S.es = new EventSource('/events?role=player&id='+encodeURIComponent(S.id)+'&name='+encodeURIComponent(S.name)+'&dept='+encodeURIComponent(S.dept||''));
  S.es.onmessage = function(ev){ try{ render(JSON.parse(ev.data)); }catch(e){} };
  // 切断時はネイティブ再接続に任せず、ジッター付きで再接続（400台の一斉再接続=スタンピード防止）
  S.es.onerror = function(){ try{ S.es.close(); }catch(e){} clearTimeout(S.retry); S.retry=setTimeout(connect, 800+Math.random()*3000); };
}

function header(v){
  return '<div class="flex items-center justify-between text-sm mb-4 relative z-10">'
    +'<div class="flex items-center gap-1 min-w-0">'
    +(v.me.dept?'<span class="bg-cyan-500/20 border border-cyan-400/30 text-cyan-200 rounded-full px-2 py-1 text-xs shrink-0">'+esc(v.me.dept)+'</span>':'')
    +'<span class="bg-white/10 border border-white/20 rounded-full px-3 py-1 truncate">👤 '+esc(v.me.name)+'</span>'
    +'</div>'
    +'<span class="bg-gradient-to-b from-amber-300 to-amber-500 text-slate-900 font-black rounded-full px-3 py-1 shrink-0">'+(v.me.score||0)+' pt</span></div>';
}

function render(v){
  S.lastV=v;
  if(v.emergencyMode){
    var ep='/emergency?id='+encodeURIComponent(S.id||'')+'&name='+encodeURIComponent(S.name||'')+'&dept='+encodeURIComponent(S.dept||'');
    window.location.replace(ep);
    return;
  }
  if(v.phase==='lobby') renderLobby(v);
  else if(v.phase==='question'){
    if(v.q&&v.q.type==='rentan') renderRentanQuestion(v);
    else renderQuestion(v);
  }
  else if(v.phase==='reveal'||v.phase==='stats'){
    if(v.q&&v.q.type==='rentan') renderRentanReveal(v);
    else renderReveal(v);
  }
  else if(v.phase==='ranking') renderRanking(v);
  else if(v.phase==='finished') renderRanking(v, true);
}

function renderLobby(v){
  clearInterval(S.timer);
  app.innerHTML = header(v)
    + '<div class="flex-1 flex flex-col items-center justify-center text-center">'
    + '<div class="text-6xl mb-4 pop">✅</div>'
    + '<div class="text-2xl font-black mb-1" style="text-shadow:0 0 14px rgba(120,220,255,.6)">エントリー完了！</div>'
    + '<div class="text-cyan-200">'+esc(v.me.name)+' さん</div>'
    + '<div class="mt-6 text-sm text-cyan-100/70">現在 '+v.joinCount+' 人が参加中</div>'
    + '<div class="mt-8 text-amber-300 font-bold animate-pulse">まもなく開始します…</div>'
    + '<button onclick="editEntry()" class="mt-6 px-4 py-2 bg-slate-700/50 border border-slate-500 text-slate-300 text-sm rounded hover:bg-slate-600/70 transition">📝 情報を修正</button>'
    + '</div>';
}
function editEntry(){
  S.name=null; S.dept=null;
  try{ localStorage.removeItem('kq_name'); localStorage.removeItem('kq_dept'); }catch(e){}
  location.reload();
}

function renderQuestion(v){
  var q=v.q;
  var answered=(v.myAnswer!=null);
  var imgMode=hasImg(q.choices);
  var hdr=header(v)
    +'<div class="flex items-center justify-between mb-3 relative z-10">'
    +'<span class="text-xs text-cyan-200/80 font-bold">'+(v.periodName?esc(v.periodName)+' ':'')+' 第'+(q.index+1)+'問 / '+q.total+'</span>'
    +'<div id="tball" class="timer-ball timer-sm">--</div></div>'
    +'<div class="q-frame mb-3"><div class="q-badge">Q</div><div class="q-pill flex-1 text-base min-h-[56px]">'+esc(q.text)+'</div></div>'
    +(q.img?'<div class="mb-3 rounded-xl overflow-hidden bg-slate-900 text-center"><img src="'+q.img+'" class="max-w-full max-h-48 object-contain inline-block"></div>':'');
  var btns='';
  if(imgMode){
    for(var i=0;i<q.choices.length;i++){
      var picked=(v.myAnswer===i);
      var img=ci(q.choices[i]); var txt=ct(q.choices[i]);
      var ring=picked?'ring-4 ring-amber-400 shadow-[0_0_18px_rgba(251,191,36,.7)]':'';
      var dim=answered&&!picked?'opacity-40':'';
      btns+='<button '+(answered?'disabled':'')+' onclick="answer('+i+')"'
        +' class="relative rounded-2xl overflow-hidden bg-slate-900 transition '+ring+' '+dim+'" style="aspect-ratio:1">'
        +(img?'<img src="'+img+'" class="w-full h-full object-cover">':'<div class="w-full h-full flex items-center justify-center p-3"><span class="text-white font-bold text-center text-sm leading-snug">'+esc(txt)+'</span></div>')
        +'<div class="absolute top-2 left-2"><span class="num n'+(i+1)+'" style="width:30px;height:30px;font-size:14px">'+(i+1)+'</span></div>'
        +(img&&txt?'<div class="absolute bottom-0 inset-x-0 bg-black/60 text-white text-xs font-bold text-center py-1 px-1 leading-tight">'+esc(txt)+'</div>':'')
        +'</button>';
    }
    app.innerHTML=hdr+'<div class="grid grid-cols-2 gap-3">'+btns+'</div>'
      +(answered?'<div class="text-center text-cyan-100 mt-4 font-bold pop">回答しました！結果を待ってね</div>':'');
  } else {
    for(var i=0;i<q.choices.length;i++){
      var picked=(v.myAnswer===i);
      var st=answered?(picked?'choice-picked':'choice-dim'):'';
      btns+='<button '+(answered?'disabled':'')+' onclick="answer('+i+')" class="choice '+st+' px-4 py-4 text-left text-lg">'
        +'<span class="num n'+(i+1)+'">'+(i+1)+'</span>'
        +'<span class="flex-1 font-bold">'+esc(ct(q.choices[i]))+'</span></button>';
    }
    app.innerHTML=hdr+'<div class="grid grid-cols-1 gap-3">'+btns+'</div>'
      +(answered?'<div class="text-center text-cyan-100 mt-5 font-bold pop">回答しました！結果を待ってね</div>':'');
  }
  startTimer(q.remainingMs,q.timeLimit*1000);
}

function startTimer(remaining, total){
  clearInterval(S.timer);
  var end=Date.now()+remaining;
  function tick(){
    var rem=Math.max(0,end-Date.now());
    var b=document.getElementById('tball');
    if(!b){ clearInterval(S.timer); return; }
    b.textContent=Math.ceil(rem/1000);
    if(rem<=5000) b.classList.add('urgent');
    if(rem<=0){ clearInterval(S.timer);
      var bs=document.querySelectorAll('#app button'); for(var k=0;k<bs.length;k++) bs[k].disabled=true;
    }
  }
  tick(); S.timer=setInterval(tick,150);
}

function answer(i){
  var bs=document.querySelectorAll('#app button'); for(var k=0;k<bs.length;k++) bs[k].disabled=true;
  fetch('/api/answer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:S.id,choice:i})});
}

// ===== 連単（順位予測）問題 =====
function renderRentanQuestion(v){
  var q=v.q;
  var k=q.rankCount||3;
  var answered=(v.myAnswer!=null&&Array.isArray(v.myAnswer)&&v.myAnswer.length===k);
  // すでに連単UIが表示中で未回答 → picks を保持したまま選択表示だけ更新（SSE更新でリセットしない）
  if(document.getElementById('rsel') && !answered){
    updateRentanUI(q, k, false);
    return;
  }
  S.rentanPicks=answered?v.myAnswer.slice():[];
  // 骨格だけ描いてからUIを更新（タップ時にタイマーをリセットしないため）
  app.innerHTML=header(v)
    +'<div class="flex items-center justify-between mb-3 relative z-10">'
    +'<span class="text-xs text-cyan-200/80 font-bold">'+(v.periodName?esc(v.periodName)+' ':'')+' 第'+(q.index+1)+'問 / '+q.total+'</span>'
    +'<div id="tball" class="timer-ball timer-sm">--</div></div>'
    +'<div class="q-frame mb-3"><div class="q-badge" style="font-size:22px;width:48px">連単</div><div class="q-pill flex-1 text-base min-h-[56px]">'+esc(q.text)+'</div></div>'
    +(q.img?'<div class="mb-3 rounded-xl overflow-hidden bg-slate-900 text-center"><img src="'+q.img+'" class="max-w-full max-h-48 object-contain inline-block"></div>':'')
    +'<div class="text-center text-xs text-cyan-200/80 mb-2 font-bold">'+k+'位まで順番にタップ！（もう一度タップで解除）</div>'
    +'<div id="rsel"></div>'
    +'<div id="rbtns" class="grid grid-cols-1 gap-2"></div>'
    +(answered?'<div class="text-center text-cyan-100 mt-4 font-bold pop">回答しました！結果を待ってね</div>':'');
  updateRentanUI(q, k, answered);
  startTimer(q.remainingMs,q.timeLimit*1000);
}
function updateRentanUI(q, k, answered){
  var picks=S.rentanPicks;
  var medals=['🥇','🥈','🥉','4位','5位','6位','7位','8位','9位','10位'];
  // 順位表示行
  var selRow='<div class="flex justify-center gap-2 mb-3 flex-wrap">';
  for(var r=0;r<k;r++){
    var ci=r<picks.length?picks[r]:-1;
    var label=ci>=0?esc(ct(q.choices[ci])):'?';
    selRow+='<div class="flex flex-col items-center gap-1">'
      +'<span class="text-xs font-bold text-amber-300">'+(r+1)+'位</span>'
      +'<div class="px-3 py-1.5 rounded-lg text-sm font-bold '+(ci>=0?'bg-amber-400/90 text-slate-900':'bg-white/10 text-white/50 border border-white/20')+'">'+label+'</div>'
      +'</div>';
  }
  selRow+='</div>';
  // 選択肢ボタン
  var btns='';
  for(var i=0;i<q.choices.length;i++){
    var pickRank=-1; for(var r=0;r<picks.length;r++) if(picks[r]===i){ pickRank=r; break; }
    var picked=(pickRank>=0);
    var st=answered?(picked?'choice-picked':'choice-dim'):('choice'+(picked?' choice-picked':''));
    btns+='<button '+(answered?'disabled':'')+' onclick="rentanTap('+i+')" class="'+st+' px-4 py-3 text-left w-full">'
      +'<span class="num n'+(i+1)+'">'+(i+1)+'</span>'
      +'<span class="flex-1 font-bold text-base">'+esc(ct(q.choices[i]))+'</span>'
      +(picked?'<span class="text-amber-300 font-black text-sm shrink-0">'+medals[pickRank]+'</span>':'<span class="w-10 shrink-0"></span>')
      +'</button>';
  }
  var rsel=document.getElementById('rsel'), rbtns=document.getElementById('rbtns');
  if(rsel) rsel.innerHTML=selRow;
  if(rbtns) rbtns.innerHTML=btns;
}
function rentanTap(i){
  if(!S.lastV||!S.lastV.q) return;
  var q=S.lastV.q, k=q.rankCount||3;
  var answered=(S.lastV.myAnswer!=null&&Array.isArray(S.lastV.myAnswer)&&S.lastV.myAnswer.length===k);
  if(answered) return;
  var idx=S.rentanPicks.indexOf(i);
  if(idx>=0){ S.rentanPicks.splice(idx,1); }       // 解除
  else if(S.rentanPicks.length<k){ S.rentanPicks.push(i); } // 追加
  updateRentanUI(q, k, false);
  // K個揃ったら自動送信
  if(S.rentanPicks.length===k){
    var bs=document.querySelectorAll('#app button'); for(var j=0;j<bs.length;j++) bs[j].disabled=true;
    fetch('/api/answer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:S.id,choices:S.rentanPicks.slice()})});
  }
}
function renderRentanReveal(v){
  clearInterval(S.timer);
  var q=v.q, r=v.reveal;
  var k=q.rankCount||3;
  var showAnswer=(v.phase==='reveal');
  var myChoices=Array.isArray(v.myAnswer)?v.myAnswer:[];
  var medals=['🥇','🥈','🥉','4位','5位','6位','7位','8位','9位','10位'];
  var msg;
  if(!showAnswer){
    msg='<div class="text-3xl mb-1">📊</div><div class="text-cyan-200 font-bold">みんなの解答は…？</div>';
  } else if(myChoices.length===0){
    msg='<div class="text-4xl mb-1">😴</div><div class="text-cyan-200">未回答</div>';
  } else {
    var msLabel2=r.myAnswerMs!=null?'<div class="text-xs text-white/30 mt-2">回答時間 '+(r.myAnswerMs/1000).toFixed(1)+'秒</div>':'';
    if(r.myCorrect){
      msg='<div class="text-5xl mb-1 pop">🎯</div><div class="text-emerald-300 font-black text-2xl" style="text-shadow:0 0 14px rgba(74,222,128,.7)">完全正解！ +'+r.myPoints+'pt</div>'+msLabel2;
    } else if(r.myPoints>0){
      msg='<div class="text-4xl mb-1">🎉</div><div class="text-amber-300 font-black text-xl">'+r.myMatchCount+'位まで正解！ +'+r.myPoints+'pt</div>'+msLabel2;
    } else {
      msg='<div class="text-5xl mb-1">😢</div><div class="text-red-300 font-black text-2xl">惜しくも不正解…</div>'+msLabel2;
    }
  }
  // Show correct order
  var correctRows='';
  if(showAnswer&&r.correctOrder){
    correctRows='<div class="mb-3">'
      +'<div class="text-xs font-bold text-emerald-300 mb-2">✅ 正解順序</div>'
      +'<div class="grid grid-cols-1 gap-1">';
    for(var ri=0;ri<k;ri++){
      var ci=r.correctOrder[ri];
      var myci=myChoices[ri];
      var ok=(myci===ci);
      correctRows+='<div class="flex items-center gap-3 rounded-lg px-3 py-2 '+(ok&&showAnswer?'bg-emerald-900/60 border border-emerald-500/50':'bg-white/8 border border-white/10')+'">'
        +'<span class="text-base font-black text-amber-300 w-8 shrink-0">'+medals[ri]+'</span>'
        +'<span class="font-bold flex-1">'+esc(ct(q.choices[ci]))+'</span>'
        +(showAnswer&&ok?'<span class="text-emerald-400 text-sm font-bold shrink-0">⭕</span>':'')
        +(showAnswer&&!ok&&myci!=null?'<span class="text-xs text-white/50 shrink-0">あなた: '+esc(ct(q.choices[myci]))+'</span>':'')
        +'</div>';
    }
    correctRows+='</div></div>';
  }
  // Show all choices dimmed/normal
  var rows='';
  for(var i=0;i<q.choices.length;i++){
    var inCorrect=showAnswer&&r.correctOrder&&r.correctOrder.indexOf(i)>=0;
    var cls=showAnswer?(inCorrect?'choice-correct':'choice-wrong'):'choice';
    rows+='<div class="'+cls+' px-3 py-2">'
      +'<span class="num n'+(i+1)+'">'+(i+1)+'</span>'
      +'<span class="flex-1 font-bold text-sm">'+esc(ct(q.choices[i]))+'</span>'
      +'</div>';
  }
  app.innerHTML=header(v)
    +'<div class="text-center py-3">'+msg+'</div>'
    +correctRows
    +'<div class="grid grid-cols-1 gap-1 mt-1">'+rows+'</div>'
    +'<div class="text-center text-cyan-100/70 text-sm mt-4 animate-pulse">次の展開を待っています…</div>';
}

function renderReveal(v){
  clearInterval(S.timer);
  var q=v.q, r=v.reveal;
  var showAnswer=(v.phase==='reveal');  // statsフェーズは解答率のみ、revealフェーズで正解開示
  var total=0; for(var t=0;t<r.counts.length;t++) total+=r.counts[t];
  var imgMode=hasImg(q.choices);
  var msg;
  if(!showAnswer){
    msg='<div class="text-3xl mb-1">📊</div><div class="text-cyan-200 font-bold">みんなの解答は…？</div>';
  } else {
    var msLabel=r.myAnswerMs!=null?'<div class="text-xs text-white/30 mt-2">回答時間 '+(r.myAnswerMs/1000).toFixed(1)+'秒</div>':'';
    msg=(v.myAnswer==null)?'<div class="text-4xl mb-1">😴</div><div class="text-cyan-200">未回答</div>'
      :(r.myCorrect?'<div class="text-5xl mb-1 pop">🎯</div><div class="text-emerald-300 font-black text-2xl" style="text-shadow:0 0 14px rgba(74,222,128,.7)">正解！ +'+r.myPoints+'pt</div>'+msLabel
                   :'<div class="text-5xl mb-1">😢</div><div class="text-red-300 font-black text-2xl">不正解…</div>'+msLabel);
  }
  var rows='';
  if(imgMode){
    for(var i=0;i<q.choices.length;i++){
      var isC=(i===r.correctIndex);
      var img=ci(q.choices[i]); var txt=ct(q.choices[i]);
      var pct=total?Math.round(100*r.counts[i]/total):0;
      var dimClass=showAnswer&&!isC?'opacity-35':'';
      var ringClass=showAnswer&&isC?'ring-4 ring-emerald-400':'';
      rows+='<div class="relative rounded-2xl overflow-hidden bg-slate-900 '+ringClass+' '+dimClass+'" style="aspect-ratio:1">'
        +(img?'<img src="'+img+'" class="w-full h-full object-cover">':'<div class="w-full h-full flex items-center justify-center p-3"><span class="text-white font-bold text-center text-sm">'+esc(txt)+'</span></div>')
        +'<div class="absolute top-2 left-2"><span class="num n'+(i+1)+'" style="width:30px;height:30px;font-size:14px">'+(i+1)+'</span></div>'
        +(showAnswer&&isC?'<div class="absolute inset-0 flex items-center justify-center"><span class="text-5xl">⭕</span></div>':'')
        +'<div class="absolute bottom-0 inset-x-0 bg-black/65 text-center py-1"><div class="text-white text-xs font-bold">'+r.counts[i]+'人 ('+pct+'%)</div></div>'
        +'</div>';
    }
    app.innerHTML=header(v)
      +'<div class="text-center py-3">'+msg+'</div>'
      +'<div class="grid grid-cols-2 gap-3">'+rows+'</div>'
      +'<div class="text-center text-cyan-100/70 text-sm mt-4 animate-pulse">次の展開を待っています…</div>';
  } else {
    for(var i=0;i<q.choices.length;i++){
      var isC=(i===r.correctIndex);
      var pct=total?Math.round(100*r.counts[i]/total):0;
      var cls=showAnswer?(isC?'choice-correct':'choice-wrong'):'choice';
      rows+='<div class="'+cls+' px-4 py-3">'
        +'<span class="num n'+(i+1)+'">'+(i+1)+'</span>'
        +'<span class="flex-1 font-bold">'+(showAnswer&&isC?'⭕ ':'')+esc(ct(q.choices[i]))+'</span>'
        +'<span class="text-sm whitespace-nowrap">'+r.counts[i]+'人 ('+pct+'%)</span>'
        +'</div>';
    }
    app.innerHTML=header(v)
      +'<div class="text-center py-4">'+msg+'</div>'
      +'<div class="grid grid-cols-1 gap-2 mt-2">'+rows+'</div>'
      +'<div class="text-center text-cyan-100/70 text-sm mt-6 animate-pulse">次の展開を待っています…</div>';
  }
}

function switchRankTab(tab){
  S.rankTab=tab;
  if(S.lastV) renderRanking(S.lastV, S.lastV.phase==='finished');
}
function renderRanking(v, finished){
  clearInterval(S.timer);
  S.lastV=v;
  var medal=['🥇','🥈','🥉'];
  var tabs='<div class="flex gap-2 mb-3">'
    +'<button onclick="switchRankTab(\\'player\\')" class="flex-1 py-2 rounded-xl font-bold text-sm transition-colors '+(S.rankTab==='player'?'bg-amber-400 text-slate-900':'bg-white/10 text-white/70 hover:bg-white/20')+'">👤 個人</button>'
    +'<button onclick="switchRankTab(\\'dept\\')" class="flex-1 py-2 rounded-xl font-bold text-sm transition-colors '+(S.rankTab==='dept'?'bg-amber-400 text-slate-900':'bg-white/10 text-white/70 hover:bg-white/20')+'">🏢 部署</button>'
    +'</div>';
  var titleArea='<div class="text-center mb-3"><div class="text-4xl">'+(finished?'🏆':'📊')+'</div>'
    +'<div class="text-2xl font-black" style="text-shadow:0 0 14px rgba(120,220,255,.6)">'+(finished?'最終結果':'途中経過ランキング')+'</div>'
    +(S.rankTab==='player'&&v.myRank?'<div class="text-amber-300 font-bold mt-1">あなたは '+v.myRank+' 位</div>':'')
    +'</div>';
  var content='';
  if(S.rankTab==='player'){
    var list=v.ranking||[]; var rows='';
    for(var i=0;i<list.length;i++){
      var p=list[i]; var mine=(p.id===S.id);
      rows+='<div class="flex items-center gap-3 rounded-xl p-3 '+(i<3?'gold-row':'panel-row')+(mine?' ring-2 ring-cyan-300':'')+'">'
        +'<span class="w-8 text-center font-black text-lg shrink-0">'+(i<3?medal[i]:(i+1))+'</span>'
        +'<div class="flex-1 min-w-0">'
        +'<div class="font-bold truncate">'+esc(p.name)+(mine?' 👈':'')+'</div>'
        +(p.dept?'<div class="text-xs opacity-70 truncate">'+esc(p.dept)+'</div>':'')
        +'</div>'
        +'<div class="text-right shrink-0"><div class="font-black tabular-nums">'+p.score+'</div>'
        +(p.totalAnswerMs?'<div class="text-xs opacity-30 tabular-nums">'+( p.totalAnswerMs/1000).toFixed(1)+'秒</div>':'')
        +'</div></div>';
    }
    content='<div class="grid grid-cols-1 gap-2">'+rows+'</div>';
  } else {
    var dlist=v.deptRanking||[]; var drows='';
    for(var i=0;i<dlist.length;i++){
      var d=dlist[i]; var myDept=v.me&&v.me.dept; var isDept=myDept&&d.dept===myDept;
      drows+='<div class="flex items-center gap-3 rounded-xl p-3 '+(i<3?'gold-row':'panel-row')+(isDept?' ring-2 ring-cyan-300':'')+'">'
        +'<span class="w-8 text-center font-black text-lg shrink-0">'+(i<3?medal[i]:(i+1))+'</span>'
        +'<div class="flex-1 min-w-0">'
        +'<div class="font-bold truncate">'+esc(d.dept)+(isDept?' 👈':'')+'</div>'
        +'<div class="text-xs opacity-70">'+d.count+'人参加 · 合計 '+d.total+'pt</div>'
        +'</div>'
        +'<div class="text-right shrink-0">'
        +'<div class="font-black tabular-nums text-amber-300">'+d.avg+'<span class="text-xs font-normal text-white/70"> pt/人</span></div>'
        +'</div></div>';
    }
    content='<div class="grid grid-cols-1 gap-2">'+(drows||'<div class="text-center text-cyan-100/60 py-4">データなし</div>')+'</div>';
  }
  app.innerHTML=header(v)+titleArea+tabs+content
    +(finished?'<div class="text-center text-cyan-100/80 mt-6">おつかれさまでした！🎉</div>':'');
}

boot();
</script>
</body>
</html>`;

// ===========================================================================
// 管理者ページ（PC）
// ===========================================================================
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>感謝祭クイズ 管理</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
  ${KANSHA_CSS}
  #monitor{ position:relative; overflow:hidden; border:2px solid rgba(120,160,255,.3); }
  #monitor::before{ content:''; position:absolute; inset:0; pointer-events:none; background-image:${STARDOTS}; }
  #monitor > *{ position:relative; z-index:1; }
</style>
</head>
<audio id="snd-bgm"      src="/api/media/media1.mp3" loop  preload="auto"></audio>
<audio id="snd-countdown" src="/api/media/media3.mp4"       preload="auto"></audio>
<audio id="snd-fanfare"   src="/api/media/media4.mp4"       preload="auto"></audio>
<body class="bg-slate-100 text-slate-800">
<div class="max-w-7xl mx-auto p-6">
  <div class="flex items-center justify-between mb-5">
    <h1 class="text-2xl font-bold">🎉 オールスター感謝祭風クイズ <span class="text-slate-400 text-base font-normal">管理者コンソール</span></h1>
    <div class="flex items-center gap-3">
      <button id="muteBtn" onclick="toggleMute()" class="text-xs border rounded px-2 py-1 bg-emerald-50 text-emerald-700 border-emerald-300">🔊 音声オン</button>
      <div id="phaseBadge" class="px-4 py-2 rounded-full text-sm font-bold bg-slate-200">待機中</div>
    </div>
  </div>
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
    <!-- 左: 操作 -->
    <div class="space-y-6">
      <div class="bg-white rounded-2xl shadow p-5">
        <h2 class="font-bold mb-3">📱 参加用リンク</h2>
        <div class="flex gap-4 items-center">
          <div id="qr" class="bg-white p-2 rounded-lg border shrink-0"></div>
          <div class="min-w-0">
            <a id="joinLink" href="#" target="_blank" class="text-blue-600 font-mono break-all underline"></a>
            <div class="mt-2 text-sm text-slate-500">参加者: <span id="joinCount" class="font-bold text-slate-800">0</span> 人</div>
            <div id="joinHint" class="mt-1 text-xs text-slate-400"></div>
          </div>
        </div>
        <div class="mt-4 pt-4 border-t">
          <label class="text-sm font-bold text-slate-600">公開URL（VS Codeのポート転送URL）</label>
          <div class="flex gap-2 mt-1">
            <input id="puburl" placeholder="https://xxxx-3000.xxx.devtunnels.ms/ を貼り付け" class="flex-1 border rounded-lg p-2 text-sm font-mono outline-none focus:ring-2 ring-amber-400">
            <button onclick="applyJoinUrl()" class="bg-slate-700 hover:bg-slate-800 text-white text-sm font-bold rounded-lg px-4 shrink-0">反映</button>
            <button onclick="clearJoinUrl()" class="text-slate-400 hover:text-slate-600 text-sm px-2 shrink-0">解除</button>
          </div>
          <div class="mt-1 text-xs text-slate-400">空欄なら同じWiFi用のLAN URLを表示します。貼り付けて「反映」でQR・リンクが公開URLに切り替わります。</div>
        </div>
      </div>

      <div class="bg-white rounded-2xl shadow p-5">
        <h2 class="font-bold mb-3">➕ 問題を追加</h2>
        <textarea id="qtext" rows="2" placeholder="問題文" class="w-full border rounded-lg p-3 mb-2 outline-none focus:ring-2 ring-amber-400"></textarea>
        <div class="flex items-center gap-2 mb-3">
          <span class="text-sm text-slate-600">問題画像:</span>
          <input type="file" accept="image/*" id="qimgfile" class="hidden" onchange="if(this.files&&this.files[0])uploadQImg(this.files[0])">
          <button type="button" onclick="triggerQImg()" class="border border-slate-300 hover:border-slate-500 rounded-lg px-3 py-1.5 text-sm">📷 追加</button>
          <div id="qimgthumb" class="hidden shrink-0 relative">
            <img id="qimgprev" src="" class="h-12 max-w-xs object-contain rounded border bg-slate-100">
            <button type="button" onclick="clearQImg()" class="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-xs rounded-full flex items-center justify-center leading-none">×</button>
          </div>
        </div>
        <textarea id="qintro" rows="2" placeholder="前振り（アイドリング）例：このコンサル本部感謝祭では400人を超える皆様にご参加いただきました。では、" class="w-full border rounded-lg p-3 mb-3 outline-none focus:ring-2 ring-blue-400 text-sm text-slate-600 resize-none" style="border-style:dashed"></textarea>
        <textarea id="qreference" rows="1" placeholder="参考情報（正解発表時に司会者が読むセリフ・背景説明 — 管理者のみ表示）" class="w-full border rounded-lg p-3 mb-3 outline-none focus:ring-2 ring-green-400 text-sm text-slate-600 resize-none" style="border-style:dashed;background-color:#f0fdf4"></textarea>
        <div class="flex items-center gap-2 mb-3 flex-wrap">
          <span class="text-sm text-slate-600 font-bold">形式:</span>
          <button id="qtypeSingle" onclick="setQType('single')" class="px-3 py-1.5 rounded-lg text-sm font-bold border-2 border-amber-400 bg-amber-50 text-amber-700">単択</button>
          <button id="qtypeRentan" onclick="setQType('rentan')" class="px-3 py-1.5 rounded-lg text-sm font-bold border border-slate-300 text-slate-500 hover:border-slate-400">連単</button>
          <span class="text-slate-300 mx-2">|</span>
          <span class="text-sm text-slate-600 font-bold">選択肢数:</span>
          <button onclick="setChoiceN(CHOICE_N-1)" class="w-7 h-7 flex items-center justify-center rounded border border-slate-300 hover:bg-slate-100 font-bold text-slate-600">−</button>
          <span id="choiceNLabel" class="w-6 text-center font-bold text-slate-800">4</span>
          <button onclick="setChoiceN(CHOICE_N+1)" class="w-7 h-7 flex items-center justify-center rounded border border-slate-300 hover:bg-slate-100 font-bold text-slate-600">＋</button>
          <div id="rentanKBox" class="hidden items-center gap-2 ml-2">
            <span class="text-sm text-slate-600 font-bold">何位まで:</span>
            <button onclick="setRentanK(RENTAN_K-1)" class="w-7 h-7 flex items-center justify-center rounded border border-slate-300 hover:bg-slate-100 font-bold text-slate-600">−</button>
            <span id="rentanKLabel" class="w-6 text-center font-bold text-slate-800">3</span>
            <button onclick="setRentanK(RENTAN_K+1)" class="w-7 h-7 flex items-center justify-center rounded border border-slate-300 hover:bg-slate-100 font-bold text-slate-600">＋</button>
            <span class="text-xs text-slate-400">位</span>
          </div>
        </div>
        <div id="choiceRows" class="space-y-2 mb-3"></div>
        <div id="rentanHint" class="hidden text-xs text-blue-600 bg-blue-50 rounded-lg px-3 py-2 mb-3">💡 各選択肢の「順位」ボタンで正解順序を指定してください（例: 1位→選択肢A, 2位→選択肢C）</div>
        <div class="flex items-center gap-3 mb-3 flex-wrap">
          <label class="text-sm text-slate-600">制限時間</label>
          <input id="tlimit" type="number" value="20" min="5" max="120" class="w-20 border rounded-lg p-2 text-center">
          <span class="text-sm text-slate-500">秒</span>
          <label class="text-sm text-slate-600 ml-4">配点</label>
          <input id="qpoints" type="number" value="100" min="1" max="99999" class="w-24 border rounded-lg p-2 text-center">
          <span class="text-sm text-slate-500">点</span>
          <span id="addHint" class="text-xs text-slate-400 ml-auto">ラジオで正解選択</span>
        </div>
        <button onclick="addQuestion()" class="w-full bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg py-2.5">問題を追加</button>
        <div id="addMsg" class="text-sm text-red-500 mt-2"></div>
      </div>

      <div class="bg-white rounded-2xl shadow p-5">
        <h2 class="font-bold mb-3">📋 問題リスト (<span id="qCount">0</span>)</h2>
        <div id="qlist" class="space-y-2 max-h-72 overflow-auto"></div>
      </div>

      <div class="bg-slate-900 rounded-2xl shadow p-5">
        <div class="mb-4">
          <div class="flex items-center justify-between mb-2">
            <h2 class="font-bold text-white text-sm">📋 Periods</h2>
            <button onclick="addPeriod()" class="text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded-full">＋ 新しいPeriod</button>
          </div>
          <div id="periodList" class="space-y-2"></div>
        </div>
      </div>
    </div>

    <!-- 右: 進行モニター -->
    <div class="space-y-6">
      <div class="bg-white rounded-2xl shadow p-5">
        <h2 class="font-bold mb-3">🎮 進行コントロール</h2>
        <div id="controls" class="grid grid-cols-2 gap-3"></div>
      </div>
      <div id="monitor" class="kanshasai-bg text-white rounded-2xl shadow p-6 min-h-[360px]"></div>
    </div>
  </div>
</div>

<!-- 部署別加減点モーダル -->
<div id="deptAdjustModal" class="hidden fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
  <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-xl max-h-[90vh] overflow-auto">
    <h3 class="font-bold text-lg mb-4">🎯 部署別加減点</h3>
    <div id="deptAdjustContent" class="space-y-3"></div>
    <div class="flex gap-2 mt-4">
      <button onclick="submitDeptAdjust()" class="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white font-bold py-2 rounded-lg">確認</button>
      <button onclick="closeDeptAdjustModal()" class="flex-1 bg-slate-300 hover:bg-slate-400 text-slate-700 font-bold py-2 rounded-lg">キャンセル</button>
    </div>
    <div id="deptAdjustMsg" class="text-sm text-red-500 mt-2"></div>
  </div>
</div>

<!-- 答え変更モーダル -->
<div id="changeAnswerModal" class="hidden fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
  <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-lg">
    <h3 class="font-bold text-lg mb-4">⚡ 答えを変更</h3>
    <div id="changeAnswerContent" class="space-y-3"></div>
    <div class="flex gap-2 mt-4">
      <button onclick="submitChangeAnswer()" class="flex-1 bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 rounded-lg">送信</button>
      <button onclick="closeChangeAnswerModal()" class="flex-1 bg-slate-300 hover:bg-slate-400 text-slate-700 font-bold py-2 rounded-lg">キャンセル</button>
    </div>
    <div id="changeAnswerMsg" class="text-sm text-red-500 mt-2"></div>
  </div>
</div>

<!-- 問題編集モーダル -->
<div id="editModal" class="hidden fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
  <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-auto">
    <h3 class="font-bold text-lg mb-4">✏️ 問題を編集</h3>
    <textarea id="eqtext" rows="2" placeholder="問題文" class="w-full border rounded-lg p-3 mb-2 outline-none focus:ring-2 ring-amber-400"></textarea>
    <div class="flex items-center gap-2 mb-3">
      <span class="text-sm text-slate-600">問題画像:</span>
      <input type="file" accept="image/*" id="eqimgfile" class="hidden" onchange="if(this.files&&this.files[0])uploadEQImg(this.files[0])">
      <button type="button" onclick="triggerEQImg()" class="border border-slate-300 hover:border-slate-500 rounded-lg px-3 py-1.5 text-sm">📷 追加</button>
      <div id="eqimgthumb" class="hidden shrink-0 relative">
        <img id="eqimgprev" src="" class="h-12 max-w-xs object-contain rounded border bg-slate-100">
        <button type="button" onclick="clearEQImg()" class="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-xs rounded-full flex items-center justify-center leading-none">×</button>
      </div>
    </div>
    <textarea id="eqintro" rows="2" placeholder="前振り（アイドリング）— 任意" class="w-full border rounded-lg p-3 mb-3 outline-none focus:ring-2 ring-blue-400 text-sm text-slate-600 resize-none" style="border-style:dashed"></textarea>
    <textarea id="eqreference" rows="1" placeholder="参考情報（正解発表時に司会者が読むセリフ）" class="w-full border rounded-lg p-3 mb-3 outline-none focus:ring-2 ring-green-400 text-sm text-slate-600 resize-none" style="border-style:dashed;background-color:#f0fdf4"></textarea>
    <div class="flex items-center gap-2 mb-3 flex-wrap">
      <span class="text-sm text-slate-600 font-bold">形式:</span>
      <button id="eqtypeSingle" onclick="setEQType('single')" class="px-3 py-1.5 rounded-lg text-sm font-bold border-2 border-amber-400 bg-amber-50 text-amber-700">単択</button>
      <button id="eqtypeRentan" onclick="setEQType('rentan')" class="px-3 py-1.5 rounded-lg text-sm font-bold border border-slate-300 text-slate-500">連単</button>
      <span class="text-slate-300 mx-2">|</span>
      <span class="text-sm text-slate-600 font-bold">選択肢数:</span>
      <button onclick="setEditChoiceN(EDIT_CHOICE_N-1)" class="w-7 h-7 flex items-center justify-center rounded border border-slate-300 hover:bg-slate-100 font-bold text-slate-600">−</button>
      <span id="editChoiceNLabel" class="w-6 text-center font-bold text-slate-800">4</span>
      <button onclick="setEditChoiceN(EDIT_CHOICE_N+1)" class="w-7 h-7 flex items-center justify-center rounded border border-slate-300 hover:bg-slate-100 font-bold text-slate-600">＋</button>
      <div id="editRentanKBox" class="hidden items-center gap-2 ml-2">
        <span class="text-sm text-slate-600 font-bold">何位まで:</span>
        <button onclick="setEditRentanK(EDIT_RENTAN_K-1)" class="w-7 h-7 flex items-center justify-center rounded border border-slate-300 hover:bg-slate-100 font-bold text-slate-600">−</button>
        <span id="editRentanKLabel" class="w-6 text-center font-bold text-slate-800">3</span>
        <button onclick="setEditRentanK(EDIT_RENTAN_K+1)" class="w-7 h-7 flex items-center justify-center rounded border border-slate-300 hover:bg-slate-100 font-bold text-slate-600">＋</button>
        <span class="text-xs text-slate-400">位</span>
      </div>
    </div>
    <div id="editChoiceRows" class="space-y-2 mb-3"></div>
    <div id="editRentanHint" class="hidden text-xs text-blue-600 bg-blue-50 rounded-lg px-3 py-2 mb-3">💡 各選択肢の「順位」ボタンで正解順序を指定してください</div>
    <div class="flex items-center gap-3 mb-4 flex-wrap">
      <label class="text-sm text-slate-600">制限時間</label>
      <input id="etlimit" type="number" min="5" max="120" class="w-20 border rounded-lg p-2 text-center">
      <span class="text-sm text-slate-500">秒</span>
      <label class="text-sm text-slate-600 ml-4">配点</label>
      <input id="eqpoints" type="number" min="1" max="99999" class="w-24 border rounded-lg p-2 text-center">
      <span class="text-sm text-slate-500">点</span>
    </div>
    <div id="editMsg" class="text-sm text-red-500 mb-3"></div>
    <div class="flex gap-3">
      <button onclick="saveEdit()" class="flex-1 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg py-2.5">保存</button>
      <button onclick="closeEdit()" class="flex-1 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold rounded-lg py-2.5">キャンセル</button>
    </div>
  </div>
</div>

<script>
var V=null, CHOICE_N=4, QTYPE='single', RENTAN_K=3, timer=null;
var COLORS=['#1c63e6','#e11d1d','#16a23a','#f0a600','#7c3aed','#db2777','#0891b2','#ea580c','#65a30d','#4f46e5'];
var choiceImgs=new Array(10).fill(null);
var addQuestionImg=null, editQuestionImg=null;
var openPE={}, pendingPQ={};
var rentanCorrect=[];  // rentanCorrect[rankIndex] = choiceIndex (0-based)

function esc(s){ var d=document.createElement('div'); d.textContent=(s==null?'':String(s)); return d.innerHTML; }
function ct(c){ return typeof c==='object'?(c.text||(c.img?'(画像)':'?')):(c==null?'':String(c)); }
function post(url,body){ return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json();}); }

function setQType(t){
  QTYPE=t;
  document.getElementById('qtypeSingle').className='px-3 py-1.5 rounded-lg text-sm font-bold '+(t==='single'?'border-2 border-amber-400 bg-amber-50 text-amber-700':'border border-slate-300 text-slate-500 hover:border-slate-400');
  document.getElementById('qtypeRentan').className='px-3 py-1.5 rounded-lg text-sm font-bold '+(t==='rentan'?'border-2 border-blue-500 bg-blue-50 text-blue-700':'border border-slate-300 text-slate-500 hover:border-slate-400');
  var rkb=document.getElementById('rentanKBox');
  if(t==='rentan'){ rkb.classList.remove('hidden'); rkb.classList.add('flex'); } else { rkb.classList.add('hidden'); rkb.classList.remove('flex'); }
  document.getElementById('rentanHint').classList.toggle('hidden',t!=='rentan');
  document.getElementById('addHint').textContent=t==='rentan'?'順位ボタンで正解順序を指定':'ラジオで正解選択';
  buildChoiceRows();
}
function setChoiceN(n){
  CHOICE_N=Math.max(2,Math.min(10,n));
  if(RENTAN_K>CHOICE_N) setRentanK(CHOICE_N);
  document.getElementById('choiceNLabel').textContent=CHOICE_N;
  buildChoiceRows();
}
function setRentanK(k){
  RENTAN_K=Math.max(1,Math.min(CHOICE_N,k));
  document.getElementById('rentanKLabel').textContent=RENTAN_K;
  rentanCorrect=new Array(RENTAN_K).fill(-1);
  buildChoiceRows();
}

function buildChoiceRows(){
  choiceImgs=new Array(10).fill(null);
  rentanCorrect=new Array(RENTAN_K).fill(-1);
  var box=document.getElementById('choiceRows'); box.innerHTML='';
  for(var i=0;i<CHOICE_N;i++){
    var row=document.createElement('div'); row.className='flex items-center gap-2';
    var rankBtns='';
    if(QTYPE==='rentan'){
      for(var r=0;r<RENTAN_K;r++){
        rankBtns+='<button type="button" data-ci="'+i+'" data-ri="'+r+'" onclick="setRentanRank('+i+','+r+')"'
          +' class="rank-btn text-xs font-bold px-2 py-1 rounded border border-slate-300 text-slate-500 hover:border-blue-400 hover:text-blue-600">'+(r+1)+'位</button>';
      }
    }
    row.innerHTML=(QTYPE==='single'?'<input type="radio" name="correct" value="'+i+'" '+(i===0?'checked':'')+' class="w-5 h-5 accent-emerald-500">'
      :'<span class="w-5 text-center text-xs font-bold text-slate-400">'+(i+1)+'</span>')
      +'<span class="w-4 h-4 rounded-full shrink-0" style="background:'+COLORS[i]+'"></span>'
      +'<input class="cinput flex-1 border rounded-lg p-2 outline-none focus:ring-2 ring-amber-400 text-sm" placeholder="選択肢 '+(i+1)+(i<2?'（必須）':'（任意）')+'">'
      +(QTYPE==='rentan'?'<div class="flex gap-1 shrink-0">'+rankBtns+'</div><div id="rrank'+i+'" class="text-xs font-bold text-blue-600 w-8 text-center shrink-0"></div>':'')
      +'<input type="file" accept="image/*" class="imgfile hidden" data-idx="'+i+'">'
      +'<button type="button" onclick="triggerImg('+i+')" title="画像を追加" class="shrink-0 border border-slate-300 hover:border-slate-500 rounded-lg px-2 py-2 text-sm leading-none">📷</button>'
      +'<div id="ithumb'+i+'" class="hidden shrink-0 relative">'
      +'<img id="iprev'+i+'" src="" class="w-9 h-9 object-cover rounded border">'
      +'<button type="button" onclick="clearImg('+i+')" class="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-xs rounded-full flex items-center justify-center leading-none">×</button>'
      +'</div>';
    box.appendChild(row);
  }
  document.querySelectorAll('.imgfile').forEach(function(inp){
    inp.addEventListener('change',function(){
      var idx=Number(this.dataset.idx);
      if(this.files&&this.files[0]) uploadImg(idx,this.files[0]);
    });
  });
}
function setRentanRank(ci,ri){
  // Clear this rank from any other choice
  for(var k=0;k<CHOICE_N;k++) if(rentanCorrect[ri]===k){ rentanCorrect[ri]=-1; }
  // Clear this choice from any other rank
  for(var r=0;r<RENTAN_K;r++) if(rentanCorrect[r]===ci){ rentanCorrect[r]=-1; }
  rentanCorrect[ri]=ci;
  updateRentanRankDisplay();
}
function updateRentanRankDisplay(){
  for(var i=0;i<CHOICE_N;i++){
    var el=document.getElementById('rrank'+i); if(!el) continue;
    var rank=-1; for(var r=0;r<RENTAN_K;r++) if(rentanCorrect[r]===i){ rank=r; break; }
    el.textContent=rank>=0?(rank+1)+'位':'';
  }
  // Highlight active rank buttons
  document.querySelectorAll('.rank-btn').forEach(function(btn){
    var ci=Number(btn.dataset.ci), ri=Number(btn.dataset.ri);
    var active=(rentanCorrect[ri]===ci);
    btn.className='rank-btn text-xs font-bold px-2 py-1 rounded border '+(active?'border-blue-500 bg-blue-100 text-blue-700':'border-slate-300 text-slate-500 hover:border-blue-400 hover:text-blue-600');
  });
}
function triggerImg(idx){ document.querySelectorAll('.imgfile')[idx].click(); }
function uploadImg(idx,file){
  var reader=new FileReader();
  reader.onload=function(e){
    fetch('/api/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dataUrl:e.target.result,name:file.name})})
      .then(function(r){return r.json();}).then(function(r){
        if(r.ok){
          choiceImgs[idx]=r.url;
          document.getElementById('iprev'+idx).src=r.url;
          document.getElementById('ithumb'+idx).classList.remove('hidden');
        } else { alert('アップロード失敗: '+(r.error||'')); }
      });
  };
  reader.readAsDataURL(file);
}
function clearImg(idx){
  choiceImgs[idx]=null;
  document.getElementById('ithumb'+idx).classList.add('hidden');
  document.getElementById('iprev'+idx).src='';
  document.querySelectorAll('.imgfile')[idx].value='';
}
function triggerQImg(){ document.getElementById('qimgfile').click(); }
function uploadQImg(file){
  var reader=new FileReader();
  reader.onload=function(e){
    fetch('/api/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dataUrl:e.target.result,name:file.name})})
      .then(function(r){return r.json();}).then(function(r){
        if(r.ok){ addQuestionImg=r.url; document.getElementById('qimgprev').src=r.url; document.getElementById('qimgthumb').classList.remove('hidden'); }
        else { alert('アップロード失敗: '+(r.error||'')); }
      });
  };
  reader.readAsDataURL(file);
}
function clearQImg(){ addQuestionImg=null; document.getElementById('qimgthumb').classList.add('hidden'); document.getElementById('qimgprev').src=''; document.getElementById('qimgfile').value=''; }
function triggerEQImg(){ document.getElementById('eqimgfile').click(); }
function uploadEQImg(file){
  var reader=new FileReader();
  reader.onload=function(e){
    fetch('/api/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dataUrl:e.target.result,name:file.name})})
      .then(function(r){return r.json();}).then(function(r){
        if(r.ok){ editQuestionImg=r.url; document.getElementById('eqimgprev').src=r.url; document.getElementById('eqimgthumb').classList.remove('hidden'); }
        else { alert('アップロード失敗: '+(r.error||'')); }
      });
  };
  reader.readAsDataURL(file);
}
function clearEQImg(){ editQuestionImg=null; document.getElementById('eqimgthumb').classList.add('hidden'); document.getElementById('eqimgprev').src=''; document.getElementById('eqimgfile').value=''; }
function addQuestion(){
  var text=document.getElementById('qtext').value.trim();
  var inputs=document.querySelectorAll('.cinput');
  var choices=[];
  for(var i=0;i<inputs.length;i++) choices.push({text:inputs[i].value.trim(),img:choiceImgs[i]||null});
  var filled=choices.filter(function(c){return c.text.length>0||c.img;});
  var tl=Number(document.getElementById('tlimit').value)||20;
  var pts=Math.max(1,Number(document.getElementById('qpoints').value)||100);
  var msg=document.getElementById('addMsg'); msg.textContent='';
  if(!text||filled.length<2){ msg.textContent='問題文・選択肢2つ以上が必要です'; return; }
  var intro=(document.getElementById('qintro')||{}).value||''; intro=intro.trim();
  var reference=(document.getElementById('qreference')||{}).value||''; reference=reference.trim();
  var payload={text:text,img:addQuestionImg||null,intro:intro||null,reference:reference||null,choices:filled,timeLimit:tl,points:pts,type:QTYPE};
  if(QTYPE==='rentan'){
    // Build correctOrder mapping from filled-choices indices to original indices
    var filledIdxMap=[];
    for(var j=0;j<choices.length;j++) if(choices[j].text.length>0||choices[j].img) filledIdxMap.push(j);
    var order=[];
    for(var r=0;r<RENTAN_K;r++){
      var ci=rentanCorrect[r];
      if(ci<0||ci>=choices.length||!(choices[ci].text.length>0||choices[ci].img)){ msg.textContent='連単: '+RENTAN_K+'位まで全て指定してください'; return; }
      order.push(filledIdxMap.indexOf(ci));
    }
    payload.correctOrder=order; payload.rankCount=RENTAN_K;
  } else {
    var correctRadio=document.querySelector('input[name=correct]:checked');
    var correctIdx=correctRadio?Number(correctRadio.value):0;
    var mapped=-1, cnt=0;
    for(var j=0;j<choices.length;j++){ if(choices[j].text.length>0||choices[j].img){ if(j===correctIdx) mapped=cnt; cnt++; } }
    if(mapped<0){ msg.textContent='正解を指定してください'; return; }
    payload.correctIndex=mapped;
  }
  post('/api/admin/addQuestion',payload).then(function(r){
    if(r.ok){ document.getElementById('qtext').value=''; var qi=document.getElementById('qintro'); if(qi) qi.value=''; var qr=document.getElementById('qreference'); if(qr) qr.value=''; clearQImg(); buildChoiceRows(); document.getElementById('qtext').focus(); }
    else msg.textContent=r.error||'追加できませんでした';
  });
}
function delQuestion(id){ post('/api/admin/deleteQuestion',{id:id}).then(function(r){ if(!r.ok && r.error) alert(r.error); }); }

function showDeptAdjustModal(v){
  var content='<p class="text-sm text-slate-600 mb-3">各部署に対して加減点を入力してください（現在のスコアに加算されます）</p>';
  var depts=(v.deptRanking||[]);
  if(depts.length===0){ content+='<div class="text-slate-400 text-sm">部署データがありません</div>'; }
  for(var i=0;i<depts.length;i++){
    var d=depts[i];
    content+='<div class="flex items-center gap-2 mb-2"><label class="text-sm font-bold flex-1">'+esc(d.dept)+'</label>'
      +'<input type="number" class="deptAdj-'+i+'" value="0" class="w-24 border rounded-lg p-2 text-center" /></div>';
  }
  document.getElementById('deptAdjustContent').innerHTML=content;
  document.getElementById('deptAdjustModal').classList.remove('hidden');
}
function closeDeptAdjustModal(){ document.getElementById('deptAdjustModal').classList.add('hidden'); }
function submitDeptAdjust(){
  var depts=(V.deptRanking||[]);
  var adjustments={};
  for(var i=0;i<depts.length;i++){
    var input=document.querySelector('.deptAdj-'+i);
    if(input){ adjustments[depts[i].dept]=Number(input.value)||0; }
  }
  post('/api/admin/adjustDeptScore',{adjustments:adjustments}).then(function(r){
    if(r.ok){ closeDeptAdjustModal(); } else { document.getElementById('deptAdjustMsg').textContent=r.error||'更新できませんでした'; }
  });
}

function showChangeAnswerModal(){
  var q=V.current; if(!q||V.phase!=='question') return alert('出題中のみ利用可能です');
  var content='<p class="text-sm text-slate-600 mb-3">第'+(q.index+1)+'問の答えを変更します：</p>';
  if(q.type==='rentan'){
    content+='<p class="text-sm font-bold mb-2">順位を入力（カンマ区切り）:</p>';
    var currentOrder=(q.correctOrder||[]).map(function(i){return (i+1);}).join(',');
    content+='<input type="text" id="caOrderInput" placeholder="例: 1,3,2" value="'+currentOrder+'" class="w-full border rounded-lg p-2 mb-2" />';
  } else {
    content+='<p class="text-sm font-bold mb-2">正解の選択肢番号を選択:</p>';
    for(var i=0;i<q.choices.length;i++){
      var isC=(i===q.correctIndex);
      content+='<label class="block p-2 mb-2 border rounded-lg cursor-pointer '+(isC?'bg-amber-50 border-amber-300':'bg-slate-50 border-slate-300')+'">'
        +'<input type="radio" name="caCorrect" value="'+i+'" '+(isC?'checked':'')+ ' class="mr-2" /> '
        +'<span class="font-bold">'+(i+1)+'</span> - '+esc(q.choices[i].text||q.choices[i])+'</label>';
    }
  }
  document.getElementById('changeAnswerContent').innerHTML=content;
  document.getElementById('changeAnswerModal').classList.remove('hidden');
}
function closeChangeAnswerModal(){ document.getElementById('changeAnswerModal').classList.add('hidden'); }
function submitChangeAnswer(){
  var q=V.current; if(!q) return;
  var payload={correctIndex:undefined,correctOrder:undefined};
  var msg=document.getElementById('changeAnswerMsg'); msg.textContent='';
  if(q.type==='rentan'){
    var orderStr=(document.getElementById('caOrderInput')||{}).value||'';
    var order=orderStr.split(',').map(function(s){return Number(s.trim())-1;});
    if(order.length<(q.rankCount||3)||order.some(function(i){return i<0||i>=q.choices.length;})){
      msg.textContent='無効な順序です'; return;
    }
    payload.correctOrder=order;
  } else {
    var cr=document.querySelector('input[name=caCorrect]:checked');
    payload.correctIndex=cr?Number(cr.value):0;
  }
  post('/api/admin/updateQuestionAnswer',payload).then(function(r){
    if(r.ok){ closeChangeAnswerModal(); } else { msg.textContent=r.error||'更新できませんでした'; }
  });
}

// コントロールボタン（フェーズに応じて出し分け）
function renderControls(v){
  var c=document.getElementById('controls'); var h='';
  function btn(label,fn,cls){ return '<button onclick="'+fn+'" class="'+cls+' text-white font-bold rounded-lg py-3">'+label+'</button>'; }
  if(v.phase==='lobby'){
    var periods=v.periods||[];
    if(periods.length===0){
      h+='<div class="col-span-2 text-center text-slate-400 text-sm py-2">Periodを作成してから開始してください</div>';
    } else {
      periods.forEach(function(p){
        if(p.questionIds.length>0){
          h+=btn('▶ '+esc(p.name)+' を開始（'+p.questionIds.length+'問）',
            'post(\\'/api/admin/startPeriod\\',{periodId:\\''+p.id+'\\'}).then(function(r){if(!r.ok)alert(r.error||\\'エラー\\');})',
            'col-span-2 bg-emerald-600 hover:bg-emerald-700');
        }
      });
    }
  } else if(v.phase==='question'){
    h+=btn('⏹ 締切・正解発表','post(\\'/api/admin/reveal\\')','col-span-2 bg-red-600 hover:bg-red-700');
  } else if(v.phase==='stats'){
    h+=btn('✅ 正解発表','post(\\'/api/admin/stats\\')','col-span-2 bg-emerald-600 hover:bg-emerald-700');
  } else if(v.phase==='reveal'){
    var ap=(v.periods||[]).find(function(p){return p.id===v.activePeriodId;});
    var isLast=!ap||v.currentIndex+1>=ap.questionIds.length;
    h+=btn('📊 ランキング表示','post(\\'/api/admin/ranking\\')','bg-blue-600 hover:bg-blue-700');
    h+=btn(isLast?'🏆 Period終了':'▶ 次の問題','post(\\'/api/admin/next\\')','bg-emerald-600 hover:bg-emerald-700');
  } else if(v.phase==='ranking'){
    var periods2=v.periods||[];
    periods2.forEach(function(p){
      if(p.questionIds.length>0){
        h+=btn('▶ '+esc(p.name)+' を開始（'+p.questionIds.length+'問）',
          'post(\\'/api/admin/startPeriod\\',{periodId:\\''+p.id+'\\'}).then(function(r){if(!r.ok)alert(r.error||\\'エラー\\');})',
          'col-span-2 bg-emerald-600 hover:bg-emerald-700');
      }
    });
    h+=btn('🎯 部署別加減点','showDeptAdjustModal(V)','col-span-2 bg-blue-600 hover:bg-blue-700 mt-1');
    h+=btn('🎖️ 表彰式を開始','post(\\'/api/admin/award\\')','col-span-2 bg-purple-600 hover:bg-purple-700 mt-1');
    h+=btn('🏁 終了する','post(\\'/api/admin/finish\\')','col-span-2 bg-slate-500 hover:bg-slate-600 mt-1');
  } else if(v.phase==='award'){
    h+=btn('🏁 終了する','post(\\'/api/admin/finish\\')','col-span-2 bg-slate-500 hover:bg-slate-600 mt-1');
  } else if(v.phase==='finished'){
    h+=btn('📥 結果をCSVダウンロード','window.location.href=\\'/api/admin/exportResults\\'','col-span-2 bg-green-600 hover:bg-green-700');
    h+=btn('🔄 もう一度（リセット）','post(\\'/api/admin/reset\\')','col-span-2 bg-slate-600 hover:bg-slate-700 mt-1');
  }
  if(v.phase!=='lobby' && v.phase!=='finished') h+=btn('リセット','if(confirm(\\'ゲームを最初に戻します。よろしいですか？\\'))post(\\'/api/admin/reset\\')','col-span-2 bg-slate-400 hover:bg-slate-500 mt-1');
  var emLabel=v.emergencyMode?'🆘 簡易版モード: ON（解除する）':'🆘 簡易版モードに切替';
  var emCls=v.emergencyMode?'col-span-2 bg-red-700 hover:bg-red-800 mt-1':'col-span-2 bg-orange-600 hover:bg-orange-700 mt-1';
  h+=btn(emLabel,'post(\\'/api/admin/emergency\\')',emCls);
  c.innerHTML=h;
}

function renderQList(v){
  document.getElementById('qCount').textContent=v.questions.length;
  var box=document.getElementById('qlist');
  if(v.questions.length===0){ box.innerHTML='<div class="text-slate-400 text-sm">まだ問題がありません</div>'; return; }
  var canDel=(v.phase==='lobby'||v.phase==='finished');
  var h='';
  for(var i=0;i<v.questions.length;i++){
    var q=v.questions[i]; var cur=(i===v.currentIndex);
    var typeBadge=q.type==='rentan'
      ?'<span class="inline-block text-xs font-bold bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 mr-1">連単'+q.rankCount+'位</span>'
      :'<span class="inline-block text-xs font-bold bg-slate-100 text-slate-600 rounded-full px-2 py-0.5 mr-1">単択</span>';
    var answerInfo;
    if(q.type==='rentan'){
      var orders=(q.correctOrder||[]).map(function(ci,ri){ return (ri+1)+'位:'+esc(ct(q.choices[ci])); }).join(' → ');
      answerInfo='正解順序: '+orders;
    } else {
      answerInfo='正解: '+esc(ct(q.choices[q.correctIndex]));
    }
    h+='<div class="border rounded-lg p-3 '+(cur?'border-amber-400 bg-amber-50':'border-slate-200')+'">'
      + '<div class="flex justify-between gap-2"><div class="font-bold text-sm">'+typeBadge+(i+1)+'. '+esc(q.text)+'</div>'
      + (canDel?'<div class="flex gap-2 shrink-0"><button onclick="openEdit(\\''+q.id+'\\')" class="text-blue-500 hover:text-blue-700 text-sm">編集</button><button onclick="delQuestion(\\''+q.id+'\\')" class="text-red-400 hover:text-red-600 text-sm">削除</button></div>':'')+'</div>'
      + '<div class="text-xs text-slate-500 mt-1">'+answerInfo+' ／ '+q.timeLimit+'秒 ／ '+(q.points||100)+'点</div></div>';
  }
  box.innerHTML=h;
}

function renderPeriods(v){
  var periods=v.periods||[], questions=v.questions||[];
  var box=document.getElementById('periodList'); if(!box) return;
  if(periods.length===0){ box.innerHTML='<div class="text-slate-400 text-xs">まだPeriodがありません</div>'; return; }
  var h='';
  periods.forEach(function(p){
    var qids=pendingPQ[p.id]||p.questionIds;
    var qc=qids.length;
    h+='<div class="border border-slate-600 rounded-lg p-3 bg-slate-800/50">';
    h+='<div class="flex items-center gap-1.5 mb-1">'
      +'<span class="font-bold text-white flex-1 text-sm">'+esc(p.name)+'</span>'
      +'<span class="text-xs text-slate-400 shrink-0">'+qc+'問</span>'
      +'<button onclick="makeScript(\\''+p.id+'\\')\" class="text-xs bg-emerald-700 hover:bg-emerald-600 text-white px-2 py-0.5 rounded">📄台本</button>'
      +'<button onclick="togglePE(\\''+p.id+'\\')\" class="text-xs bg-blue-700 hover:bg-blue-600 text-white px-2 py-0.5 rounded">✏</button>'
      +'<button onclick="delPeriod(\\''+p.id+'\\')\" class="text-xs bg-red-700 hover:bg-red-600 text-white px-2 py-0.5 rounded">✕</button>'
      +'</div>';
    h+='<div id="pe-'+p.id+'" class="hidden mt-2 border-t border-slate-600 pt-2">';
    h+='<input type="text" id="pn-'+p.id+'" value="'+esc(p.name)+'" placeholder="Period名" class="w-full mb-1 bg-slate-700 text-white border border-slate-500 rounded px-2 py-1 text-sm">';
    h+='<textarea id="pt-'+p.id+'" rows="2" placeholder="台本用説明（例：NRIにまつわる2択クイズ）" class="w-full mb-2 bg-slate-700 text-white border border-slate-500 rounded px-2 py-1 text-xs resize-none" style="line-height:1.5">'+esc(p.topic||'')+'</textarea>';
    h+='<div class="text-xs text-slate-300 mb-1 font-bold">出題順 <span class="font-normal text-slate-400">（↑↓で並べ替え・×で除外）</span></div>';
    if(!qids.length) h+='<div class="text-xs text-slate-500 italic px-1 mb-1">（下から追加してください）</div>';
    qids.forEach(function(qid,qi){
      var q=questions.find(function(qq){return qq.id===qid;}); if(!q) return;
      var qt=q.text.length>28?q.text.slice(0,28)+'…':q.text; var tl=q.type==='rentan'?'連単':'単択';
      h+='<div class="flex items-center gap-1 bg-slate-700 rounded px-2 py-1 mb-0.5" data-qid="'+qid+'">'
        +'<span class="text-amber-300 text-xs w-4 text-right shrink-0">'+(qi+1)+'</span>'
        +'<span class="text-xs text-slate-300 flex-1 ml-1 truncate"><span class="inline-block bg-slate-600 rounded px-1 mr-1">'+esc(tl)+'</span>'+esc(qt)+'</span>'
        +'<button onclick="movePQ(\\''+p.id+'\\',\\''+qid+'\\', -1)" class="text-slate-400 hover:text-white text-sm leading-none px-1">↑</button>'
        +'<button onclick="movePQ(\\''+p.id+'\\',\\''+qid+'\\', 1)" class="text-slate-400 hover:text-white text-sm leading-none px-1">↓</button>'
        +'<button onclick="removePQ(\\''+p.id+'\\',\\''+qid+'\\')\" class="text-red-400 hover:text-red-300 text-sm leading-none px-1">×</button>'
        +'</div>';
    });
    var unsel=questions.filter(function(q){ return qids.indexOf(q.id)<0; });
    if(unsel.length){
      h+='<div class="text-xs text-slate-400 mt-1 mb-1">追加する問題：<span class="text-slate-500">（クリックで末尾に追加）</span></div>';
      unsel.forEach(function(q){
        var qt=q.text.length>28?q.text.slice(0,28)+'…':q.text; var tl=q.type==='rentan'?'連単':'単択';
        h+='<div onclick="addPQ(\\''+p.id+'\\',\\''+q.id+'\\')\" class="flex items-center gap-1 rounded px-2 py-0.5 mb-0.5 cursor-pointer hover:bg-slate-600">'
          +'<span class="text-emerald-400 text-xs shrink-0">＋</span>'
          +'<span class="text-xs text-slate-400 ml-1 truncate"><span class="inline-block bg-slate-600 rounded px-1 mr-1">'+esc(tl)+'</span>'+esc(qt)+'</span>'
          +'</div>';
      });
    }
    h+='<button onclick="savePeriod(\\''+p.id+'\\')\" class="mt-2 text-xs bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1 rounded font-bold">保存</button>';
    h+='</div></div>';
  });
  box.innerHTML=h;
  Object.keys(openPE).forEach(function(id){ var el=document.getElementById('pe-'+id); if(el) el.classList.remove('hidden'); });
}
function togglePE(id){
  if(openPE[id]){ delete openPE[id]; delete pendingPQ[id]; } else { openPE[id]=true; }
  renderPeriods(V);
}
function savePeriod(id){
  var nameEl=document.getElementById('pn-'+id); var name=nameEl?nameEl.value:'';
  if(!name.trim()) return;
  var topicEl=document.getElementById('pt-'+id); var topic=topicEl?topicEl.value.trim():'';
  var qids=pendingPQ[id]; if(!qids){ var pp=(V&&V.periods||[]).find(function(p){return p.id===id;}); qids=pp?pp.questionIds:[]; }
  post('/api/admin/updatePeriod',{id:id,name:name.trim(),topic:topic,questionIds:qids}).then(function(r){
    if(!r.ok) alert(r.error); else { delete pendingPQ[id]; togglePE(id); }
  });
}
function addPQ(pid,qid){
  var p=(V&&V.periods||[]).find(function(p){return p.id===pid;}); if(!p) return;
  var cur=(pendingPQ[pid]||p.questionIds).slice(); if(cur.indexOf(qid)<0) cur.push(qid);
  pendingPQ[pid]=cur; openPE[pid]=true; renderPeriods(V);
}
function removePQ(pid,qid){
  var p=(V&&V.periods||[]).find(function(p){return p.id===pid;}); if(!p) return;
  pendingPQ[pid]=(pendingPQ[pid]||p.questionIds).filter(function(id){return id!==qid;});
  openPE[pid]=true; renderPeriods(V);
}
function movePQ(pid,qid,dir){
  var p=(V&&V.periods||[]).find(function(p){return p.id===pid;}); if(!p) return;
  var arr=(pendingPQ[pid]||p.questionIds).slice();
  var idx=arr.indexOf(qid); if(idx<0) return;
  var ni=idx+dir; if(ni<0||ni>=arr.length) return;
  arr.splice(idx,1); arr.splice(ni,0,qid);
  pendingPQ[pid]=arr; openPE[pid]=true; renderPeriods(V);
}
function delPeriod(id){ if(!confirm('このPeriodを削除しますか？')) return; delete openPE[id]; delete pendingPQ[id]; post('/api/admin/deletePeriod',{id:id}); }
function addPeriod(){
  var name=prompt('Period名を入力してください（例: 第1部）');
  if(!name||!name.trim()) return;
  post('/api/admin/addPeriod',{name:name.trim()});
}
function makeScript(pid){
  var period=(V&&V.periods||[]).find(function(p){return p.id===pid;});
  if(!period||!period.questionIds.length){ alert('このPeriodには問題が登録されていません'); return; }
  var questions=V.questions||[];
  var xe=function(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
  var ctxt=function(c){ return c?(typeof c==='object'?(c.text||(c.img?'(画像)':'')):(c||'')):'' };
  var n=period.questionIds.length;
  var pname=xe(period.name);
  var topicText=period.topic?xe(period.topic):('「'+pname+'」');
  var rows='';
  function row(t,who,text){
    if(t==='sep'){ rows+='<tr><td colspan="2" style="padding:6px 0"><hr style="border:none;border-top:1px solid #e2e8f0"></td></tr>'; return; }
    if(t==='head'){ rows+='<tr><td colspan="2" style="padding:8px 14px;background:#fef3c7;border-left:4px solid #f59e0b;font-weight:700;color:#92400e;font-size:14px">'+text+'</td></tr>'; return; }
    if(t==='dir'){ rows+='<tr><td colspan="2" style="padding:3px 14px 3px 28px;color:#9ca3af;font-style:italic;font-size:13px">'+text+'</td></tr>'; return; }
    var clrMap={shima:'#1d4ed8',imada:'#b45309',both:'#7c3aed'};
    var lblMap={shima:'島崎さん役',imada:'今田さん役',both:'今田さん役・島崎さん役'};
    var wclr=clrMap[who]||'#374151'; var wlbl=lblMap[who]||who;
    rows+='<tr><td style="white-space:nowrap;padding:6px 14px 6px 8px;font-weight:700;color:'+wclr+';vertical-align:top;font-size:13px;border-right:2px solid #f3f4f6">'+wlbl+'</td>'
      +'<td style="padding:6px 8px;font-size:15px;line-height:1.8">「'+text+'」</td></tr>';
  }
  // Period開始
  row('head','','（'+pname+' 開始）');
  row('line','shima','全員スタンドアップ！');
  row('line','imada',topicText+'、全'+n+'問です');
  // 各問題
  period.questionIds.forEach(function(qid,qi){
    var q=questions.find(function(qq){return qq.id===qid;}); if(!q) return;
    var isRentan=(q.type==='rentan');
    row('sep');
    row('head','','（'+pname+' Q'+(qi+1)+'）');
    if(q.intro){
      // アイドリング（前振り）あり → 島崎: 前振り → 今田: 問題本文
      row('line','shima','問題です。'+xe(q.intro)+'');
      row('line','imada',xe(q.text)+'　Ready Go！');
    } else {
      // アイドリングなし → 島崎がそのまま読む
      row('line','shima','問題です。'+xe(q.text)+'　Ready Go！');
    }
    row('dir','','（回答時間）');
    row('line','both','アンサーチェック');
    row('dir','','（解答率表示画面）');
    row('line','shima','正解はこちら');
    row('dir','','（正解表示画面）');
    var ans='';
    if(isRentan&&q.correctOrder&&q.correctOrder.length){
      var medals=['1位','2位','3位','4位','5位']; var k=q.rankCount||3; var parts=[];
      for(var ri=0;ri<k;ri++){ var ci=q.correctOrder[ri]; parts.push(medals[ri]+'→'+xe(ctxt(q.choices[ci]))); }
      ans='正解は '+parts.join('、')+' でした';
    } else {
      var ci2=(q.correctIndex||0); ans='正解は 「'+xe(ctxt(q.choices[ci2]))+'」 でした';
    }
    row('line','shima',ans);
    if(q.reference){
      row('dir','','（参考情報）');
      row('line','both',xe(q.reference));
    }
  });
  var html='<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>台本 — '+pname+'</title>'
    +'<style>'
    +'body{font-family:"Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif;max-width:1000px;margin:30px auto;padding:0 28px;color:#1e293b;background:#fff;}'
    +'h1{border-bottom:4px solid #f59e0b;padding-bottom:10px;margin-bottom:6px;font-size:24px;display:flex;align-items:center;gap:10px}'
    +'.subtitle{color:#78716c;font-size:14px;margin-bottom:20px}'
    +'table{width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden}'
    +'tr:nth-child(even){background:#f8fafc}'
    +'@media print{body{margin:0 auto;max-width:none;padding:10px}button{display:none}}'
    +'</style></head><body>'
    +'<h1>📋 台本 — '+pname+'</h1>'
    +'<div class="subtitle">題材: '+topicText+' ／ 全'+n+'問</div>'
    +'<p style="margin-bottom:12px"><button onclick="window.print()" style="background:#f59e0b;border:none;padding:6px 16px;border-radius:6px;font-weight:700;cursor:pointer;font-size:13px">🖨 印刷</button></p>'
    +'<table>'+rows+'</table>'
    +'<p style="margin-top:20px;color:#94a3b8;font-size:12px">生成: '+new Date().toLocaleString('ja-JP')+'</p>'
    +'</body></html>';
  var win=window.open('','_blank');
  if(win){ win.document.write(html); win.document.close(); }
  else{ var b=new Blob([html],{type:'text/html;charset=utf-8'}); var u=URL.createObjectURL(b); window.open(u,'_blank'); setTimeout(function(){URL.revokeObjectURL(u);},10000); }
}

function renderMonitor(v){
  clearInterval(timer);
  var m=document.getElementById('monitor');
  if(v.phase==='lobby'){
    var names=(v.players||[]).map(function(p){return '<span class="inline-block panel-row rounded-lg px-3 py-1 m-1 text-sm">'+(p.dept?'<span class="opacity-60 text-xs">'+esc(p.dept)+'</span> ':'')+esc(p.name)+(p.connected?'':' 💤')+'</span>';}).join('');
    m.innerHTML='<div class="text-center py-6"><div class="text-6xl mb-3">🎬</div>'
      +'<div class="text-2xl font-black mb-1" style="text-shadow:0 0 14px rgba(120,220,255,.6)">参加者を待っています</div>'
      +'<div class="text-cyan-200/80 mb-5">'+v.joinCount+' 人が参加中</div><div>'+(names||'<span class="text-cyan-100/50">まだ誰もいません</span>')+'</div></div>';
    return;
  }
  if(v.phase==='question' || v.phase==='reveal' || v.phase==='stats'){
    var q=v.current; var reveal=(v.phase==='reveal'||v.phase==='stats');
    var isRentan=(q.type==='rentan');
    var NCLR=['n1','n2','n3','n4','n5','n6','n7','n8','n9','n10'];
    var choices='';
    if(isRentan){
      var medals=['🥇','🥈','🥉','4位','5位','6位','7位','8位','9位','10位'];
      if(reveal&&q.correctOrder){
        // Show correct order
        var k=q.rankCount||3;
        for(var ri=0;ri<k;ri++){
          var ci=q.correctOrder[ri];
          choices+='<div class="choice choice-correct px-4 py-3">'
            +'<span class="text-amber-300 font-black w-10 text-center shrink-0">'+medals[ri]+'</span>'
            +'<span class="num '+(NCLR[ci]||NCLR[9])+'">'+(ci+1)+'</span>'
            +'<span class="flex-1 font-bold text-lg">'+esc(ct(q.choices[ci]))+'</span>'
            +'<span class="text-emerald-300 text-xl shrink-0">⭕</span></div>';
        }
      } else {
        for(var i=0;i<q.choices.length;i++){
          choices+='<div class="choice px-4 py-3">'
            +'<span class="num '+(NCLR[i]||NCLR[9])+'">'+(i+1)+'</span>'
            +'<span class="flex-1 font-bold">'+esc(ct(q.choices[i]))+'</span></div>';
        }
      }
    } else {
      var total=0; for(var t=0;t<(q.counts||[]).length;t++) total+=q.counts[t];
      for(var i=0;i<q.choices.length;i++){
        var isC=(i===q.correctIndex);
        var pct= total? Math.round(100*q.counts[i]/total):0;
        var st = reveal ? (isC?'choice-correct':'choice-wrong') : '';
        choices+='<div class="choice '+st+' px-4 py-3">'
          + '<span class="num '+(NCLR[i]||NCLR[9])+'">'+(i+1)+'</span>'
          + '<span class="flex-1 font-bold text-lg">'+(reveal&&isC?'⭕ ':'')+esc(ct(q.choices[i]))+'</span>'
          + '<span class="text-right whitespace-nowrap"><span class="font-black">'+q.counts[i]+'人</span> <span class="text-xs opacity-80">'+pct+'%</span></span></div>';
      }
    }
    var typeBadge=isRentan?'<span class="text-xs bg-blue-500/30 text-blue-200 rounded px-2 py-0.5 mr-2">連単'+q.rankCount+'位</span>':'';
    var apName2=(v.activePeriodId&&v.periods)?((v.periods||[]).find(function(p){return p.id===v.activePeriodId;})||{}).name:null;
    m.innerHTML='<div class="flex justify-between items-center mb-3"><span class="text-cyan-200/80 font-bold">'+(apName2?'<span class="text-xs text-amber-300/70 mr-2">['+esc(apName2)+']</span>':'')+typeBadge+'第'+(q.index+1)+'問 / '+q.total+'</span>'
      + (reveal? '<span class="text-emerald-300 font-black text-xl">'+(v.phase==='stats'?'📊 解答率':'✅ 正解発表')+'</span>' : '<div id="mtimer" class="timer-ball timer-lg">--</div>')+'</div>'
      + '<div class="q-frame mb-4"><div class="q-badge">Q</div><div class="q-pill flex-1 text-2xl min-h-[64px]">'+esc(q.text)+'</div></div>'
      + '<div class="grid grid-cols-1 gap-2">'+choices+'</div>'
      + '<div class="text-right text-cyan-100/70 text-sm mt-3">回答: '+q.answeredCount+' / '+v.joinCount+' 人</div>'
      + (q.reference?'<div class="text-cyan-100/60 text-sm mt-2 pt-2 border-t border-white/20">📝 '+esc(q.reference)+'</div>':'')
      + (!reveal?'<div class="mt-4 pt-3 border-t border-white/20"><button onclick="showChangeAnswerModal()" class="bg-blue-500 hover:bg-blue-600 text-white font-bold px-4 py-2 rounded-lg text-sm">⚡ 答えを変更</button></div>':'');
    if(!reveal){
      var end=Date.now()+q.remainingMs;
      timer=setInterval(function(){
        var rem=Math.max(0,end-Date.now()); var el=document.getElementById('mtimer');
        if(!el){ clearInterval(timer); return; }
        el.textContent=Math.ceil(rem/1000); if(rem<=5000) el.classList.add('urgent');
        if(rem<=0) clearInterval(timer);
      },150);
    }
    return;
  }
  // award ceremony
  if(v.phase==='award'){
    var stepLabels=['🏅 100-81位','🏅 80-61位','🏅 60-41位','🏅 40-21位','🏅 6-20位','🏅 5位','🏅 4位','🏅 3位','🏅 2位','🏅 1位','🏢 部3位','🏢 部2位','🏢 部1位'];
    var step=v.awardStep||0;
    var award='<div class="text-center"><div class="text-6xl mb-2">🎖️</div><div class="text-3xl font-black mb-4" style="text-shadow:0 0 14px rgba(120,220,255,.6)">表彰式</div>';
    if(step>=0 && step<=4){
      var ranks=[{label:'100-81位',range:[81,100]},{label:'80-61位',range:[61,80]},{label:'60-41位',range:[41,60]},{label:'40-21位',range:[21,40]},{label:'6-20位',range:[6,20]}];
      var r=ranks[step];
      award+='<div class="text-2xl font-bold text-amber-300 mb-4">'+r.label+'</div><div class="grid grid-cols-1 gap-2 max-h-[300px] overflow-auto">';
      for(var i=0;i<(v.ranking||[]).length;i++){
        var p=v.ranking[i]; var rank=i+1;
        if(rank>=r.range[0] && rank<=r.range[1]){
          award+='<div class="flex items-center gap-3 rounded-xl p-3 panel-row"><span class="w-8 text-center font-black">#'+rank+'</span>'
            +'<div class="flex-1 min-w-0"><div class="font-bold truncate">'+esc(p.name)+'</div>'+(p.dept?'<div class="text-xs opacity-60">'+esc(p.dept)+'</div>':'')+'</div>'
            +'<span class="font-black">'+p.score+'pt</span></div>';
        }
      }
      award+='</div>';
    } else if(step>=5 && step<=9){
      var isteps=[5,4,3,2,1]; var irank=isteps[step-5];
      var medals=['🥇','🥈','🥉'];
      award+='<div class="text-2xl font-bold text-amber-300 mb-4">#'+irank+'位</div>';
      var p=(v.ranking||[])[irank-1];
      if(p){
        var medalIdx=irank===1?0:(irank===2?1:2);
        award+='<div class="flex items-center justify-center gap-4 mt-4"><span class="text-6xl">'+medals[medalIdx]+'</span>'
          +'<div><div class="text-4xl font-black text-amber-300">'+esc(p.name)+'</div>'
          +'<div class="text-lg text-cyan-200">'+(p.dept||'')+' · '+p.score+'pt</div></div></div>';
      }
    } else if(step>=10 && step<=12){
      var dsteps=[{label:'1位',idx:0},{label:'2位',idx:1},{label:'3位',idx:2}]; var ds=dsteps[step-10];
      award+='<div class="text-2xl font-bold text-amber-300 mb-4">部別'+ds.label+'</div>';
      var drank=(v.deptRanking||[])[ds.idx];
      if(drank){
        award+='<div class="flex items-center justify-center gap-4 mt-4"><span class="text-6xl">'+['🥉','🥈','🥇'][ds.idx]+'</span>'
          +'<div><div class="text-4xl font-black text-amber-300">'+esc(drank.dept)+'</div>'
          +'<div class="text-lg text-cyan-200">'+drank.count+'人 · 合計 '+drank.total+'pt</div></div></div>';
      }
    }
    award+='</div><div class="mt-4 pt-3 border-t border-white/20"><button onclick="post(\\'/api/admin/nextAward\\',{}).then(function(){});" class="w-full bg-amber-500 hover:bg-amber-600 text-white font-bold py-2 rounded-lg">次へ</button></div>';
    if(step<stepLabels.length-1) award+='<div class="text-center text-sm text-cyan-200 mt-2">'+stepLabels[step]+' → '+stepLabels[step+1]+'</div>';
    m.innerHTML=award;
    return;
  }
  // ranking / finished
  if(typeof window.adminRankTab==='undefined') window.adminRankTab='player';
  var medal=['🥇','🥈','🥉'];
  var atabs='<div class="flex gap-2 mb-3">'
    +'<button onclick="window.adminRankTab=\\'player\\';renderMonitor(V)" class="flex-1 py-1.5 rounded-lg text-sm font-bold transition-colors '+(window.adminRankTab==='player'?'bg-amber-400 text-slate-900':'bg-white/10 text-white/70 hover:bg-white/20')+'">👤 個人</button>'
    +'<button onclick="window.adminRankTab=\\'dept\\';renderMonitor(V)" class="flex-1 py-1.5 rounded-lg text-sm font-bold transition-colors '+(window.adminRankTab==='dept'?'bg-amber-400 text-slate-900':'bg-white/10 text-white/70 hover:bg-white/20')+'">🏢 部署</button>'
    +'</div>';
  var acontent='';
  if(window.adminRankTab==='player'){
    var list=v.ranking||[]; var rows='';
    for(var i=0;i<Math.min(list.length,10);i++){
      var p=list[i];
      rows+='<div class="flex items-center gap-3 rounded-xl p-3 '+(i<3?'gold-row':'panel-row')+'">'
        +'<span class="w-8 text-center font-black text-lg">'+(i<3?medal[i]:(i+1))+'</span>'
        +'<div class="flex-1 min-w-0"><div class="font-bold truncate">'+esc(p.name)+'</div>'
        +(p.dept?'<div class="text-xs opacity-70 truncate">'+esc(p.dept)+'</div>':'')
        +'</div>'
        +'<span class="font-black tabular-nums shrink-0">'+p.score+' pt</span></div>';
    }
    acontent='<div class="grid grid-cols-1 gap-2">'+(rows||'<div class="text-cyan-100/60 text-center">データなし</div>')+'</div>';
  } else {
    var dlist=v.deptRanking||[]; var drows='';
    for(var i=0;i<dlist.length;i++){
      var d=dlist[i];
      var baseAvg=d.adjustment?Math.round(d.avg - d.adjustment / d.count):d.avg;
      var avgText=d.avg+'<span class="text-xs font-normal text-white/60"> pt/人</span>';
      if(d.adjustment) avgText+='<div class="text-xs text-cyan-300 mt-1">('+baseAvg+'pt + '+Math.round(d.adjustment/d.count)+'pt加点)</div>';
      drows+='<div class="flex items-center gap-3 rounded-xl p-3 '+(i<3?'gold-row':'panel-row')+'">'
        +'<span class="w-8 text-center font-black text-lg shrink-0">'+(i<3?medal[i]:(i+1))+'</span>'
        +'<div class="flex-1 min-w-0"><div class="font-bold truncate">'+esc(d.dept)+'</div>'
        +'<div class="text-xs opacity-70">'+d.count+'人 · 合計 '+d.total+'pt</div></div>'
        +'<div class="text-right shrink-0 font-black tabular-nums text-amber-300">'+avgText+'</div></div>';
    }
    acontent='<div class="grid grid-cols-1 gap-2">'+(drows||'<div class="text-cyan-100/60 text-center">データなし</div>')+'</div>';
  }
  m.innerHTML='<div class="text-center mb-2 pt-2"><div class="text-4xl">'+(v.phase==='finished'?'🏆':'📊')+'</div>'
    +'<div class="text-2xl font-black" style="text-shadow:0 0 14px rgba(120,220,255,.6)">'+(v.phase==='finished'?'最終結果':'ランキング')+'</div></div>'
    +atabs+acontent;
}

var PHASE_LABEL={lobby:'待機中',question:'出題中',reveal:'正解発表',stats:'解答率表示',ranking:'ランキング',finished:'終了'};
var PHASE_CLR={lobby:'bg-slate-200',question:'bg-red-100 text-red-700',reveal:'bg-emerald-100 text-emerald-700',stats:'bg-purple-100 text-purple-700',ranking:'bg-blue-100 text-blue-700',finished:'bg-amber-100 text-amber-700'};

// ===== 音声 =====
var A_LAST_PHASE=null, A_LAST_QI=-1, A_MUTED=false, A_CDN_TIMER=null, A_LOOP_HANDLER=null;
function snd(id){ return document.getElementById(id); }
function sndPlay(id){ if(A_MUTED) return; var a=snd(id); if(!a) return; a.currentTime=0; a.play().catch(function(){}); }
function sndLoopClear(a){ if(A_LOOP_HANDLER&&a){ a.removeEventListener('timeupdate',A_LOOP_HANDLER); A_LOOP_HANDLER=null; } }
function sndStop(id){ var a=snd(id); if(!a) return; if(id==='snd-countdown'){ clearTimeout(A_CDN_TIMER); sndLoopClear(a); } a.loop=false; a.pause(); a.currentTime=0; }
function sndTick(v){
  var ph=v.phase, qi=v.currentIndex;
  if(ph===A_LAST_PHASE && (ph!=='question'||qi===A_LAST_QI)) return; // 変化なし
  if(ph==='lobby'){ clearTimeout(A_CDN_TIMER); sndStop('snd-countdown'); sndStop('snd-fanfare'); sndPlay('snd-bgm'); }
  else if(ph==='question'){
    sndStop('snd-bgm'); sndStop('snd-fanfare');
    if(qi!==A_LAST_QI||A_LAST_PHASE!=='question'){
      clearTimeout(A_CDN_TIMER);
      if(!A_MUTED){
        var ca=snd('snd-countdown');
        if(ca){
          var rem=v.current&&v.current.remainingMs!=null?v.current.remainingMs:(v.current&&v.current.timeLimit?v.current.timeLimit*1000:20000);
          sndLoopClear(ca); ca.loop=false; ca.currentTime=0;
          var setupLoop=function(){
            var dur=ca.duration||10;
            var ls=dur*0.15, le=dur*0.85;
            // 中間部分（15%〜85%）をループ
            A_LOOP_HANDLER=function(){ if(ca.currentTime>=le) ca.currentTime=ls; };
            ca.addEventListener('timeupdate',A_LOOP_HANDLER);
            // 末尾効果音（85%〜100%）を必ず再生するため、アウトロ分前にループ解除→末尾へシーク
            var outroDurMs=(dur-le)*1000;
            var switchAt=rem-outroDurMs;
            if(switchAt>100){
              A_CDN_TIMER=setTimeout(function(){ sndLoopClear(ca); ca.currentTime=le; }, switchAt);
            }
          };
          if(ca.readyState>=1) setupLoop(); else ca.addEventListener('loadedmetadata',setupLoop,{once:true});
          ca.play().catch(function(){});
        }
      }
    }
  }
  else if(ph==='stats'){ clearTimeout(A_CDN_TIMER); sndStop('snd-countdown'); }
  else if(ph==='reveal'){ clearTimeout(A_CDN_TIMER); sndStop('snd-countdown'); sndStop('snd-bgm'); sndPlay('snd-fanfare'); }
  else if(ph==='ranking'||ph==='finished'){ clearTimeout(A_CDN_TIMER); sndStop('snd-countdown'); sndStop('snd-bgm'); if(A_LAST_PHASE!=='ranking'&&A_LAST_PHASE!=='finished') sndPlay('snd-fanfare'); }
  A_LAST_PHASE=ph; A_LAST_QI=qi;
}
function toggleMute(){
  A_MUTED=!A_MUTED;
  if(A_MUTED){ sndStop('snd-bgm'); sndStop('snd-countdown'); sndStop('snd-fanfare'); }
  var btn=document.getElementById('muteBtn'); if(btn){ btn.textContent=A_MUTED?'🔇 ミュート中':'🔊 音声オン'; btn.className='text-xs border rounded px-2 py-1 '+(A_MUTED?'bg-red-100 text-red-600 border-red-300':'bg-emerald-50 text-emerald-700 border-emerald-300'); }
}

function render(v){
  V=v;
  sndTick(v);
  var badge=document.getElementById('phaseBadge');
  var phaseTxt=PHASE_LABEL[v.phase]||v.phase;
  if(v.activePeriodId&&v.periods){
    var ap=(v.periods||[]).find(function(p){return p.id===v.activePeriodId;});
    if(ap) phaseTxt+=' ['+ap.name+']';
  }
  badge.textContent=phaseTxt; badge.className='px-4 py-2 rounded-full text-sm font-bold '+PHASE_CLR[v.phase];
  document.getElementById('joinCount').textContent=v.joinCount;
  renderControls(v); renderQList(v); renderPeriods(v); renderMonitor(v);
}

var LAN_URL='';
function getPub(){ try{ return (localStorage.getItem('kq_pub')||'').trim(); }catch(e){ return ''; } }
function renderJoinUrl(){
  var pub=getPub();
  var url = pub || LAN_URL;
  var link=document.getElementById('joinLink'); link.href=url; link.textContent=url;
  var qr=document.getElementById('qr'); qr.innerHTML='';
  try{ new QRCode(qr,{text:url,width:120,height:120}); }catch(e){ qr.textContent='(QR表示不可)'; }
  var hint=document.getElementById('joinHint');
  hint.innerHTML = pub
    ? '<span class="text-emerald-600 font-bold">公開URL使用中</span> — どのネットワークからでも参加できます'
    : '同じWiFiのスマホでQRを読むか、リンクを開いてください';
  var inp=document.getElementById('puburl'); if(inp && document.activeElement!==inp) inp.value=pub;
}
function applyJoinUrl(){
  var inp=document.getElementById('puburl'); var v=inp.value.trim();
  if(v && !/^https?:\\/\\//i.test(v)) v='https://'+v;
  try{ localStorage.setItem('kq_pub', v); }catch(e){}
  fetch('/api/admin/setpub',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pubUrl:v})}).catch(function(){});
  renderJoinUrl();
}
function clearJoinUrl(){
  try{ localStorage.removeItem('kq_pub'); }catch(e){}
  fetch('/api/admin/setpub',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pubUrl:''})}).catch(function(){});
  renderJoinUrl();
}
function setupJoin(){
  fetch('/api/info').then(function(r){return r.json();}).then(function(info){ LAN_URL=info.joinUrl; renderJoinUrl(); });
}

// ===== 問題編集モーダル =====
var editId=null, editChoiceImgs=new Array(10).fill(null);
var EDIT_CHOICE_N=4, EDIT_QTYPE='single', EDIT_RENTAN_K=3, editRentanCorrect=[];

function setEQType(t){
  EDIT_QTYPE=t;
  document.getElementById('eqtypeSingle').className='px-3 py-1.5 rounded-lg text-sm font-bold '+(t==='single'?'border-2 border-amber-400 bg-amber-50 text-amber-700':'border border-slate-300 text-slate-500');
  document.getElementById('eqtypeRentan').className='px-3 py-1.5 rounded-lg text-sm font-bold '+(t==='rentan'?'border-2 border-blue-500 bg-blue-50 text-blue-700':'border border-slate-300 text-slate-500');
  var rkb=document.getElementById('editRentanKBox');
  if(t==='rentan'){ rkb.classList.remove('hidden'); rkb.classList.add('flex'); } else { rkb.classList.add('hidden'); rkb.classList.remove('flex'); }
  document.getElementById('editRentanHint').classList.toggle('hidden',t!=='rentan');
  buildEditChoiceRows(getEditChoiceValues(),EDIT_QTYPE==='single'?getEditCorrectIdx():-1);
}
function setEditChoiceN(n){
  EDIT_CHOICE_N=Math.max(2,Math.min(10,n));
  if(EDIT_RENTAN_K>EDIT_CHOICE_N) setEditRentanK(EDIT_CHOICE_N);
  document.getElementById('editChoiceNLabel').textContent=EDIT_CHOICE_N;
  buildEditChoiceRows(getEditChoiceValues(),EDIT_QTYPE==='single'?getEditCorrectIdx():-1);
}
function setEditRentanK(k){
  EDIT_RENTAN_K=Math.max(1,Math.min(EDIT_CHOICE_N,k));
  document.getElementById('editRentanKLabel').textContent=EDIT_RENTAN_K;
  editRentanCorrect=new Array(EDIT_RENTAN_K).fill(-1);
  buildEditChoiceRows(getEditChoiceValues(),-1);
}
function getEditChoiceValues(){
  var vals=[]; document.querySelectorAll('.ecinput').forEach(function(x){ vals.push(x.value); }); return vals;
}
function getEditCorrectIdx(){
  var cr=document.querySelector('input[name=ecorrect]:checked'); return cr?Number(cr.value):0;
}

function openEdit(qid){
  var q=(V&&V.questions||[]).find(function(q){ return q.id===qid; });
  if(!q) return;
  editId=qid;
  EDIT_QTYPE=q.type||'single';
  EDIT_CHOICE_N=q.choices.length;
  EDIT_RENTAN_K=q.rankCount||3;
  editRentanCorrect=q.correctOrder?q.correctOrder.slice():new Array(EDIT_RENTAN_K).fill(-1);
  document.getElementById('editChoiceNLabel').textContent=EDIT_CHOICE_N;
  document.getElementById('editRentanKLabel').textContent=EDIT_RENTAN_K;
  // Set type buttons
  document.getElementById('eqtypeSingle').className='px-3 py-1.5 rounded-lg text-sm font-bold '+(EDIT_QTYPE==='single'?'border-2 border-amber-400 bg-amber-50 text-amber-700':'border border-slate-300 text-slate-500');
  document.getElementById('eqtypeRentan').className='px-3 py-1.5 rounded-lg text-sm font-bold '+(EDIT_QTYPE==='rentan'?'border-2 border-blue-500 bg-blue-50 text-blue-700':'border border-slate-300 text-slate-500');
  var rkb=document.getElementById('editRentanKBox');
  if(EDIT_QTYPE==='rentan'){ rkb.classList.remove('hidden'); rkb.classList.add('flex'); } else { rkb.classList.add('hidden'); rkb.classList.remove('flex'); }
  document.getElementById('editRentanHint').classList.toggle('hidden',EDIT_QTYPE!=='rentan');
  document.getElementById('eqtext').value=q.text;
  var eqintroEl=document.getElementById('eqintro'); if(eqintroEl) eqintroEl.value=q.intro||'';
  var eqrefEl=document.getElementById('eqreference'); if(eqrefEl) eqrefEl.value=q.reference||'';
  editQuestionImg=q.img||null;
  document.getElementById('eqimgprev').src=editQuestionImg||'';
  document.getElementById('eqimgthumb').classList.toggle('hidden',!editQuestionImg);
  document.getElementById('etlimit').value=q.timeLimit;
  document.getElementById('eqpoints').value=q.points||100;
  document.getElementById('editMsg').textContent='';
  buildEditChoiceRows(q.choices.map(function(c){ return ct(c); }),EDIT_QTYPE==='single'?q.correctIndex:-1,q.choices.map(function(c){ return typeof c==='object'?c.img:null; }));
  document.getElementById('editModal').classList.remove('hidden');
}
function closeEdit(){
  document.getElementById('editModal').classList.add('hidden');
  editId=null;
}
function buildEditChoiceRows(choiceTexts,correctIdx,imgs){
  editChoiceImgs=new Array(10).fill(null);
  var box=document.getElementById('editChoiceRows'); box.innerHTML='';
  for(var i=0;i<EDIT_CHOICE_N;i++){
    var txt=choiceTexts&&i<choiceTexts.length?choiceTexts[i]:'';
    var img=imgs&&i<imgs.length?imgs[i]:null;
    editChoiceImgs[i]=img;
    var rankBtns='';
    if(EDIT_QTYPE==='rentan'){
      for(var r=0;r<EDIT_RENTAN_K;r++){
        rankBtns+='<button type="button" data-ci="'+i+'" data-ri="'+r+'" onclick="setEditRentanRank('+i+','+r+')"'
          +' class="erank-btn text-xs font-bold px-2 py-1 rounded border border-slate-300 text-slate-500 hover:border-blue-400 hover:text-blue-600">'+(r+1)+'位</button>';
      }
    }
    var row=document.createElement('div'); row.className='flex items-center gap-2';
    row.innerHTML=(EDIT_QTYPE==='single'?'<input type="radio" name="ecorrect" value="'+i+'" class="w-5 h-5 accent-emerald-500">'
      :'<span class="w-5 text-center text-xs font-bold text-slate-400">'+(i+1)+'</span>')
      +'<span class="w-4 h-4 rounded-full shrink-0" style="background:'+COLORS[i]+'"></span>'
      +'<input class="ecinput flex-1 border rounded-lg p-2 outline-none focus:ring-2 ring-amber-400 text-sm" placeholder="選択肢 '+(i+1)+'">'
      +(EDIT_QTYPE==='rentan'?'<div class="flex gap-1 shrink-0">'+rankBtns+'</div><div id="errank'+i+'" class="text-xs font-bold text-blue-600 w-8 text-center shrink-0"></div>':'')
      +'<input type="file" accept="image/*" class="eimgfile hidden" data-idx="'+i+'">'
      +'<button type="button" onclick="triggerEditImg('+i+')" class="shrink-0 border border-slate-300 hover:border-slate-500 rounded-lg px-2 py-2 text-sm">📷</button>'
      +'<div id="eithumb'+i+'" class="'+(img?'':'hidden')+' shrink-0 relative">'
      +'<img id="eiprev'+i+'" src="'+(img||'')+'" class="w-9 h-9 object-cover rounded border">'
      +'<button type="button" onclick="clearEditImg('+i+')" class="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-xs rounded-full flex items-center justify-center leading-none">×</button>'
      +'</div>';
    box.appendChild(row);
    row.querySelector('.ecinput').value=txt;
    if(EDIT_QTYPE==='single' && i===correctIdx && row.querySelector('input[type=radio]')) row.querySelector('input[type=radio]').checked=true;
  }
  document.querySelectorAll('.eimgfile').forEach(function(inp){
    inp.addEventListener('change',function(){
      var idx=Number(this.dataset.idx);
      if(this.files&&this.files[0]) uploadEditImg(idx,this.files[0]);
    });
  });
  if(EDIT_QTYPE==='rentan') updateEditRentanRankDisplay();
}
function setEditRentanRank(ci,ri){
  for(var r=0;r<EDIT_RENTAN_K;r++) if(editRentanCorrect[r]===ci) editRentanCorrect[r]=-1;
  editRentanCorrect[ri]=ci;
  updateEditRentanRankDisplay();
}
function updateEditRentanRankDisplay(){
  for(var i=0;i<EDIT_CHOICE_N;i++){
    var el=document.getElementById('errank'+i); if(!el) continue;
    var rank=-1; for(var r=0;r<EDIT_RENTAN_K;r++) if(editRentanCorrect[r]===i){ rank=r; break; }
    el.textContent=rank>=0?(rank+1)+'位':'';
  }
  document.querySelectorAll('.erank-btn').forEach(function(btn){
    var ci=Number(btn.dataset.ci), ri=Number(btn.dataset.ri);
    var active=(editRentanCorrect[ri]===ci);
    btn.className='erank-btn text-xs font-bold px-2 py-1 rounded border '+(active?'border-blue-500 bg-blue-100 text-blue-700':'border-slate-300 text-slate-500 hover:border-blue-400 hover:text-blue-600');
  });
}
function triggerEditImg(idx){ document.querySelectorAll('.eimgfile')[idx].click(); }
function uploadEditImg(idx,file){
  var reader=new FileReader();
  reader.onload=function(e){
    fetch('/api/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dataUrl:e.target.result,name:file.name})})
      .then(function(r){return r.json();}).then(function(r){
        if(r.ok){ editChoiceImgs[idx]=r.url; document.getElementById('eiprev'+idx).src=r.url; document.getElementById('eithumb'+idx).classList.remove('hidden'); }
        else { alert('アップロード失敗: '+(r.error||'')); }
      });
  };
  reader.readAsDataURL(file);
}
function clearEditImg(idx){
  editChoiceImgs[idx]=null;
  document.getElementById('eithumb'+idx).classList.add('hidden');
  document.getElementById('eiprev'+idx).src='';
  document.querySelectorAll('.eimgfile')[idx].value='';
}
function saveEdit(){
  var text=document.getElementById('eqtext').value.trim();
  var inputs=document.querySelectorAll('.ecinput');
  var choices=[];
  for(var i=0;i<inputs.length;i++) choices.push({text:inputs[i].value.trim(),img:editChoiceImgs[i]||null});
  var filled=choices.filter(function(c){ return c.text.length>0||c.img; });
  var tl=Number(document.getElementById('etlimit').value)||20;
  var pts=Math.max(1,Number(document.getElementById('eqpoints').value)||100);
  var msg=document.getElementById('editMsg'); msg.textContent='';
  if(!text||filled.length<2){ msg.textContent='問題文・選択肢2つ以上が必要です'; return; }
  var eintro=(document.getElementById('eqintro')||{}).value||''; eintro=eintro.trim();
  var ereference=(document.getElementById('eqreference')||{}).value||''; ereference=ereference.trim();
  var payload={id:editId,text:text,img:editQuestionImg||null,intro:eintro||null,reference:ereference||null,choices:filled,timeLimit:tl,points:pts,type:EDIT_QTYPE};
  if(EDIT_QTYPE==='rentan'){
    var filledIdxMap=[];
    for(var j=0;j<choices.length;j++) if(choices[j].text.length>0||choices[j].img) filledIdxMap.push(j);
    var order=[];
    for(var r=0;r<EDIT_RENTAN_K;r++){
      var ci=editRentanCorrect[r];
      if(ci<0||ci>=choices.length||!(choices[ci].text.length>0||choices[ci].img)){ msg.textContent='連単: '+EDIT_RENTAN_K+'位まで全て指定してください'; return; }
      order.push(filledIdxMap.indexOf(ci));
    }
    payload.correctOrder=order; payload.rankCount=EDIT_RENTAN_K;
  } else {
    var cr=document.querySelector('input[name=ecorrect]:checked');
    var correctIdx=cr?Number(cr.value):0;
    var mapped=-1, cnt=0;
    for(var j=0;j<choices.length;j++){ if(choices[j].text.length>0||choices[j].img){ if(j===correctIdx) mapped=cnt; cnt++; } }
    if(mapped<0){ msg.textContent='正解を指定してください'; return; }
    payload.correctIndex=mapped;
  }
  post('/api/admin/editQuestion',payload).then(function(r){
    if(r.ok){ closeEdit(); } else { msg.textContent=r.error||'保存できませんでした'; }
  });
}

buildChoiceRows();
setupJoin();
var adminEs=null, adminRetry=null;
function connectAdmin(){
  if(adminEs){ try{ adminEs.close(); }catch(e){} }
  clearTimeout(adminRetry);
  adminEs=new EventSource('/events?role=admin');
  adminEs.onmessage=function(ev){ try{ render(JSON.parse(ev.data)); }catch(e){} };
  adminEs.onerror=function(){ try{ adminEs.close(); }catch(e){} clearTimeout(adminRetry); adminRetry=setTimeout(connectAdmin, 800+Math.random()*3000); };
}
connectAdmin();
</script>
</body>
</html>`;

// ===========================================================================
// 投影ディスプレイページ（プロジェクター用フルスクリーン）
// ===========================================================================
const PRESENT_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>感謝祭クイズ 投影</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
  ${KANSHA_CSS}
  html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}
  #app{width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;position:relative}
  @keyframes rankIn{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}
  .rank-in{animation:rankIn .4s ease both}
</style>
</head>
<body class="kanshasai-bg text-white">
<div class="starfield" style="position:fixed"></div>
<span class="spark" style="left:5%;top:8%;font-size:28px">✦</span>
<span class="spark" style="left:93%;top:15%;font-size:18px;animation-delay:.5s">✦</span>
<span class="spark" style="left:8%;top:78%;font-size:16px;animation-delay:1.1s">✦</span>
<span class="spark" style="left:90%;top:72%;font-size:24px;animation-delay:.3s">✦</span>
<span class="spark" style="left:48%;top:4%;font-size:14px;animation-delay:.9s">✦</span>
<div id="start" onclick="activate()" style="position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:99;cursor:pointer">
  <div style="text-align:center">
    <div style="font-size:72px;margin-bottom:20px">🎉</div>
    <div style="font-size:36px;font-weight:900;text-shadow:0 0 24px rgba(120,220,255,.8)">クリックして投影開始</div>
    <div style="font-size:16px;color:rgba(180,220,255,.7);margin-top:12px">http://localhost:${PORT}/present</div>
  </div>
</div>
<div id="app"></div>
<div id="floatQR" style="position:fixed;top:16px;left:16px;z-index:20;background:white;border-radius:14px;padding:10px 10px 6px;display:none;box-shadow:0 4px 20px rgba(0,0,0,.5)">
  <div id="floatQRcode"></div>
  <div style="text-align:center;font-size:12px;color:#334155;margin-top:4px;font-weight:700">参加はこちら ↑</div>
</div>
<script>
var timerIv=null, es=null, retry=null;
var _qrBuilt=false;
function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
function ct(c){return typeof c==='object'?(c.text||''):(c==null?'':String(c));}
function ensureFloatQR(url){
  if(!url||_qrBuilt) return;
  _qrBuilt=true;
  var el=document.getElementById('floatQRcode');
  if(el) try{new QRCode(el,{text:url,width:130,height:130});}catch(e){el.textContent=url;}
}
function showFloatQR(show){
  var el=document.getElementById('floatQR'); if(el) el.style.display=show?'block':'none';
}
function activate(){
  document.getElementById('start').style.display='none';
  connect();
}
function connect(){
  if(es){try{es.close();}catch(e){}}
  clearTimeout(retry);
  es=new EventSource('/events?role=present');
  es.onmessage=function(ev){try{render(JSON.parse(ev.data));}catch(e){}};
  es.onerror=function(){try{es.close();}catch(e){}clearTimeout(retry);retry=setTimeout(connect,2000+Math.random()*2000);};
}
function render(v){
  var ph=v.phase;
  var url=v.pubUrl||v.joinUrl||'';
  ensureFloatQR(url);
  if(ph==='lobby'){showFloatQR(false);drawLobby(v);}
  else if(ph==='question'){showFloatQR(true);drawQuestion(v);}
  else if(ph==='stats'){
    showFloatQR(true);
    if(v.current&&v.current.type==='rentan')drawRentanStats(v);
    else drawStats(v);
  }
  else if(ph==='reveal'){
    showFloatQR(true);
    if(v.current&&v.current.type==='rentan')drawRentanReveal(v);
    else drawReveal(v);
  }
  else if(ph==='ranking'||ph==='finished'){showFloatQR(true);drawRanking(v,ph==='finished');}
  else if(ph==='award'){showFloatQR(false);drawAward(v);}
}
var NC=['n1','n2','n3','n4','n5','n6','n7','n8','n9','n10'];
function drawLobby(v){
  clearInterval(timerIv);
  var url=v.pubUrl||v.joinUrl||'';
  document.getElementById('app').innerHTML=
    '<div style="text-align:center;position:relative;z-index:10;padding:4vh 5vw">'
    +'<div style="font-size:4.8vw;font-weight:900;letter-spacing:2px;text-shadow:0 0 28px rgba(100,210,255,.9);margin-bottom:1vh">コンサル本部 感謝祭クイズ</div>'
    +'<div style="font-size:2vw;color:#b0e0ff;margin-bottom:4vh">チームで戦え！部対抗リアルタイムクイズ</div>'
    +'<div id="qrW" style="background:white;padding:18px;border-radius:14px;display:inline-block;margin-bottom:3vh"></div>'
    +'<div style="font-size:2vw;color:#c8e8ff;margin-bottom:2vh">↑ QRコードで参加！</div>'
    +'<div style="font-size:3vw;font-weight:700;color:#ffe07a">参加者 <span id="jcnt">'+v.joinCount+'</span> 人 待機中</div>'
    +'</div>';
  setTimeout(function(){
    var w=document.getElementById('qrW');
    if(w&&url){try{new QRCode(w,{text:url,width:280,height:280});}catch(e){w.textContent=url;}}
  },40);
}
function drawQuestion(v){
  var q=v.current;if(!q)return;
  var n=q.choices.length;
  var cols=n>6?2:1;
  var fsize=n>6?'1.9vw':'2.5vw';
  var numW=n>6?'3.8vw':'5vw';
  var numF=n>6?'1.7vw':'2.3vw';
  var cpad=n>6?'1vh 1.5vw':'1.5vh 2vw';
  var half=Math.ceil(n/2);
  var col1='',col2='',rows='';
  for(var i=0;i<n;i++){
    var txt=ct(q.choices[i]);
    var nc=NC[i]||NC[9];
    var el='<div class="choice" style="padding:'+cpad+';font-size:'+fsize+';border-radius:16px;margin-bottom:1.2vh;cursor:default;display:flex;align-items:center;gap:1.2vw">'
      +'<span class="num '+nc+'" style="width:'+numW+';height:'+numW+';font-size:'+numF+';flex-shrink:0">'+(i+1)+'</span>'
      +'<span style="flex:1;font-weight:700;line-height:1.3">'+esc(txt)+'</span>'
      +'</div>';
    if(cols===2){ if(i<half) col1+=el; else col2+=el; } else rows+=el;
  }
  var isRentan=q.type==='rentan';
  var typeBadge=isRentan?'<span style="font-size:1.5vw;font-weight:700;color:#93c5fd;background:rgba(30,60,160,.6);border:1px solid rgba(100,150,255,.5);padding:4px 14px;border-radius:8px;margin-right:1vw">連単'+q.rankCount+'位</span>':'';
  document.getElementById('app').innerHTML=
    '<div style="width:96vw;position:relative;z-index:10">'
    +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2vh">'
    +'<span style="font-size:2.2vw;font-weight:700;color:#9ac8ff">'+typeBadge+'第'+(q.index+1)+'問 / '+q.total+'問中</span>'
    +'<div id="pt" class="timer-ball" style="width:9vw;height:9vw;font-size:5.5vw;flex-shrink:0">--</div>'
    +'</div>'
    +'<div class="q-frame" style="margin-bottom:1.5vh;padding:1.8vw">'
    +'<div class="q-badge" style="width:6.5vw;font-size:4.2vw;border-radius:16px">Q</div>'
    +'<div class="q-pill" style="font-size:2.8vw;padding:2vw 2.5vw;min-height:8vh;line-height:1.4">'+esc(q.text)+'</div>'
    +'</div>'
    +(q.img?'<div style="text-align:center;margin-bottom:1.5vh"><img src="'+q.img+'" style="max-height:28vh;max-width:80vw;object-fit:contain;border-radius:12px"></div>':'')
    +(cols===2
      ?'<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 2vw"><div>'+col1+'</div><div>'+col2+'</div></div>'
      :'<div>'+rows+'</div>')
    +'</div>';
  startTimer(q.remainingMs,q.timeLimit*1000);
}
function drawStats(v){
  clearInterval(timerIv);
  var q=v.current;if(!q)return;
  var counts=q.counts||q.choices.map(function(){return 0;});
  var total=counts.reduce(function(a,b){return a+b;},0);
  var rows='';
  for(var i=0;i<q.choices.length;i++){
    var cnt=counts[i]||0,pct=total>0?Math.round(cnt/total*100):0;
    var nc=NC[i]||NC[9];
    rows+='<div style="display:flex;align-items:center;gap:1.5vw;margin-bottom:1.5vh">'
      +'<span class="num '+nc+'" style="width:4.2vw;height:4.2vw;font-size:2.1vw;flex-shrink:0">'+(i+1)+'</span>'
      +'<div style="flex:1">'
      +'<div style="font-size:2.1vw;font-weight:700;margin-bottom:0.4vh">'+esc(ct(q.choices[i]))+'</div>'
      +'<div style="background:rgba(255,255,255,.15);border-radius:8px;height:2.5vh;overflow:hidden">'
      +'<div style="height:100%;width:'+pct+'%;background:linear-gradient(90deg,#4fb8ff,#1c7ae8);border-radius:8px;transition:width .5s"></div></div>'
      +'<span style="font-size:1.7vw;color:#9fd8ff">'+cnt+'票 ('+pct+'%)</span></div></div>';
  }
  document.getElementById('app').innerHTML=
    '<div style="width:96vw;position:relative;z-index:10">'
    +'<div style="font-size:2.6vw;font-weight:700;color:#ffe07a;text-align:center;margin-bottom:2.5vh">解答状況 — '+(q.answeredCount||0)+'人回答中</div>'
    +'<div class="q-frame" style="margin-bottom:1.5vh;padding:1.8vw">'
    +'<div class="q-badge" style="width:5.8vw;font-size:3.6vw">Q</div>'
    +'<div class="q-pill" style="font-size:2.5vw;padding:1.6vw 2vw">'+esc(q.text)+'</div></div>'
    +(q.img?'<div style="text-align:center;margin-bottom:1.5vh"><img src="'+q.img+'" style="max-height:20vh;max-width:70vw;object-fit:contain;border-radius:10px"></div>':'')
    +'<div>'+rows+'</div></div>';
}
function drawReveal(v){
  clearInterval(timerIv);
  var q=v.current;if(!q)return;
  var n=q.choices.length, cols=n>6?2:1, fsize=n>6?'1.9vw':'2.5vw', half=Math.ceil(n/2);
  var numW=n>6?'3.8vw':'5vw', numF=n>6?'1.7vw':'2.3vw', cpad=n>6?'1vh 1.5vw':'1.5vh 2vw';
  var col1='',col2='',rows='';
  for(var i=0;i<n;i++){
    var ok=(i===q.correctIndex), nc=NC[i]||NC[9];
    var el='<div class="choice '+(ok?'choice-correct':'choice-wrong')+'" style="padding:'+cpad+';font-size:'+fsize+';border-radius:16px;margin-bottom:1.2vh;cursor:default;display:flex;align-items:center;gap:1.2vw">'
      +'<span class="num '+nc+'" style="width:'+numW+';height:'+numW+';font-size:'+numF+';flex-shrink:0">'+(i+1)+'</span>'
      +'<span style="flex:1;font-weight:700;line-height:1.3">'+esc(ct(q.choices[i]))+'</span>'
      +(ok?'<span style="font-size:3.5vw;flex-shrink:0">✅</span>':'')
      +'</div>';
    if(cols===2){ if(i<half) col1+=el; else col2+=el; } else rows+=el;
  }
  document.getElementById('app').innerHTML=
    '<div style="width:96vw;position:relative;z-index:10">'
    +'<div style="text-align:center;font-size:3.5vw;font-weight:900;color:#4ade80;text-shadow:0 0 22px rgba(74,222,128,.8);margin-bottom:2.5vh">正解は… 「'+esc(ct(q.choices[q.correctIndex]))+'」！</div>'
    +(cols===2?'<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 2vw"><div>'+col1+'</div><div>'+col2+'</div></div>':'<div>'+rows+'</div>')
    +(q.reference?'<div style="text-align:center;font-size:2.2vw;color:#a7f3d0;margin-top:3vh;padding:2vh;border-top:2px solid rgba(167,243,208,.3)">📝 '+esc(q.reference)+'</div>':'')
    +'</div>';
}
function drawRentanReveal(v){
  clearInterval(timerIv);
  var q=v.current;if(!q)return;
  var k=q.rankCount||3, medals=['🥇','🥈','🥉','4位','5位','6位','7位','8位','9位','10位'];
  var answerRows='';
  for(var ri=0;ri<k;ri++){
    var ci=q.correctOrder[ri];
    answerRows+='<div class="choice choice-correct" style="padding:1.6vw 2.5vw;font-size:2.6vw;border-radius:16px;margin-bottom:1.2vh;cursor:default;display:flex;align-items:center;gap:1.5vw">'
      +'<span style="font-size:3.2vw;flex-shrink:0">'+medals[ri]+'</span>'
      +'<span class="num '+(NC[ci]||NC[9])+'" style="width:4.2vw;height:4.2vw;font-size:2.1vw;flex-shrink:0">'+(ci+1)+'</span>'
      +'<span style="flex:1;font-weight:700;line-height:1.3">'+esc(ct(q.choices[ci]))+'</span>'
      +'<span style="font-size:3.2vw;flex-shrink:0">✅</span>'
      +'</div>';
  }
  document.getElementById('app').innerHTML=
    '<div style="width:96vw;position:relative;z-index:10">'
    +'<div style="text-align:center;font-size:3.5vw;font-weight:900;color:#4ade80;text-shadow:0 0 22px rgba(74,222,128,.8);margin-bottom:2.5vh">正解順序 発表！</div>'
    +'<div>'+answerRows+'</div>'
    +(q.reference?'<div style="text-align:center;font-size:2.2vw;color:#a7f3d0;margin-top:3vh;padding:2vh;border-top:2px solid rgba(167,243,208,.3)">📝 '+esc(q.reference)+'</div>':'')
    +'</div>';
}
function drawRentanStats(v){
  clearInterval(timerIv);
  var q=v.current;if(!q)return;
  var k=q.rankCount||3;
  document.getElementById('app').innerHTML=
    '<div style="width:96vw;position:relative;z-index:10;text-align:center">'
    +'<div style="font-size:3.2vw;font-weight:700;color:#ffe07a;margin-bottom:2.5vh">連単問題 解答中…</div>'
    +'<div class="q-frame" style="margin-bottom:1.5vh;padding:2vw">'
    +'<div class="q-badge" style="width:6.5vw;font-size:4vw">連単</div>'
    +'<div class="q-pill" style="font-size:2.6vw;padding:1.8vw 2.2vw">'+esc(q.text)+'</div></div>'
    +(q.img?'<div style="text-align:center;margin-bottom:1.5vh"><img src="'+q.img+'" style="max-height:22vh;max-width:72vw;object-fit:contain;border-radius:10px"></div>':'')
    +'<div style="font-size:2.3vw;color:#b0e0ff;">'+k+'位まで予測！ — '+(q.answeredCount||0)+'人が回答済み</div>'
    +'</div>';
}
function drawRanking(v,isFinal){
  clearInterval(timerIv);
  var dept=v.deptRanking||[],rnk=v.ranking||[];
  var drows='';
  for(var i=0;i<Math.min(dept.length,8);i++){
    var d=dept[i],top=(i===0);
    var bg=top?'background:linear-gradient(90deg,#ffd76a,#f0a500);color:#3a2600;':'background:rgba(255,255,255,.09);color:#eaf2ff;border:1px solid rgba(255,255,255,.14);';
    var med=i===0?'🥇':i===1?'🥈':i===2?'🥉':(i+1)+'位';
    drows+='<div class="rank-in" style="display:flex;align-items:center;gap:1.4vw;padding:1.2vh 1.8vw;border-radius:12px;margin-bottom:1vh;'+bg+'animation-delay:'+(i*.1)+'s">'
      +'<span style="font-size:2.2vw;width:4vw;text-align:center">'+med+'</span>'
      +'<span style="flex:1;font-size:2.2vw;font-weight:700">'+esc(d.dept)+'</span>'
      +'<span style="font-size:2.2vw;font-weight:900">'+d.avg+'<span style="font-size:1.3vw;font-weight:400">点/人</span></span>'
      +'</div>';
  }
  var prows='';
  for(var j=0;j<Math.min(rnk.length,8);j++){
    var p=rnk[j];
    var pbg=j===0?'background:linear-gradient(90deg,#ffd76a,#f0a500);color:#3a2600;':'background:rgba(255,255,255,.09);color:#eaf2ff;border:1px solid rgba(255,255,255,.14);';
    var pmed=j===0?'🥇':j===1?'🥈':j===2?'🥉':(j+1)+'位';
    prows+='<div style="display:flex;align-items:center;gap:1vw;padding:0.9vh 1.4vw;border-radius:10px;margin-bottom:0.8vh;font-size:1.8vw;'+pbg+'">'
      +'<span style="width:3.5vw;text-align:center;font-weight:900">'+pmed+'</span>'
      +'<span style="flex:1;font-weight:700">'+esc(p.name)+'</span>'
      +'<span style="font-size:1.2vw;opacity:.7">'+esc(p.dept||'')+'</span>'
      +'<span style="font-weight:900">'+p.score+'pt</span>'
      +'</div>';
  }
  document.getElementById('app').innerHTML=
    '<div style="width:96vw;position:relative;z-index:10">'
    +'<div style="text-align:center;font-size:4.2vw;font-weight:900;color:#ffe07a;margin-bottom:2.5vh;text-shadow:0 0 26px rgba(255,220,100,.7)">'+(isFinal?'🏆 最終結果発表！':'部対抗ランキング')+'</div>'
    +'<div style="display:grid;grid-template-columns:3fr 2fr;gap:3vw;align-items:start">'
    +'<div><div style="font-size:1.8vw;font-weight:700;color:#9ac8ff;border-left:4px solid #4fb8ff;padding-left:1.2vw;margin-bottom:1.5vh">部対抗ランキング</div>'+drows+'</div>'
    +'<div><div style="font-size:1.8vw;font-weight:700;color:#9ac8ff;border-left:4px solid #ffe07a;padding-left:1.2vw;margin-bottom:1.5vh">個人TOP8</div>'+prows+'</div>'
    +'</div></div>';
}
function drawAward(v){
  clearInterval(timerIv);
  var step=v.awardStep||0;
  var medals=['🥇','🥈','🥉'];
  var app='<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;z-index:10;padding:4vh 5vw;text-align:center">';
  if(step>=0 && step<=4){
    var ranks=[{label:'100-81位',range:[81,100]},{label:'80-61位',range:[61,80]},{label:'60-41位',range:[41,60]},{label:'40-21位',range:[21,40]},{label:'6-20位',range:[6,20]}];
    var r=ranks[step];
    app+='<div style="font-size:5vw;font-weight:900;color:#ffe07a;margin-bottom:3vh;text-shadow:0 0 28px rgba(255,220,100,.8)">🏅 '+r.label+'</div>';
    app+='<div style="width:90vw;max-height:70vh;overflow-y:auto;display:grid;gap:1.2vh">';
    for(var i=0;i<(v.ranking||[]).length;i++){
      var p=v.ranking[i]; var rank=i+1;
      if(rank>=r.range[0] && rank<=r.range[1]){
        app+='<div class="rank-in" style="display:flex;align-items:center;gap:1.4vw;padding:1.2vh 1.8vw;border-radius:12px;background:rgba(255,255,255,.09);color:#eaf2ff;border:1px solid rgba(255,255,255,.14);animation-delay:'+(rank*.05)+'s">'
          +'<span style="font-size:2vw;width:4vw;text-align:center;font-weight:900">#'+rank+'</span>'
          +'<span style="flex:1;font-size:2vw;font-weight:700;text-align:left">'+esc(p.name)+'</span>'
          +'<span style="font-size:1.8vw;font-weight:900;color:#fbbf24">'+p.score+'pt</span>'
          +'</div>';
      }
    }
    app+='</div>';
  } else if(step>=5 && step<=9){
    var isteps=[5,4,3,2,1]; var irank=isteps[step-5];
    var p=(v.ranking||[])[irank-1];
    var medalIdx={5:2,4:2,3:2,2:1,1:0}[irank]||2;
    app+='<div style="font-size:4vw;margin-bottom:3vh">'+medals[medalIdx]+'</div>';
    app+='<div style="font-size:3vw;font-weight:900;color:#ffe07a;margin-bottom:2vh">第 '+irank+' 位</div>';
    if(p){
      app+='<div style="font-size:3vw;font-weight:700;margin-bottom:1vh">'+esc(p.name)+'</div>';
      app+='<div style="font-size:2vw;color:#9ac8ff;margin-bottom:2vh">'+esc(p.dept||'')+'</div>';
      app+='<div style="font-size:2.8vw;font-weight:900;color:#fbbf24">'+p.score+'pt</div>';
    }
  } else if(step>=10 && step<=12){
    var dsteps=[{label:'1位',idx:0},{label:'2位',idx:1},{label:'3位',idx:2}]; var ds=dsteps[step-10];
    var drank=(v.deptRanking||[])[ds.idx];
    app+='<div style="font-size:4vw;margin-bottom:3vh">'+medals[ds.idx]+'</div>';
    app+='<div style="font-size:3vw;font-weight:900;color:#ffe07a;margin-bottom:2vh">部別 '+ds.label+'</div>';
    if(drank){
      var baseAvg=drank.adjustment?Math.round(drank.avg - drank.adjustment / drank.count):drank.avg;
      var adjPerPerson=drank.adjustment?Math.round(drank.adjustment/drank.count):0;
      app+='<div style="font-size:3vw;font-weight:700;margin-bottom:1vh">'+esc(drank.dept)+'</div>';
      app+='<div style="font-size:2vw;color:#9ac8ff;margin-bottom:1vh">'+drank.count+'人 · 合計 '+drank.total+'pt</div>';
      app+='<div style="font-size:2.4vw;font-weight:900;color:#fbbf24">'+drank.avg+'点/人</div>';
      if(drank.adjustment) app+='<div style="font-size:1.6vw;color:#a7f3d0;margin-top:1vh">（'+baseAvg+'点 + '+adjPerPerson+'点加点）</div>';
    }
  }
  app+='</div>';
  document.getElementById('app').innerHTML=app;
}
function startTimer(ms,totalMs){
  clearInterval(timerIv);
  var end=Date.now()+ms;
  function tick(){
    var left=Math.max(0,end-Date.now()),s=Math.ceil(left/1000);
    var el=document.getElementById('pt');
    if(el){el.textContent=s;if(s<=5)el.classList.add('urgent');else el.classList.remove('urgent');}
    if(left<=0)clearInterval(timerIv);
  }
  tick();
  timerIv=setInterval(tick,200);
}
</script>
</body>
</html>`;

// ===========================================================================
// EMERGENCY_HTML — SSE 不要のポーリング版簡易参加ページ
// CDN・Tailwind なし。inline CSS のみで動作。
// ===========================================================================
const EMERGENCY_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>感謝祭クイズ（簡易版）</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;padding:12px 16px;max-width:480px;margin:0 auto;min-height:100dvh}
.hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding:10px 14px;background:rgba(255,255,255,.08);border-radius:10px;gap:8px}
.hd-name{font-size:13px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hd-score{font-weight:900;color:#fbbf24;font-size:18px;white-space:nowrap}
.qlabel{font-size:12px;color:#64748b;margin-bottom:4px}
.qtimer{text-align:right;font-size:13px;color:#64748b;margin-bottom:6px}
.qtxt{background:rgba(255,255,255,.07);border-radius:10px;padding:14px;margin-bottom:14px;font-size:16px;font-weight:bold;line-height:1.5}
.btn{display:block;width:100%;padding:14px 16px;margin-bottom:10px;background:#1d4ed8;color:#fff;border:none;border-radius:10px;font-size:16px;text-align:left;cursor:pointer;font-weight:bold;-webkit-tap-highlight-color:transparent;transition:background .1s}
.btn:active{background:#1e40af;transform:scale(.98)}
.btn:disabled{background:#1e293b;color:#475569;cursor:default;transform:none}
.btn.sel{background:#059669}
.btn.reset{background:#475569;font-size:14px;padding:10px}
.wait{text-align:center;color:#475569;padding:60px 20px;font-size:15px}
.ok{background:rgba(5,150,105,.15);border:1px solid rgba(5,150,105,.5);border-radius:10px;padding:14px;text-align:center;font-weight:bold;color:#34d399;margin-bottom:12px}
.res{background:rgba(255,255,255,.06);border-radius:10px;padding:14px;margin-bottom:12px}
.good{color:#4ade80;font-size:20px;font-weight:bold}
.bad{color:#f87171;font-size:20px;font-weight:bold}
.ca{font-size:14px;color:#94a3b8;margin-top:8px;line-height:1.5}
.picks-box{background:rgba(255,255,255,.05);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:13px;color:#93c5fd;min-height:36px}
.myrank{background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.4);border-radius:10px;padding:12px;text-align:center;font-weight:bold;color:#fbbf24;margin-bottom:12px;font-size:18px}
.rk-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.07);font-size:14px}
.rk-me{color:#fbbf24;font-weight:bold}
.bdg{display:inline-block;background:rgba(255,255,255,.1);border-radius:4px;padding:1px 5px;font-size:11px;color:#94a3b8;margin-left:4px}
.footer{text-align:center;font-size:11px;color:#334155;margin-top:20px;padding-bottom:16px}
</style>
</head>
<body>
<div id="app"><p class="wait">接続中...</p></div>
<script>
var sp=new URLSearchParams(location.search);
var pid=sp.get('id')||localStorage.getItem('kq_id');
var pname=(sp.get('name')||localStorage.getItem('kq_name')||'ゲスト');
var pdept=(sp.get('dept')||localStorage.getItem('kq_dept')||'');
if(!pid){pid='e'+Math.random().toString(36).slice(2);}
try{localStorage.setItem('kq_id',pid);}catch(e){}
var app=document.getElementById('app');
var picks=[];
var lastQid=null;
var lastV=null;
var pollTimer=null;

function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
function ct(c){return c&&typeof c==='object'?(c.text||''):(c==null?'':String(c));}

function poll(){
  var url='/api/view?id='+encodeURIComponent(pid)+'&name='+encodeURIComponent(pname)+'&dept='+encodeURIComponent(pdept);
  fetch(url).then(function(r){return r.json();}).then(function(v){
    if(v.phase==='question'&&v.q&&v.q.id!==lastQid){picks=[];lastQid=v.q.id;}
    lastV=v;
    render(v);
  }).catch(function(){});
}

function render(v){
  if(!v.emergencyMode){
    clearInterval(pollTimer);
    window.location.replace('/?id='+encodeURIComponent(pid)+'&name='+encodeURIComponent(pname)+'&dept='+encodeURIComponent(pdept));
    return;
  }
  var ph=v.phase, me=v.me||{};
  var html='<div class="hd"><span class="hd-name">👤 '+esc(me.name||pname)+(me.dept?'<span class="bdg">'+esc(me.dept)+'</span>':'')+'</span><span class="hd-score">'+(me.score||0)+' pt</span></div>';
  if(ph==='lobby'){
    html+='<p class="wait">⏳ 開始まで待ちましょう</p>';
  } else if(ph==='question'&&v.q){
    var q=v.q, isAns=v.myAnswer!=null;
    html+='<div class="qlabel">第'+(q.index+1)+'問 / '+q.total+'</div>';
    if(q.remainingMs>0) html+='<div class="qtimer">残り '+Math.ceil(q.remainingMs/1000)+' 秒</div>';
    html+='<div class="qtxt">'+esc(q.text)+'</div>';
    if(isAns){
      html+='<div class="ok">✅ 回答済み！結果を待ってね</div>';
    } else if(q.type==='rentan'){
      html+=buildRentan(q);
    } else {
      for(var i=0;i<q.choices.length;i++){
        html+='<button class="btn" onclick="submitSingle('+i+')">'+(i+1)+'. '+esc(ct(q.choices[i]))+'</button>';
      }
    }
  } else if(ph==='reveal'||ph==='stats'){
    html+=buildReveal(v, ph==='reveal');
  } else if(ph==='ranking'||ph==='finished'){
    html+=buildRanking(v);
  } else {
    html+='<p class="wait">しばらくお待ちください...</p>';
  }
  html+='<p class="footer"><a href="/?id='+encodeURIComponent(pid)+'&name='+encodeURIComponent(pname)+'&dept='+encodeURIComponent(pdept)+'" style="color:#94a3b8;text-decoration:underline">通常版に戻る</a>&nbsp;&nbsp;|&nbsp;&nbsp;簡易表示モード</p>';
  app.innerHTML=html;
}

function buildRentan(q){
  var k=q.rankCount||3, medals=['1位','2位','3位','4位','5位','6位','7位','8位','9位','10位'];
  var pickText=picks.length>0?picks.map(function(pi,ri){return medals[ri]+': '+esc(ct(q.choices[pi]));}).join(' / '):'（まだ選択していません）';
  var h='<div class="picks-box">選択中: '+pickText+'</div>';
  for(var i=0;i<q.choices.length;i++){
    var ri=picks.indexOf(i), sel=ri>=0;
    h+='<button class="btn'+(sel?' sel':'')+'" onclick="rentanTap('+i+')">'+(sel?'【'+medals[ri]+'】 ':'')+(i+1)+'. '+esc(ct(q.choices[i]))+'</button>';
  }
  if(picks.length>0) h+='<button class="btn reset" onclick="picks=[];if(lastV)render(lastV)">↩ リセット</button>';
  return h;
}

function buildReveal(v, showAns){
  var q=v.q||{}, r=v.reveal||{};
  var h='<div class="res">';
  if(v.myAnswer==null){
    h+='<div class="bad">😴 未回答</div>';
  } else if(showAns){
    h+=r.myCorrect?'<div class="good">🎯 正解！ +'+r.myPoints+' pt</div>':'<div class="bad">😢 不正解…</div>';
  } else {
    h+='<div style="color:#94a3b8">📊 集計中...</div>';
  }
  if(showAns){
    if(q.type==='rentan'&&q.correctOrder&&q.choices){
      var medals=['1位','2位','3位','4位','5位'];
      var ans=q.correctOrder.map(function(ci,ri){return (medals[ri]||((ri+1)+'位'))+': '+esc(ct(q.choices[ci]));}).join('　');
      h+='<div class="ca">正解: '+ans+'</div>';
    } else if(q.type!=='rentan'&&q.correctIndex!=null&&q.choices){
      h+='<div class="ca">正解: '+esc(ct(q.choices[q.correctIndex]))+'</div>';
    }
  }
  h+='</div>';
  return h;
}

function buildRanking(v){
  var h='';
  if(v.myRank) h+='<div class="myrank">あなたの順位: '+v.myRank+' 位</div>';
  var rk=v.ranking||[];
  for(var i=0;i<rk.length;i++){
    var r=rk[i], isMe=r.id===pid;
    h+='<div class="rk-row'+(isMe?' rk-me':'')+'"><span>'+r.rank+'位 '+esc(r.name)+(r.dept?'<span class="bdg">'+esc(r.dept)+'</span>':'')+'</span><span>'+r.score+' pt</span></div>';
  }
  return h;
}

function submitSingle(idx){
  document.querySelectorAll('.btn').forEach(function(b){b.disabled=true;});
  fetch('/api/answer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:pid,choice:idx})})
    .then(function(){clearInterval(pollTimer);poll();pollTimer=setInterval(poll,2500);}).catch(function(){});
}

function rentanTap(ci){
  if(!lastV||!lastV.q) return;
  var k=lastV.q.rankCount||3, ri=picks.indexOf(ci);
  if(ri>=0){picks.splice(ri,1);}
  else if(picks.length<k){picks.push(ci);}
  render(lastV);
  if(picks.length===k){
    document.querySelectorAll('.btn').forEach(function(b){b.disabled=true;});
    fetch('/api/answer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:pid,choices:picks.slice()})})
      .then(function(){clearInterval(pollTimer);poll();pollTimer=setInterval(poll,2500);}).catch(function(){});
  }
}

poll();
pollTimer=setInterval(poll,2500);
</script>
</body>
</html>`;
