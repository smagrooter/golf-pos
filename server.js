const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database connection ──────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgresql://postgres:KWAwiLnoVgHcmAwqQuxjuKnINeolziYI@postgres.railway.internal:5432/railway',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ── Create table on startup ──────────────────────────────────────────────────
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pos_data (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ Database ready');
  } catch (err) {
    console.error('❌ Database init error:', err.message);
  }
}
initDB();

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── API: Load all saved data ─────────────────────────────────────────────────
app.get('/api/data', async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM pos_data');
    const data = {};
    result.rows.forEach(row => {
      try { data[row.key] = JSON.parse(row.value); }
      catch { data[row.key] = row.value; }
    });
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Load error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── API: Save a single key ───────────────────────────────────────────────────
app.post('/api/data/:key', async (req, res) => {
  const { key } = req.params;
  const value = JSON.stringify(req.body.value);
  try {
    await pool.query(`
      INSERT INTO pos_data (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            updated_at = NOW()
    `, [key, value]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Save error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── API: Save multiple keys at once (bulk) ───────────────────────────────────
app.post('/api/data', async (req, res) => {
  const entries = req.body; // { key: value, key: value, ... }
  if (!entries || typeof entries !== 'object') {
    return res.status(400).json({ ok: false, error: 'Invalid payload' });
  }
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [key, val] of Object.entries(entries)) {
        await client.query(`
          INSERT INTO pos_data (key, value, updated_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value,
                updated_at = NOW()
        `, [key, JSON.stringify(val)]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Bulk save error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── API: Export all data as JSON file ────────────────────────────────────────
app.get('/api/export', async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value, updated_at FROM pos_data ORDER BY key');
    const data = {};
    result.rows.forEach(row => {
      try { data[row.key] = JSON.parse(row.value); }
      catch { data[row.key] = row.value; }
    });
    const filename = `golf-pos-backup-${new Date().toISOString().split('T')[0]}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.json({ exportedAt: new Date().toISOString(), data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── API: Import data from JSON backup ────────────────────────────────────────
app.post('/api/import', async (req, res) => {
  const { data } = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ ok: false, error: 'Invalid import format' });
  }
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [key, val] of Object.entries(data)) {
        await client.query(`
          INSERT INTO pos_data (key, value, updated_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value,
                updated_at = NOW()
        `, [key, JSON.stringify(val)]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.json({ ok: true, imported: Object.keys(data).length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected', time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, db: 'error', error: err.message });
  }
});

// ── Serve POS for all other routes ───────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🏌️ Golf POS running on port ${PORT}`);
});
