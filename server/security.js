// security.js - 会话鉴权、CSRF 与 Wiki Token 加解密
'use strict';

const crypto = require('crypto');
const { APP_KEY } = require('../server-js/wf-server-config.js');

function enc(data) {
  const key = crypto.createHash('sha256').update(APP_KEY).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function dec(b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const key = crypto.createHash('sha256').update(APP_KEY).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  return dec;
}

function assertAuth(req, res, next) {
  if (req.session && req.session.uid) return next();
  return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
}

function genCSRF(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(16).toString('hex');
  return req.session.csrf;
}

function verifyCSRF(req, res, next) {
  const token = req.get('x-csrf-token');
  if (!token || token !== req.session.csrf) {
    return res.status(403).json({ ok: false, error: 'BAD_CSRF' });
  }
  next();
}

module.exports = {
  enc,
  dec,
  assertAuth,
  genCSRF,
  verifyCSRF,
};
