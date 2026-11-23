/**
 * cardpointe.js — CardPointe payments for the Green Hills POS
 * -----------------------------------------------------------
 * Drop this file next to server.js and add ONE line to server.js
 * (after `app` and your pg `pool` exist, BEFORE any catch-all route):
 *
 *     require('./cardpointe')(app, pool);
 *
 * What it does
 *   • Runs card-present sales on the CardPointe Integrated Terminal (tap / dip / swipe)
 *   • Voids or refunds through the CardPointe Gateway using the sale's retref
 *   • Keeps every payment in its own Postgres table (cp_transactions) as an audit trail
 *   • Keeps the CardPointe credentials on the server — the browser never sees them
 *
 * Settings come from Railway environment variables first, then from the
 * POS Settings screen (saved in the cp_config table):
 *   CP_MODE           demo | test | live         (demo = simulated, no real charges)
 *   CP_MERCHID        Merchant ID
 *   CP_SITE           Gateway site name, e.g. "fts"   → https://fts(-uat).cardconnect.com
 *   CP_TERMINAL_SITE  Terminal site name (if different) → https://<site>(-uat).cardpointe.com
 *   CP_GATEWAY_USER   Gateway API username
 *   CP_GATEWAY_PASS   Gateway API password
 *   CP_TERMINAL_KEY   Integrated Terminal API key
 *   POS_API_KEY       (strongly recommended) shared secret every register must send
 *
 * Requires Node 18+ (built-in fetch) and the `pg` package your server already uses.
 */
'use strict';
const express = require('express');

const ENV_MAP = {
  mode: 'CP_MODE', merchid: 'CP_MERCHID', site: 'CP_SITE', terminalSite: 'CP_TERMINAL_SITE',
  gatewayUser: 'CP_GATEWAY_USER', gatewayPass: 'CP_GATEWAY_PASS', terminalKey: 'CP_TERMINAL_KEY',
};
const SECRET_KEYS = ['gatewayUser', 'gatewayPass', 'terminalKey'];
const AUTH_TIMEOUT_MS = 150000;   // customer has up to ~2.5 minutes to present a card
const MAX_CENTS = 1000000;        // $10,000 safety cap per charge

