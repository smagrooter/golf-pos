const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database ─────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgresql://postgres:KWAwiLnoVgHcmAwqQuxjuKnINeolziYI@postgres.railway.internal:5432/railway',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS pos_data (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS golfer_accounts (
      id SERIAL PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, phone TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS online_bookings (
      id SERIAL PRIMARY KEY, golfer_id INTEGER REFERENCES golfer_accounts(id),
      date TEXT NOT NULL, time TEXT NOT NULL, holes TEXT NOT NULL DEFAULT '18',
      players INTEGER NOT NULL DEFAULT 1, extra_names TEXT DEFAULT '',
      guest_first TEXT DEFAULT '', guest_last TEXT DEFAULT '', guest_email TEXT DEFAULT '',
      notes TEXT DEFAULT '', status TEXT DEFAULT 'confirmed', pos_key TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS golfer_sessions (
      token TEXT PRIMARY KEY, golfer_id INTEGER REFERENCES golfer_accounts(id),
      expires_at TIMESTAMPTZ NOT NULL
    );`);
    console.log('✅ Database ready');
  } catch (err) {
    console.error('❌ Database init error:', err.message);
  }
}
initDB();

// ── Helpers ───────────────────────────────────────────────────────────────────
function hashPass(p) {
  return crypto.createHash('sha256').update(p + 'ghgc_salt_2026').digest('hex');
}
function makeToken() { return crypto.randomBytes(32).toString('hex'); }
function formatTime(t) {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
async function getSession(req) {
  const token = (req.headers.authorization || '').replace('Bearer ','').trim();
  if (!token) return null;
  try {
    const r = await pool.query(
      'SELECT g.* FROM golfer_sessions s JOIN golfer_accounts g ON g.id=s.golfer_id WHERE s.token=$1 AND s.expires_at>NOW()',
      [token]
    );
    return r.rows[0] || null;
  } catch { return null; }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════════════════════════
// POS DATA ROUTES
// ════════════════════════════════════════════════════════════════════
app.get('/api/data', async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM pos_data');
    const data = {};
    result.rows.forEach(r => { try { data[r.key] = JSON.parse(r.value); } catch { data[r.key] = r.value; } });
    res.json({ ok: true, data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/data/:key', async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO pos_data(key,value,updated_at)VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()',
      [req.params.key, JSON.stringify(req.body.value)]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/data', async (req, res) => {
  const entries = req.body;
  if (!entries || typeof entries !== 'object') return res.status(400).json({ ok: false });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [k, v] of Object.entries(entries))
      await client.query('INSERT INTO pos_data(key,value,updated_at)VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [k, JSON.stringify(v)]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ ok: false, error: e.message }); }
  finally { client.release(); }
});

app.get('/api/export', async (req, res) => {
  try {
    const result = await pool.query('SELECT key,value FROM pos_data ORDER BY key');
    const data = {};
    result.rows.forEach(r => { try { data[r.key] = JSON.parse(r.value); } catch { data[r.key] = r.value; } });
    res.setHeader('Content-Disposition', `attachment; filename="golf-pos-backup-${new Date().toISOString().split('T')[0]}.json"`);
    res.json({ exportedAt: new Date().toISOString(), data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/import', async (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ ok: false });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [k, v] of Object.entries(data))
      await client.query('INSERT INTO pos_data(key,value,updated_at)VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [k, JSON.stringify(v)]);
    await client.query('COMMIT');
    res.json({ ok: true, imported: Object.keys(data).length });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ ok: false, error: e.message }); }
  finally { client.release(); }
});

// ════════════════════════════════════════════════════════════════════
// GOLFER ACCOUNT ROUTES
// ════════════════════════════════════════════════════════════════════
app.post('/api/accounts/register', async (req, res) => {
  const { firstName, lastName, email, password, phone } = req.body;
  if (!firstName || !lastName || !email || !password)
    return res.status(400).json({ ok: false, error: 'All fields required' });
  if (password.length < 6)
    return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
  try {
    const ex = await pool.query('SELECT id FROM golfer_accounts WHERE email=$1', [email.toLowerCase()]);
    if (ex.rows.length) return res.status(400).json({ ok: false, error: 'An account with that email already exists' });
    const r = await pool.query(
      'INSERT INTO golfer_accounts(first_name,last_name,email,pass_hash,phone)VALUES($1,$2,$3,$4,$5) RETURNING id,first_name,last_name,email',
      [firstName.trim(), lastName.trim(), email.toLowerCase().trim(), hashPass(password), (phone||'').trim()]
    );
    const g = r.rows[0];
    const token = makeToken();
    await pool.query('INSERT INTO golfer_sessions(token,golfer_id,expires_at)VALUES($1,$2,NOW()+INTERVAL\'30 days\')', [token, g.id]);
    res.json({ ok: true, token, golfer: { id: g.id, firstName: g.first_name, lastName: g.last_name, email: g.email } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/accounts/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password required' });
  try {
    const r = await pool.query('SELECT * FROM golfer_accounts WHERE email=$1', [email.toLowerCase().trim()]);
    if (!r.rows.length || r.rows[0].pass_hash !== hashPass(password))
      return res.status(401).json({ ok: false, error: 'Incorrect email or password' });
    const g = r.rows[0];
    const token = makeToken();
    await pool.query('INSERT INTO golfer_sessions(token,golfer_id,expires_at)VALUES($1,$2,NOW()+INTERVAL\'30 days\')', [token, g.id]);
    res.json({ ok: true, token, golfer: { id: g.id, firstName: g.first_name, lastName: g.last_name, email: g.email } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/accounts/me', async (req, res) => {
  const g = await getSession(req);
  if (!g) return res.status(401).json({ ok: false, error: 'Not logged in' });
  res.json({ ok: true, golfer: { id: g.id, firstName: g.first_name, lastName: g.last_name, email: g.email, phone: g.phone } });
});

app.post('/api/accounts/logout', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ','').trim();
  if (token) await pool.query('DELETE FROM golfer_sessions WHERE token=$1', [token]).catch(()=>{});
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
// TEE TIME AVAILABILITY
// ════════════════════════════════════════════════════════════════════
app.get('/api/teetimes/:date', async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: 'Invalid date' });
  const today = new Date(); today.setHours(0,0,0,0);
  const reqDate = new Date(date + 'T12:00:00');
  const diffDays = Math.round((reqDate - today) / 86400000);
  if (diffDays < 0) return res.json({ ok: true, slots: [] });
  if (diffDays > 7) return res.json({ ok: true, slots: [], message: 'Bookings open up to 7 days in advance' });

  try {
    // Load POS bookings
    const posR = await pool.query('SELECT value FROM pos_data WHERE key=$1', ['pos_main']);
    let posBookings = {};
    let openHour = 7, closeHour = 18;
    if (posR.rows.length) {
      try {
        const pd = JSON.parse(posR.rows[0].value);
        posBookings = pd.bookings || {};
        if (pd.CFG?.teeOpenHour !== undefined) openHour = pd.CFG.teeOpenHour;
        if (pd.CFG?.teeCloseHour !== undefined) closeHour = pd.CFG.teeCloseHour;
      } catch {}
    }
    // Load online bookings
    const onlineR = await pool.query(
      "SELECT time, players FROM online_bookings WHERE date=$1 AND status!='cancelled'", [date]
    );
    // Build usage map
    const usage = {};
    Object.values(posBookings).forEach(b => {
      if (b.date === date) usage[b.time] = (usage[b.time]||0) + (parseInt(b.players)||1);
    });
    onlineR.rows.forEach(b => {
      usage[b.time] = (usage[b.time]||0) + (parseInt(b.players)||1);
    });
    // Generate slots
    const now = new Date();
    const slots = [];
    for (let h = openHour; h < closeHour; h++) {
      for (let m = 0; m < 60; m += 10) {
        if (diffDays === 0 && (h < now.getHours() || (h === now.getHours() && m <= now.getMinutes()))) continue;
        const t = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
        const avail = Math.max(0, 4 - (usage[t]||0));
        if (avail > 0) slots.push({ time: t, available: avail, display: formatTime(t) });
      }
    }
    // Get active discounts for this date/time from POS settings
    let activeDiscounts = [];
    if (posR.rows.length) {
      try {
        const posDiscounts = JSON.parse(posR.rows[0].value).discounts || [];
        const reqDateObj = new Date(date + 'T12:00:00');
        const dow = reqDateObj.getDay();
        // For today, check current time; for future dates, show all scheduled discounts for that day
        activeDiscounts = posDiscounts.filter(d => d.days && d.days.indexOf(dow) >= 0).map(function(d){
          return {name: d.name, type: d.type, val: d.val, start: d.start, end: d.end, item: d.item};
        });
      } catch {}
    }

    res.json({ ok: true, slots, activeDiscounts });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════
// BOOKING SUBMISSION
// ════════════════════════════════════════════════════════════════════
app.post('/api/bookings', async (req, res) => {
  const golfer = await getSession(req);
  const { date, time, holes, players, extraNames, notes, guestFirst, guestLast, guestEmail } = req.body;
  if (!date || !time || !players) return res.status(400).json({ ok: false, error: 'Date, time, and players required' });

  let firstName, lastName, email, golferId = null;
  if (golfer) {
    firstName = golfer.first_name; lastName = golfer.last_name;
    email = golfer.email; golferId = golfer.id;
  } else {
    if (!guestFirst || !guestLast || !guestEmail)
      return res.status(400).json({ ok: false, error: 'Name and email required' });
    firstName = guestFirst.trim(); lastName = guestLast.trim();
    email = guestEmail.toLowerCase().trim();
  }
  const fullName = `${firstName} ${lastName}`;

  try {
    // Check availability
    const onlineUsedR = await pool.query(
      "SELECT COALESCE(SUM(players),0) as used FROM online_bookings WHERE date=$1 AND time=$2 AND status!='cancelled'",
      [date, time]
    );
    let posUsed = 0;
    const posR = await pool.query('SELECT value FROM pos_data WHERE key=$1', ['pos_main']);
    let posData = null;
    if (posR.rows.length) {
      try {
        posData = JSON.parse(posR.rows[0].value);
        Object.values(posData.bookings||{}).forEach(b => {
          if (b.date===date && b.time===time) posUsed += parseInt(b.players)||1;
        });
      } catch {}
    }
    const totalUsed = parseInt(onlineUsedR.rows[0].used) + posUsed;
    if (totalUsed + parseInt(players) > 4)
      return res.status(409).json({ ok: false, error: 'Not enough spots available — please choose another time' });

    // Save booking record
    const bR = await pool.query(
      'INSERT INTO online_bookings(golfer_id,date,time,holes,players,extra_names,guest_first,guest_last,guest_email,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [golferId, date, time, holes||'18', parseInt(players), (extraNames||[]).join(','), firstName, lastName, email, notes||'']
    );
    const bookingId = bR.rows[0].id;
    const posKey = `${date}|${time}|#1 Tee`;

    // Inject into POS tee sheet
    if (posData) {
      posData.bookings = posData.bookings || {};
      posData.bookings[posKey] = {
        name: fullName, extras: (extraNames||[]).filter(Boolean),
        players: parseInt(players), holes: holes||'18', cart: 'none',
        notes: `Online booking #GH-${bookingId}`, paidNames: [], paid: false,
        memberId: null, email, phone: '', date, time, col: '#1 Tee',
        onlineBookingId: bookingId
      };
      await pool.query('UPDATE pos_data SET value=$1, updated_at=NOW() WHERE key=$2', [JSON.stringify(posData), 'pos_main']);
    }
    await pool.query('UPDATE online_bookings SET pos_key=$1 WHERE id=$2', [posKey, bookingId]);

    res.json({
      ok: true, bookingId,
      confirmation: {
        name: fullName, email, date,
        time: formatTime(time), holes: holes||'18',
        players: parseInt(players),
        confirmationNumber: `GH-${bookingId}-${date.replace(/-/g,'')}`
      }
    });
  } catch (err) {
    console.error('Booking error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/bookings/mine', async (req, res) => {
  const g = await getSession(req);
  if (!g) return res.status(401).json({ ok: false, error: 'Not logged in' });
  try {
    const r = await pool.query('SELECT * FROM online_bookings WHERE golfer_id=$1 ORDER BY date DESC,time DESC LIMIT 20', [g.id]);
    res.json({ ok: true, bookings: r.rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/bookings/:id/cancel', async (req, res) => {
  const g = await getSession(req);
  if (!g) return res.status(401).json({ ok: false, error: 'Not logged in' });
  try {
    const r = await pool.query(
      "UPDATE online_bookings SET status='cancelled' WHERE id=$1 AND golfer_id=$2 RETURNING pos_key",
      [req.params.id, g.id]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'Booking not found' });
    const posKey = r.rows[0].pos_key;
    if (posKey) {
      const pr = await pool.query('SELECT value FROM pos_data WHERE key=$1', ['pos_main']);
      if (pr.rows.length) {
        try {
          const pd = JSON.parse(pr.rows[0].value);
          delete pd.bookings[posKey];
          await pool.query('UPDATE pos_data SET value=$1,updated_at=NOW() WHERE key=$2', [JSON.stringify(pd), 'pos_main']);
        } catch {}
      }
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, db: 'connected' }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/book', (req, res) => res.sendFile(path.join(__dirname, 'public', 'book.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🏌️  Golf POS running on port ${PORT}`));
