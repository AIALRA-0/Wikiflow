// routes-auth.js - 登录/登出、会话信息与用户 Wiki 设置
'use strict';

const bcrypt = require('bcrypt');
const { db, logAction } = require('./db');
const { enc, dec, assertAuth, genCSRF, verifyCSRF } = require('./security');
const {
  DEFAULT_WIKI_BASE,
  DEFAULT_WIKI_GRAPHQL,
  DEFAULT_LOCALE,
  DEFAULT_EDITOR,
} = require('../server-js/wf-server-config.js');

function registerAuthRoutes(app) {
  // CSRF
  app.get('/api/csrf', (req, res) => {
    res.json({ ok: true, token: genCSRF(req) });
  });

  // 会话信息
  app.get('/api/session', (req, res) => {
    const uid = req.session.uid;
    if (!uid) return res.json({ authenticated: false });

    const u = db.prepare('SELECT username FROM users WHERE id=?').get(uid) || {};
    const st = db.prepare('SELECT wiki_base_url, wiki_graphql_url, wiki_token_cipher, locale, editor FROM user_settings WHERE user_id=?').get(uid) || {};

    res.json({
      authenticated: true,
      user: { id: uid, username: u.username || '' },
      settings: {
        wiki_base_url: st.wiki_base_url || DEFAULT_WIKI_BASE,
        wiki_graphql_url: st.wiki_graphql_url || DEFAULT_WIKI_GRAPHQL,
        locale: st.locale || DEFAULT_LOCALE,
        editor: st.editor || DEFAULT_EDITOR,
        has_token: !!st.wiki_token_cipher,
        token_preview: st.wiki_token_cipher ? ('••••' + (dec(st.wiki_token_cipher).slice(-4))) : ''
      }
    });
  });

  // 登录
  app.post('/api/login', verifyCSRF, async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok: false, error: 'MISSING' });
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    if (!u) return res.status(401).json({ ok: false, error: 'INVALID' });
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: 'INVALID' });
    req.session.uid = u.id;
    genCSRF(req);
    db.prepare('INSERT INTO login_events (user_id, ip, ua) VALUES (?, ?, ?)').run(
      u.id,
      (req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''),
      req.headers['user-agent'] || ''
    );
    logAction(u.id, 'login', { user: username });
    res.json({ ok: true });
  });

  // 登出
  app.post('/api/logout', verifyCSRF, assertAuth, (req, res) => {
    const uid = req.session.uid;
    req.session = null;
    logAction(uid, 'logout', {});
    res.json({ ok: true });
  });

  // 保存 Wiki 设置
  app.post('/api/settings', verifyCSRF, assertAuth, (req, res) => {
    const uid = req.session.uid;
    let { wiki_base_url, wiki_graphql_url, wiki_token, locale, editor } = req.body || {};
    if (!wiki_base_url && !wiki_graphql_url && !wiki_token && !locale && !editor) {
      return res.status(400).json({ ok: false, error: 'EMPTY' });
    }
    wiki_base_url = (wiki_base_url || DEFAULT_WIKI_BASE).trim();
    wiki_graphql_url = (wiki_graphql_url || DEFAULT_WIKI_GRAPHQL).trim();
    const encTok = wiki_token ? enc(wiki_token.trim()) : null;
    const row = db.prepare('SELECT user_id FROM user_settings WHERE user_id=?').get(uid);
    if (row) {
      const sql = `UPDATE user_settings SET wiki_base_url=COALESCE(?,wiki_base_url),
        wiki_graphql_url=COALESCE(?,wiki_graphql_url),
        wiki_token_cipher=COALESCE(?,wiki_token_cipher),
        locale=COALESCE(?,locale),
        editor=COALESCE(?,editor)
        WHERE user_id=?`;
      db.prepare(sql).run(
        wiki_base_url || null,
        wiki_graphql_url || null,
        encTok || null,
        locale || null,
        editor || null,
        uid
      );
    } else {
      db.prepare('INSERT INTO user_settings (user_id, wiki_base_url, wiki_graphql_url, wiki_token_cipher, locale, editor) VALUES (?,?,?,?,?,?)')
        .run(uid, wiki_base_url, wiki_graphql_url, encTok, locale || DEFAULT_LOCALE, editor || DEFAULT_EDITOR);
    }
    logAction(uid, 'save_settings', { wiki_base_url, wiki_graphql_url, has_token: !!wiki_token });
    res.json({ ok: true });
  });
}

module.exports = {
  registerAuthRoutes,
};
