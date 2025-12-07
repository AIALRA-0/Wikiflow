// routes-terms.js - 术语队列 terms 的增删查
'use strict';

const { db, logAction } = require('./db');
const { assertAuth, verifyCSRF } = require('./security');

function registerTermRoutes(app) {
  app.post('/api/terms', verifyCSRF, assertAuth, (req, res) => {
    const uid = req.session.uid;
    const { term } = req.body || {};
    if (!term || String(term).length > 200) {
      return res.status(400).json({ ok: false, error: 'BAD_TERM' });
    }

    const norm = String(term).toLowerCase().replace(/\s+/g, '').trim();
    try {
      const id = db.prepare('INSERT INTO terms (user_id, term, term_norm) VALUES (?,?,?)')
        .run(uid, String(term).trim(), norm).lastInsertRowid;
      logAction(uid, 'term_add', { id, term });
      return res.json({ ok: true, id });
    } catch (e) {
      if (/unique/i.test(String(e))) {
        return res.status(409).json({ ok: false, error: 'DUP_TERM' });
      }
      return res.status(500).json({ ok: false, error: 'TERM_ADD_FAIL' });
    }
  });

  app.get('/api/terms', assertAuth, (req, res) => {
    const uid = req.session.uid;
    const rows = db.prepare('SELECT id, term, status, created_at FROM terms WHERE user_id=? ORDER BY id DESC LIMIT 200').all(uid);
    res.json({ ok: true, items: rows });
  });

  app.delete('/api/terms/:id', verifyCSRF, assertAuth, (req, res) => {
    const uid = req.session.uid;
    const id = Number(req.params.id);
    db.prepare('DELETE FROM terms WHERE id=? AND user_id=?').run(id, uid);
    logAction(uid, 'term_del', { id });
    res.json({ ok: true });
  });
}

module.exports = {
  registerTermRoutes,
};
