// 負荷テスト: 参加者N人（既定450）がスマホから同時参加 → 出題 → 一斉回答 → 発表 → ランキング
// → 全員一斉切断・再接続（Wi-Fi瞬断の想定）までを1台で再現する。
//
//   node loadtest.js --url http://localhost:3003 --players 450 --period <periodId> [--questions 3] [--pid <サーバーのPID>]
//   トンネル経由で測るとき（管理操作は実際と同じくローカルから行う）:
//   node loadtest.js --url https://xxxx-3999.jpe1.devtunnels.ms --admin-url http://localhost:3999 --players 450 --period <periodId>
//
// ※ 管理者操作（reset / startPeriod / reveal / next / ranking）を実際に叩くので、本番中のサーバーには使わないこと。

const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const BASE = new URL(args.url || 'http://localhost:3003');
const ADMIN_BASE = new URL(args['admin-url'] || BASE.href);
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
function target(base) {
  const lib = base.protocol === 'https:' ? https : http;
  return { lib, host: base.hostname, port: base.port || (base.protocol === 'https:' ? 443 : 80) };
}
// 失敗理由の集計（例: "429×120, ECONNRESET×3"）
function why(list) {
  const m = {};
  list.forEach((r) => { const k = r.err || r.status; m[k] = (m[k] || 0) + 1; });
  return Object.keys(m).map((k) => k + '×' + m[k]).join(', ');
}
const N = Number(args.players) || 450;
const PERIOD = args.period;
const MAX_Q = Number(args.questions) || Infinity;
const PID = args.pid;
const RAMP_MS = Number(args.ramp || 0); // 0 = 全員同時（最悪ケース）
if (!PERIOD) { console.error('--period <periodId> が必要です'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => { if (!arr.length) return NaN; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const fmt = (arr) => arr.length ? `p50=${pct(arr, .5)}ms p95=${pct(arr, .95)}ms p99=${pct(arr, .99)}ms max=${Math.max(...arr)}ms (n=${arr.length})` : '(n=0)';

// ---- サーバー資源のサンプリング ----
const samples = [];
let sampler = null;
function startSampler() {
  if (!PID) return;
  sampler = setInterval(() => {
    try {
      const [cpu, rss] = execSync(`ps -o %cpu=,rss= -p ${PID}`).toString().trim().split(/\s+/).map(Number);
      samples.push({ cpu, rssMB: Math.round(rss / 1024) });
    } catch (e) {}
  }, 250);
}

// ---- HTTP ----
function request(method, path, body, base) {
  const t = target(base || BASE);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'User-Agent': UA };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = t.lib.request({
      host: t.host, port: t.port, path, method, agent: false, headers,
    }, (res) => {
      let n = 0; const chunks = [];
      res.on('data', (c) => { n += c.length; chunks.push(c); });
      res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, ms: Date.now() - t0, bytes: n, body: Buffer.concat(chunks).toString() }));
    });
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, err: e.code || e.message, ms: Date.now() - t0 }));
    if (data) req.write(data);
    req.end();
  });
}
const admin = (action, body) => request('POST', '/api/admin/' + action, body || {}, ADMIN_BASE);

// ---- SSE クライアント ----
class SseClient {
  constructor(qs, base) { this.qs = qs; this.base = base || BASE; this.last = null; this.listeners = []; this.bytes = 0; this.msgs = 0; this.maxMsg = 0; this.errors = 0; }
  connect() {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let first = true;
      const t = target(this.base);
      this.req = t.lib.get({ host: t.host, port: t.port, path: '/events?' + this.qs, agent: false, headers: { 'User-Agent': UA, Accept: 'text/event-stream' } }, (res) => {
        // 429 やログイン画面への転送など、SSE 以外が返ってきたら失敗として扱う
        if (res.statusCode !== 200 || !String(res.headers['content-type'] || '').includes('text/event-stream')) {
          res.resume();
          if (first) { first = false; resolve({ ok: false, status: res.statusCode, ms: Date.now() - t0 }); }
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          this.bytes += c.length;
          buf += c;
          let k;
          while ((k = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, k); buf = buf.slice(k + 2);
            if (!frame.startsWith('data: ')) continue;
            this.msgs++; this.maxMsg = Math.max(this.maxMsg, frame.length);
            try { this.last = JSON.parse(frame.slice(6)); } catch (e) { continue; }
            if (first) { first = false; resolve({ ok: true, ms: Date.now() - t0 }); }
            this.listeners.slice().forEach((fn) => fn(this.last));
          }
        });
        res.on('error', () => {});
      });
      this.req.on('error', (e) => { this.errors++; if (first) { first = false; resolve({ ok: false, err: e.code || e.message, ms: Date.now() - t0 }); } });
      this.req.setTimeout(20000, () => { if (first) this.req.destroy(new Error('timeout')); });
    });
  }
  waitFor(pred, timeout) {
    if (this.last && pred(this.last)) return Promise.resolve(0);
    const t0 = Date.now();
    return new Promise((resolve) => {
      const fn = (v) => { if (pred(v)) { done(); resolve(Date.now() - t0); } };
      const done = () => { clearTimeout(timer); this.listeners = this.listeners.filter((f) => f !== fn); };
      const timer = setTimeout(() => { done(); resolve(null); }, timeout);
      this.listeners.push(fn);
    });
  }
  close() { try { this.req.destroy(); } catch (e) {} }
}