module.exports = function mountCardPointe(app, pool) {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  const router = express.Router();
  router.use(express.json({ limit: '100kb' }));

  // ---------------------------------------------------------------- DB
  const ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS cp_config (
      id INT PRIMARY KEY DEFAULT 1, data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT now(), CONSTRAINT cp_config_one_row CHECK (id = 1))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS cp_transactions (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
      kind TEXT NOT NULL,            -- sale | void | refund
      status TEXT NOT NULL,          -- pending | approved | declined | retry | cancelled | busy | error | unknown
      mode TEXT, orderid TEXT, retref TEXT, parent_retref TEXT,
      hsn TEXT, register TEXT, cashier TEXT,
      amount_cents INTEGER, authcode TEXT, account TEXT,
      respcode TEXT, resptext TEXT, raw JSONB)`);
    await pool.query('CREATE INDEX IF NOT EXISTS cp_transactions_retref ON cp_transactions(retref)');
    await pool.query('CREATE INDEX IF NOT EXISTS cp_transactions_orderid ON cp_transactions(orderid)');
  })().catch((e) => console.error('[cardpointe] table setup failed:', e.message));

  async function getConfig() {
    await ready;
    let db = {};
    try {
      const r = await pool.query('SELECT data FROM cp_config WHERE id = 1');
      db = (r.rows[0] && r.rows[0].data) || {};
    } catch (e) { console.error('[cardpointe] config read failed:', e.message); }
    const c = { envLocked: [] };
    for (const k of Object.keys(ENV_MAP)) {
      const envVal = process.env[ENV_MAP[k]];
      if (envVal) { c[k] = envVal.trim(); c.envLocked.push(k); } else c[k] = (db[k] || '').trim();
    }
    c.mode = ['demo', 'test', 'live'].includes((c.mode || '').toLowerCase()) ? c.mode.toLowerCase() : 'demo';
    c.terminalSite = c.terminalSite || c.site;
    c.gatewayReady = !!(c.site && c.merchid && c.gatewayUser && c.gatewayPass);
    c.terminalReady = !!(c.terminalSite && c.merchid && c.terminalKey);
    return c;
  }

  // Base URLs. CP_GATEWAY_BASE_URL / CP_TERMINAL_BASE_URL exist only for local testing against a mock.
  const gwBase = (c) => process.env.CP_GATEWAY_BASE_URL ||
    `https://${c.site}${c.mode === 'live' ? '' : '-uat'}.cardconnect.com/cardconnect/rest/`;
  const termBase = (c) => process.env.CP_TERMINAL_BASE_URL ||
    `https://${c.terminalSite}${c.mode === 'live' ? '' : '-uat'}.cardpointe.com/api/`;
  const gwAuth = (c) => 'Basic ' + Buffer.from(`${c.gatewayUser}:${c.gatewayPass}`).toString('base64');

  async function http(method, url, { headers = {}, body, timeoutMs = 30000 } = {}) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
    return { status: res.status, ok: res.ok, headers: res.headers, json, text };
  }

  // ---------------------------------------------------------------- helpers
  const toCents = (v) => Math.round(parseFloat(v) * 100);
  const dollars = (cents) => (cents / 100).toFixed(2);
  function parseAmountCents(v, fallbackCents) {
    if (v === undefined || v === null || v === '') return fallbackCents;
    const s = String(v);
    return s.includes('.') ? Math.round(parseFloat(s) * 100) : parseInt(s, 10);
  }
  function maskAccount(d) {
    const acct = String(d.account || d.token || '');
    const last4 = acct.replace(/\D/g, '').slice(-4);
    return last4 ? '****' + last4 : 'card';
  }
  function sanitize(d) {
    if (!d || typeof d !== 'object') return d;
    const copy = { ...d };
    for (const k of ['token', 'singleUseToken', 'signature', 'account', 'emvTagData', 'receiptData']) delete copy[k];
    return copy;
  }
  const newOrderId = () => 'GH' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function insertTx(t) {
    try {
      const r = await pool.query(
        `INSERT INTO cp_transactions (kind,status,mode,orderid,retref,parent_retref,hsn,register,cashier,amount_cents,authcode,account,respcode,resptext,raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [t.kind, t.status, t.mode, t.orderid || null, t.retref || null, t.parent_retref || null, t.hsn || null,
          t.register || null, t.cashier || null, t.amount_cents || null, t.authcode || null, t.account || null,
          t.respcode || null, t.resptext || null, t.raw ? JSON.stringify(sanitize(t.raw)) : null]);
      return r.rows[0].id;
    } catch (e) { console.error('[cardpointe] tx insert failed:', e.message); return null; }
  }
  async function updateTx(id, t) {
    if (!id) return;
    try {
      await pool.query(
        `UPDATE cp_transactions SET status=$2, retref=COALESCE($3,retref), authcode=$4, account=$5, respcode=$6,
           resptext=$7, raw=$8, amount_cents=COALESCE($9,amount_cents), updated_at=now() WHERE id=$1`,
        [id, t.status, t.retref || null, t.authcode || null, t.account || null, t.respcode || null,
          t.resptext || null, t.raw ? JSON.stringify(sanitize(t.raw)) : null, t.amount_cents || null]);
    } catch (e) { console.error('[cardpointe] tx update failed:', e.message); }
  }

  // ---------------------------------------------------------------- Terminal API
  const sessions = new Map();   // hsn -> session key
  const busy = new Set();       // hsn values with a payment in progress on THIS server

  function terminalError(r, step) {
    const j = r.json || {};
    const code = j.errorCode;
    const raw = j.errorMessage || r.text || `HTTP ${r.status}`;
    let message;
    if (r.status === 401) message = 'CardPointe rejected the Terminal API key or merchant ID.';
    else if (r.status === 403) message = 'This terminal (HSN) is not boarded to this merchant ID.';
    else if (code === 7) message = 'The terminal is busy. Wait a few seconds, or press Cancel on the terminal, then try again.';
    else if (code === 8) message = 'Cancelled on the terminal.';
    else if (code === 1) message = 'The terminal is not connected to CardPointe. Check that it is powered on and has internet.';
    else if (code === 100) message = 'No terminals are boarded to this merchant ID.';
    else message = `Terminal error during ${step}: ${raw}`;
    const err = new Error(message);
    err.http = r.status; err.code = code; err.body = j;
    err.status = code === 7 ? 'busy' : code === 8 ? 'cancelled' : 'error';
    return err;
  }
  const termHeaders = (c, hsn) => {
    const h = { Authorization: c.terminalKey };
    if (hsn && sessions.get(hsn)) h['X-CardConnect-SessionKey'] = sessions.get(hsn);
    return h;
  };
  async function termConnect(c, hsn) {
    const r = await http('POST', termBase(c) + 'v2/connect',
      { headers: termHeaders(c), body: { merchantId: c.merchid, hsn, force: true }, timeoutMs: 20000 });
    if (!r.ok) throw terminalError(r, 'connect');
    const key = (r.headers.get('x-cardconnect-sessionkey') || '').split(';')[0].trim();
    if (!key) throw new Error('The terminal connected but CardPointe returned no session key.');
    sessions.set(hsn, key);
    return key;
  }
  async function termDisconnect(c, hsn) {
    if (!sessions.has(hsn)) return;
    try {
      await http('POST', termBase(c) + 'v2/disconnect',
        { headers: termHeaders(c, hsn), body: { merchantId: c.merchid, hsn }, timeoutMs: 10000 });
    } catch (_) { /* best effort */ }
    sessions.delete(hsn);
  }

  // Normalise a CardPointe auth response (from authCard or the Gateway)
  function normalizeAuth(d, requestedCents) {
    const respstat = d && d.respstat;
    const approvedCents = parseAmountCents(d && d.amount, requestedCents);
    return {
      status: respstat === 'A' ? 'approved' : respstat === 'B' ? 'retry' : 'declined',
      retref: d.retref || '', authcode: d.authcode || '', respcode: d.respcode || '',
      resptext: d.resptext || '', account: maskAccount(d), entrymode: d.entrymode || '',
      approvedCents, raw: d,
    };
  }

  // Outcome unknown (timeout / dropped connection): ask the Gateway what happened.
  async function recoverByOrderId(c, orderid, cents) {
    if (!c.gatewayReady) {
      return { status: 'unknown', message: `No answer from the terminal, and the Gateway credentials aren't set, so the result can't be checked automatically. Look up order ${orderid} in the CardPointe portal before re-running the card.` };
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await http('GET', `${gwBase(c)}inquireByOrderid/${encodeURIComponent(orderid)}/${c.merchid}/1`,
          { headers: { Authorization: gwAuth(c) }, timeoutMs: 15000 });
        if (r.ok) {
          const list = Array.isArray(r.json) ? r.json : (r.json ? [r.json] : []);
          const hit = list.find((x) => x && x.respstat === 'A') || list[0];
          if (!hit || !hit.retref) return { status: 'declined', resptext: 'No charge was made', message: 'The terminal did not finish, and no charge was found. It is safe to try again.' };
          return normalizeAuth(hit, cents);
        }
      } catch (_) { /* retry */ }
      await sleep(2000);
    }
    // Still unknown → send a safety void so the customer is never charged for a sale we didn't record
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const v = await http('POST', gwBase(c) + 'voidByOrderId',
          { headers: { Authorization: gwAuth(c) }, body: { merchid: c.merchid, orderid }, timeoutMs: 15000 });
        if (v.ok) break;
      } catch (_) { /* retry */ }
    }
    return { status: 'error', message: `No answer from CardPointe, so a safety void was sent for order ${orderid}. Check the CardPointe portal, then try the card again.` };
  }

  // ---------------------------------------------------------------- Gateway helpers
  async function gwInquire(c, retref) {
    const r = await http('GET', `${gwBase(c)}inquire/${encodeURIComponent(retref)}/${c.merchid}`,
      { headers: { Authorization: gwAuth(c) }, timeoutMs: 20000 });
    if (r.status === 401) throw new Error('CardPointe rejected the Gateway username/password.');
    if (!r.ok || !r.json) throw new Error(`Inquire failed (HTTP ${r.status}).`);
    return r.json;
  }
  async function gwPost(c, endpoint, body) {
    const r = await http('POST', gwBase(c) + endpoint, { headers: { Authorization: gwAuth(c) }, body, timeoutMs: 30000 });
    if (r.status === 401) throw new Error('CardPointe rejected the Gateway username/password.');
    if (!r.json) throw new Error(`${endpoint} failed (HTTP ${r.status}).`);
    return r.json;
  }

  // ---------------------------------------------------------------- security
  router.get('/health', async (req, res) => {
    const c = await getConfig();
    res.json({ ok: true, installed: true, mode: c.mode, keyRequired: !!process.env.POS_API_KEY });
  });
  router.use((req, res, next) => {
    const need = process.env.POS_API_KEY;
    if (!need || req.get('x-pos-key') === need) return next();
    res.status(401).json({ ok: false, status: 'error', message: 'Workstation key is missing or wrong (Settings → CardPointe → Workstation key).' });
  });

  // ---------------------------------------------------------------- config
  router.get('/config', async (req, res) => {
    const c = await getConfig();
    res.json({
      ok: true,
      config: {
        mode: c.mode, site: c.site, terminalSite: c.terminalSite === c.site ? '' : c.terminalSite, merchid: c.merchid,
        gatewayUserSet: !!c.gatewayUser, gatewayPassSet: !!c.gatewayPass,
        terminalKeySet: !!c.terminalKey, terminalKeyHint: c.terminalKey ? c.terminalKey.slice(-4) : '',
        envLocked: c.envLocked, keyRequired: !!process.env.POS_API_KEY,
        ready: { gateway: c.mode === 'demo' || c.gatewayReady, terminal: c.mode === 'demo' || c.terminalReady },
      },
    });
  });
  router.post('/config', async (req, res) => {
    await ready;
    const b = req.body || {};
    const r = await pool.query('SELECT data FROM cp_config WHERE id = 1');
    const data = (r.rows[0] && r.rows[0].data) || {};
    for (const k of ['site', 'terminalSite', 'merchid']) {
      if (typeof b[k] === 'string') data[k] = b[k].trim();
    }
    if (typeof b.mode === 'string') {
      if (!['demo', 'test', 'live'].includes(b.mode)) return res.status(400).json({ ok: false, message: 'Mode must be demo, test or live.' });
      data.mode = b.mode;
    }
    for (const k of SECRET_KEYS) {            // blank = keep the saved value
      if (typeof b[k] === 'string' && b[k].trim()) data[k] = b[k].trim();
    }
    if (data.merchid && !/^\d{6,16}$/.test(data.merchid)) return res.status(400).json({ ok: false, message: 'Merchant ID should be digits only.' });
    if (data.site && !/^[a-z0-9-]+$/i.test(data.site)) return res.status(400).json({ ok: false, message: 'Site should be just the site name (e.g. fts), not a full URL.' });
    if (data.terminalSite && !/^[a-z0-9-]+$/i.test(data.terminalSite)) return res.status(400).json({ ok: false, message: 'Terminal site should be just the site name, not a full URL.' });
    await pool.query(
      `INSERT INTO cp_config (id, data, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [JSON.stringify(data)]);
    console.log(`[cardpointe] settings updated (mode=${data.mode || 'demo'})`);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- terminals
  router.get('/terminals', async (req, res) => {
    const c = await getConfig();
    if (c.mode === 'demo') return res.json({ ok: true, terminals: ['DEMO-TERMINAL-1'] });
    if (!c.terminalReady) return res.status(400).json({ ok: false, message: 'Enter the Merchant ID, site and Terminal API key first.' });
    try {
      const r = await http('POST', termBase(c) + 'v2/listTerminals',
        { headers: termHeaders(c), body: { merchantId: c.merchid }, timeoutMs: 20000 });
      if (!r.ok) throw terminalError(r, 'listTerminals');
      res.json({ ok: true, terminals: (r.json && r.json.terminals) || [] });
    } catch (e) { res.status(502).json({ ok: false, message: e.message }); }
  });

  router.post('/terminal/test', async (req, res) => {
    const c = await getConfig();
    const hsn = String((req.body || {}).hsn || '').trim();
    if (c.mode === 'demo') return res.json({ ok: true, message: 'Demo mode — no real terminal contacted.' });
    if (!c.terminalReady) return res.status(400).json({ ok: false, message: 'Enter the Merchant ID, site and Terminal API key first.' });
    if (!hsn) return res.status(400).json({ ok: false, message: 'Enter the terminal HSN.' });
    if (busy.has(hsn)) return res.status(409).json({ ok: false, message: 'That terminal is in the middle of a payment.' });
    busy.add(hsn);
    try {
      await termConnect(c, hsn);
      await http('POST', termBase(c) + 'v2/display', {
        headers: termHeaders(c, hsn), timeoutMs: 15000,
        body: { merchantId: c.merchid, hsn, text: 'Green Hills POS connected' },
      });
      res.json({ ok: true, message: `Terminal ${hsn} connected — its screen should say "Green Hills POS connected".` });
    } catch (e) {
      res.status(502).json({ ok: false, message: e.message });
    } finally { await termDisconnect(c, hsn); busy.delete(hsn); }
  });

  router.post('/terminal/cancel', async (req, res) => {
    const c = await getConfig();
    const hsn = String((req.body || {}).hsn || '').trim();
    if (c.mode === 'demo') { demoCancel.add(hsn || 'demo'); return res.json({ ok: true }); }
    if (!hsn) return res.status(400).json({ ok: false, message: 'No terminal HSN.' });
    try {
      const r = await http('POST', termBase(c) + 'v2/cancel',
        { headers: termHeaders(c, hsn), body: { merchantId: c.merchid, hsn }, timeoutMs: 15000 });
      if (!r.ok) throw terminalError(r, 'cancel');
      res.json({ ok: true });
    } catch (e) { res.status(502).json({ ok: false, message: e.message }); }
  });

  // ---------------------------------------------------------------- SALE (card present)
  const demoCancel = new Set();
  router.post('/terminal/charge', async (req, res) => {
    const c = await getConfig();
    const b = req.body || {};
    const hsn = String(b.hsn || '').trim();
    const cents = toCents(b.amount);
    if (!Number.isFinite(cents) || cents <= 0) return res.status(400).json({ ok: false, status: 'error', message: 'Invalid amount.' });
    if (cents > MAX_CENTS) return res.status(400).json({ ok: false, status: 'error', message: 'Amount is over the $10,000 safety limit.' });
    const orderid = newOrderId();
    const keyed = b.keyed === true;   // phone order: cashier types the card number ON THE TERMINAL (authManual)
    const base = { kind: keyed ? 'sale-keyed' : 'sale', mode: c.mode, orderid, hsn, register: b.register, cashier: b.cashier, amount_cents: cents };

    // ---- DEMO: simulated terminal. Amounts ending in .13 decline (to test the decline screen).
    if (c.mode === 'demo') {
      const key = hsn || 'demo';
      if (busy.has(key)) return res.status(409).json({ ok: false, status: 'busy', message: 'This terminal is already processing a payment.' });
      busy.add(key); demoCancel.delete(key);
      const id = await insertTx({ ...base, status: 'pending' });
      try {
        for (let i = 0; i < 25 && !demoCancel.has(key); i++) await sleep(100);
        if (demoCancel.has(key)) {
          await updateTx(id, { status: 'cancelled', resptext: 'Cancelled' });
          return res.json({ ok: false, status: 'cancelled', orderid, mode: 'demo', message: 'Cancelled on the terminal.' });
        }
        if (cents % 100 === 13) {
          await updateTx(id, { status: 'declined', respcode: '05', resptext: 'Do not honor' });
          return res.json({ ok: false, status: 'declined', orderid, mode: 'demo', respcode: '05', resptext: 'Do not honor (demo decline)' });
        }
        const retref = String(Math.floor(1e11 + Math.random() * 9e11));
        const authcode = 'DEMO' + String(Math.floor(Math.random() * 99)).padStart(2, '0');
        await updateTx(id, { status: 'approved', retref, authcode, account: '****1111', resptext: 'Approval' });
        return res.json({ ok: true, status: 'approved', orderid, mode: 'demo', retref, authcode, account: '****1111', amount: Number(dollars(cents)), resptext: 'Approval', entrymode: keyed ? 'Keyed' : 'EMV Contactless' });
      } finally { busy.delete(key); demoCancel.delete(key); }
    }

    // ---- TEST / LIVE: real Integrated Terminal
    if (!c.terminalReady) return res.status(400).json({ ok: false, status: 'error', message: 'CardPointe terminal settings are incomplete (Merchant ID, site, Terminal API key).' });
    if (!hsn) return res.status(400).json({ ok: false, status: 'error', message: 'This register has no terminal HSN assigned (Settings → CardPointe).' });
    if (busy.has(hsn)) return res.status(409).json({ ok: false, status: 'busy', message: 'This terminal is already processing a payment.' });
    busy.add(hsn);
    const id = await insertTx({ ...base, status: 'pending' });
    let out;
    try {
      await termConnect(c, hsn);
      let r = null;
      try {
        const authBody = {
          merchantId: c.merchid, hsn, amount: String(cents), orderId: orderid,
          capture: true, includeSignature: false, includeAmountDisplay: true, beep: true,
        };
        if (keyed) {
          // Keyed entry: the terminal prompts for card number, expiry, CVV and billing ZIP
          Object.assign(authBody, { includeAVS: true, includeCVV: true });
          r = await http('POST', termBase(c) + 'v3/authManual', { headers: termHeaders(c, hsn), timeoutMs: AUTH_TIMEOUT_MS, body: authBody });
          if (r.status === 404) r = await http('POST', termBase(c) + 'v2/authManual', { headers: termHeaders(c, hsn), timeoutMs: AUTH_TIMEOUT_MS, body: authBody });
        } else {
          Object.assign(authBody, { confirmAmount: true, clearDisplayDelay: 1500 });
          r = await http('POST', termBase(c) + 'v3/authCard', { headers: termHeaders(c, hsn), timeoutMs: AUTH_TIMEOUT_MS, body: authBody });
        }
      } catch (netErr) {
        console.warn(`[cardpointe] authCard no response for ${orderid}: ${netErr.message}`);
        r = null;
      }
      let result;
      if (r === null) {
        result = await recoverByOrderId(c, orderid, cents);
      } else if (r.ok && r.json) {
        result = normalizeAuth(r.json, cents);
      } else {
        const j = r.json || {};
        if (j.authResponse) result = normalizeAuth(j.authResponse, cents);       // timed out AFTER the auth went through
        else if (j.errorCode === 1 || j.errorCode === 8) result = j.errorCode === 8
          ? { status: 'cancelled', message: 'Cancelled on the terminal.' }
          : await recoverByOrderId(c, orderid, cents);
        else if (keyed && (r.status === 404 || r.status === 405)) result = { status: 'error', message: 'Keyed card entry is not available on this terminal or merchant account. Ask CardPointe to enable manual entry (authManual) for your MID and terminal.' };
        else { const e = terminalError(r, keyed ? 'keyed entry' : 'authCard'); result = { status: e.status, message: e.message }; }
      }

      // Partial approval (some prepaid/gift cards): never keep it — void and tell the cashier.
      if (result.status === 'approved' && result.approvedCents && result.approvedCents < cents) {
        try { if (c.gatewayReady) await gwPost(c, 'void', { merchid: c.merchid, retref: result.retref }); } catch (_) { /* logged below */ }
        result = { ...result, status: 'declined', message: `The card only approved $${dollars(result.approvedCents)} of $${dollars(cents)} (partial approval), so it was voided. Use another card or split the payment.` };
      }

      await updateTx(id, {
        status: result.status, retref: result.retref, authcode: result.authcode, account: result.account,
        respcode: result.respcode, resptext: result.resptext || result.message, raw: result.raw,
      });
      out = {
        ok: result.status === 'approved', status: result.status, orderid, mode: c.mode,
        retref: result.retref || '', authcode: result.authcode || '', account: result.account || '',
        respcode: result.respcode || '', resptext: result.resptext || '', message: result.message || '',
        amount: Number(dollars(cents)), entrymode: result.entrymode || (keyed ? 'Keyed' : ''),
      };
    } catch (e) {
      await updateTx(id, { status: e.status || 'error', resptext: e.message });
      out = { ok: false, status: e.status || 'error', orderid, message: e.message };
    } finally {
      await termDisconnect(c, hsn);
      busy.delete(hsn);
    }
    res.json(out);
  });

  // ---------------------------------------------------------------- VOID / REFUND
  // Body: { retref, amount (dollars, optional = full), fullAmount (dollars), cashier }
  router.post('/reverse', async (req, res) => {
    const c = await getConfig();
    const b = req.body || {};
    const retref = String(b.retref || '').trim();
    if (!retref) return res.status(400).json({ ok: false, status: 'error', message: 'Missing retref.' });
    const reqCents = b.amount ? toCents(b.amount) : null;
    if (reqCents !== null && (!Number.isFinite(reqCents) || reqCents <= 0)) return res.status(400).json({ ok: false, status: 'error', message: 'Invalid amount.' });

    if (c.mode === 'demo') {
      await insertTx({ kind: 'void', status: 'approved', mode: 'demo', parent_retref: retref, amount_cents: reqCents, cashier: b.cashier, resptext: 'Approval' });
      return res.json({ ok: true, status: 'approved', kind: 'void', retref: String(Math.floor(1e11 + Math.random() * 9e11)), message: 'Demo — nothing sent to CardPointe.' });
    }
    if (!c.gatewayReady) return res.status(400).json({ ok: false, status: 'error', message: 'Gateway username/password are not set, so refunds can\'t be sent.' });

    try {
      const inq = await gwInquire(c, retref);
      const origCents = parseAmountCents(inq.amount, b.fullAmount ? toCents(b.fullAmount) : null);
      const full = reqCents === null || (origCents && reqCents >= origCents);
      let kind, resp;
      if (inq.voidable === 'Y' && (full || inq.setlstat === 'Authorized')) {
        kind = 'void';
        resp = await gwPost(c, 'void', full ? { merchid: c.merchid, retref } : { merchid: c.merchid, retref, amount: dollars(reqCents) });
      } else if (inq.refundable === 'Y') {
        kind = 'refund';
        resp = await gwPost(c, 'refund', full ? { merchid: c.merchid, retref } : { merchid: c.merchid, retref, amount: dollars(reqCents) });
      } else if (inq.voidable === 'Y' && !full) {
        return res.status(409).json({ ok: false, status: 'error', message: 'This charge hasn\'t settled yet, so CardPointe only allows a FULL void today. Either void the full amount and re-ring the sale, or do the partial refund tomorrow after the nightly batch.' });
      } else {
        return res.status(409).json({ ok: false, status: 'error', message: `CardPointe says this charge can't be voided or refunded right now (status: ${inq.setlstat || 'unknown'}).` });
      }
      const approved = resp.respstat === 'A';
      await insertTx({
        kind, status: approved ? 'approved' : 'declined', mode: c.mode, retref: resp.retref, parent_retref: retref,
        amount_cents: reqCents || origCents, cashier: b.cashier, authcode: resp.authcode,
        respcode: resp.respcode, resptext: resp.resptext, raw: resp,
      });
      res.json({
        ok: approved, status: approved ? 'approved' : 'declined', kind, retref: resp.retref || '',
        resptext: resp.resptext || '', message: approved ? '' : `${kind === 'void' ? 'Void' : 'Refund'} declined: ${resp.resptext || 'unknown reason'}`,
      });
    } catch (e) {
      res.status(502).json({ ok: false, status: 'error', message: e.message });
    }
  });

  // ---------------------------------------------------------------- lookups / audit
  router.get('/inquire/:retref', async (req, res) => {
    const c = await getConfig();
    if (c.mode === 'demo') return res.json({ ok: true, demo: true });
    if (!c.gatewayReady) return res.status(400).json({ ok: false, message: 'Gateway credentials not set.' });
    try { res.json({ ok: true, result: sanitize(await gwInquire(c, req.params.retref)) }); }
    catch (e) { res.status(502).json({ ok: false, message: e.message }); }
  });
  router.get('/transactions', async (req, res) => {
    await ready;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
    const r = await pool.query(
      `SELECT id, created_at, kind, status, mode, orderid, retref, parent_retref, hsn, register, cashier,
              amount_cents, authcode, account, respcode, resptext
       FROM cp_transactions ORDER BY id DESC LIMIT $1`, [limit]);
    res.json({ ok: true, transactions: r.rows });
  });

  app.use('/api/cp', router);
  console.log('[cardpointe] payment routes mounted at /api/cp');
  return router;
};