const report = [];
function log(title, line) { const s = `  ${title.padEnd(28)} ${line}`; console.log(s); report.push(s); }

// 全員が条件を満たすまでの到達時間（管理者操作の直前から計測）
async function fanout(title, players, pred, action, body) {
  const waits = players.map((p) => { p.last = null; return p.waitFor(pred, 15000); });
  // 以前の状態で即満たされないよう、待機登録後に操作する
  const t0 = Date.now();
  const r = await admin(action, body);
  const res = await Promise.all(waits);
  const got = res.filter((x) => x !== null).map((x) => x + 0);
  const miss = res.length - got.length;
  log(title, `管理操作 ${r.ms}ms / 全員到達 ${fmt(got)}${miss ? ` ★未到達 ${miss}人` : ''}`);
  return Date.now() - t0;
}

(async () => {
  console.log(`\n負荷テスト: ${BASE.origin}  参加者 ${N}人  period=${PERIOD}\n`);
  startSampler();

  // 1) ページ読み込みの殺到（QRを読んだ全員が一斉に開く）
  let rs = await Promise.all(Array.from({ length: N }, () => request('GET', '/')));
  const okPage = rs.find((r) => r.ok);
  log('[1] 参加ページ一斉読込', `${fmt(rs.filter((r) => r.ok).map((r) => r.ms))} 失敗${rs.filter((r) => !r.ok).length} ${why(rs.filter((r) => !r.ok))} / 1件 ${okPage ? (okPage.bytes / 1024).toFixed(0) : '?'}KB`);

  // 2) 管理者・投影画面 + 参加者 N 人の SSE 接続
  const adm = new SseClient('role=admin', ADMIN_BASE); await adm.connect();
  const pres = new SseClient('role=present', ADMIN_BASE); await pres.connect();
  const players = Array.from({ length: N }, (_, i) => {
    const c = new SseClient(`role=player&id=lt-${i}&name=${encodeURIComponent('負荷' + i)}&dept=${encodeURIComponent('部署' + (i % 12))}`);
    c.id = 'lt-' + i; return c;
  });
  await admin('reset');
  const conn = await Promise.all(players.map(async (p, i) => { if (RAMP_MS) await sleep(Math.random() * RAMP_MS); return p.connect(); }));
  log('[2] SSE同時接続', `${fmt(conn.filter((r) => r.ok).map((r) => r.ms))} 失敗${conn.filter((r) => !r.ok).length} ${why(conn.filter((r) => !r.ok))}`);
  const jc = await adm.waitFor((v) => v.joinCount >= N, 5000);
  log('    管理画面の参加人数', `${adm.last.joinCount}人 ${jc === null ? '★期待値に届かず' : 'OK'}`);

  // 3) 出題 → 一斉回答 → 解答率 → 正解発表 → 次へ
  const period = adm.last.periods.find((p) => p.id === PERIOD);
  const qById = Object.fromEntries(adm.last.questions.map((q) => [q.id, q]));
  const qids = period.questionIds.slice(0, MAX_Q);
  const answerMs = [], answerFail = [];
  for (let qi = 0; qi < qids.length; qi++) {
    const q = qById[qids[qi]];
    const isQ = (v) => v.phase === 'question' && v.q && v.q.index === qi;
    if (qi === 0) await fanout(`[3] Q${qi + 1} 出題配信`, players, isQ, 'startPeriod', { periodId: PERIOD });
    else await fanout(`[3] Q${qi + 1} 出題配信`, players, isQ, 'next');

    // 回答: 4割は2秒以内に殺到、残りは制限時間の6割以内にばらける
    const span = Math.min(q.timeLimit * 1000 * 0.6, 8000);
    const before = Date.now();
    const ans = await Promise.all(players.map(async (p) => {
      await sleep(Math.random() < 0.4 ? Math.random() * 2000 : Math.random() * span);
      let body;
      if (q.type === 'rentan') {
        const idx = q.choices.map((_, k) => k).sort(() => Math.random() - 0.5);
        body = { id: p.id, choices: idx.slice(0, q.rankCount || 3) };
      } else body = { id: p.id, choice: Math.floor(Math.random() * q.choices.length) };
      const r = await request('POST', '/api/answer', body);
      let ok = false; try { ok = r.ok && JSON.parse(r.body).ok; } catch (e) {}
      ok ? answerMs.push(r.ms) : answerFail.push(r);
      // 回答直後に自分の画面が「回答済み」に変わるまで
      return ok ? p.waitFor((v) => v.myAnswer != null, 5000) : null;
    }));
    log(`    Q${qi + 1} 回答POST`, `${fmt(answerMs.slice(-N))} 失敗累計${answerFail.length} ${why(answerFail)} (${((Date.now() - before) / 1000).toFixed(1)}s)`);
    const ack = ans.filter((x) => x !== null);
    log(`    Q${qi + 1} 回答済み表示`, fmt(ack));
    await sleep(400);
    log(`    Q${qi + 1} 管理画面回答数`, `${adm.last.current && adm.last.current.answeredCount}/${N}`);

    await fanout(`    Q${qi + 1} 解答率(stats)`, players, (v) => v.phase === 'stats', 'reveal');
    await fanout(`    Q${qi + 1} 正解発表(reveal)`, players, (v) => v.phase === 'reveal', 'stats');
  }

  // 4) ランキング
  players.forEach((p) => { p.maxMsg = 0; });
  await fanout('[4] ランキング配信', players, (v) => v.phase === 'ranking', 'ranking');
  log('    ランキング1件サイズ', `参加者 ${(players[0].maxMsg / 1024).toFixed(1)}KB / 管理 ${(adm.maxMsg / 1024).toFixed(1)}KB`);
  const myRank = players.filter((p) => p.last && p.last.myRank).length;
  log('    自分の順位を受信', `${myRank}/${N}`);

  // 5) 全員一斉切断 → クライアントと同じジッター(0.8〜3.8s)で再接続
  players.forEach((p) => p.close());
  await sleep(500);
  const t0 = Date.now();
  const rc = await Promise.all(players.map(async (p) => { await sleep(800 + Math.random() * 3000); return p.connect(); }));
  log('[5] 一斉切断→再接続', `${fmt(rc.filter((r) => r.ok).map((r) => r.ms))} 失敗${rc.filter((r) => !r.ok).length} ${why(rc.filter((r) => !r.ok))} 全員復帰 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const rc2 = await adm.waitFor((v) => v.joinCount >= N, 5000);
  log('    再接続後の参加人数', `${adm.last.joinCount}人 ${rc2 === null ? '★期待値に届かず' : 'OK'}`);

  // 6) 緊急モード: 全員がポーリング(2.5s間隔)に切替えた状態を10秒再現
  const pollMs = []; const pollFail = []; const stopAt = Date.now() + 10000;
  await Promise.all(players.map(async (p) => {
    await sleep(Math.random() * 2500);
    while (Date.now() < stopAt) {
      const r = await request('GET', `/api/view?id=${p.id}`);
      r.ok ? pollMs.push(r.ms) : pollFail.push(r);
      await sleep(2500);
    }
  }));
  log('[6] 簡易版ポーリング10秒', `${fmt(pollMs)} 失敗${pollFail.length} ${why(pollFail)}`);

  if (samples.length) {
    log('サーバーCPU', `平均 ${(samples.reduce((a, s) => a + s.cpu, 0) / samples.length).toFixed(0)}% / 最大 ${Math.max(...samples.map((s) => s.cpu)).toFixed(0)}%  (100%=1コア使い切り。Nodeは1コアしか使えない)`);
    log('サーバーメモリ', `最大 ${Math.max(...samples.map((s) => s.rssMB))}MB`);
  }
  log('受信総量', `参加者1人あたり ${(players.reduce((a, p) => a + p.bytes, 0) / N / 1024).toFixed(0)}KB`);

  clearInterval(sampler);
  players.forEach((p) => p.close()); adm.close(); pres.close();
  await admin('reset');
  console.log('');
  process.exit(0);
})();
