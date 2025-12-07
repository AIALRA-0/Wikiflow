// wiki-utils.js - Wiki.js GraphQL 相关工具与标题/path 处理
'use strict';

const {
  GQL_TIMEOUT_MS,
  DEFAULT_WIKI_GRAPHQL,
  DEFAULT_WIKI_BASE,
} = require('../server-js/wf-server-config.js');
const { db } = require('./db');
const { dec } = require('./security');

// ---------- 标题与路径小工具 ----------
function normalizeSegment(seg) {
  return (seg || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-\u4e00-\u9fa5]/g, '');
}

function pathify(input) {
  if (!input || !String(input).trim()) return null;
  const raw = String(input).trim().replace(/\/+/g, '/');
  const parts = raw.split('/').filter((p, i) => !(i === 0 && p === ''));
  const clean = [];
  for (const p of parts) {
    if (p === '.' || p === '..') return null;
    const seg = normalizeSegment(p);
    if (!seg) return null;
    clean.push(seg);
  }
  return '/' + clean.join('/');
}

function normalizeTitle(s) {
  return (s || '').toLowerCase().replace(/\s+/g, '');
}

function splitTokens(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).map(x => x.toLowerCase());
}

function tokenOverlap(main, cand) {
  const A = new Set(splitTokens(main));
  const B = new Set(splitTokens(cand));
  if (!A.size || !B.size) return { matched: [], coverage: 0, jaccard: 0 };
  const matched = [...A].filter(t => B.has(t));
  const coverage = matched.length / A.size;
  const jaccard = matched.length / new Set([...A, ...B]).size;
  return { matched, coverage, jaccard };
}

function isAbortErr(err) {
  return err?.name === 'AbortError' || /aborted|AbortError/i.test(String(err?.message || err));
}

// ---------- GraphQL 调用 ----------
async function gqlRequest(url, token, query, variables = {}, timeoutMs = GQL_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();

  let res, raw, data;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${token}`,
        'user-agent': 'wikiflow/1.0'
      },
      body: JSON.stringify({ query, variables }),
      signal: ac.signal
    });
    raw = await res.text();
    try { data = JSON.parse(raw); } catch {
      throw new Error(`GQL_HTTP_${res.status} (${Date.now() - t0}ms): ${raw.slice(0, 200)}`);
    }
    if (!res.ok) {
      const msg = data?.errors?.map(e => e.message).join(' | ') || raw.slice(0, 200);
      throw new Error(`GQL_HTTP_${res.status} (${Date.now() - t0}ms): ${msg}`);
    }
    if (Array.isArray(data.errors) && data.errors.length) {
      const msg = data.errors.map(e => e.message).join(' | ');
      const where = data.errors.map(e => (e.path || []).join('.')).filter(Boolean).join(' , ');
      throw new Error(`GQL_ERR (${Date.now() - t0}ms): ${msg}${where ? ` @${where}` : ''}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForPageByPath(gqlURL, token, pathSlug, tries = 8, interval = 800) {
  for (let i = 0; i < tries; i++) {
    try {
      const data = await gqlRequest(gqlURL, token, `
        query($limit:Int!){
          pages { list(orderBy: TITLE, orderByDirection: ASC, limit:$limit){ id path title } }
        }`, { limit: 2000 });
      const hit = data?.data?.pages?.list?.find(p => (p.path || '') === pathSlug);
      if (hit) return hit;
    } catch { }
    await new Promise(r => setTimeout(r, interval));
  }
  return null;
}

async function fetchCandidates(gqlURL, token, title) {
  try {
    const q = `
      query($q:String!, $limit:Int!) {
        pages {
          search(query:$q, limit:$limit) {
            results { id path title score }
          }
        }
      }`;
    const data = await gqlRequest(gqlURL, token, q, { q: title, limit: 200 });
    const r = data?.data?.pages?.search?.results || [];
    if (r.length) return r.map(x => ({ id: x.id, path: x.path, title: x.title }));
  } catch (_) { }

  const q2 = `
    query($limit:Int!) {
      pages {
        list(orderBy: TITLE, orderByDirection: ASC, limit: $limit) {
          id path title
        }
      }
    }`;
  const data2 = await gqlRequest(gqlURL, token, q2, { limit: 2000 });
  return data2?.data?.pages?.list || [];
}

async function wikiDeletePage(gqlURL, token, { id, path }) {
  if (!id && path) {
    const data = await gqlRequest(gqlURL, token, `
      query($limit:Int!){
        pages { list(orderBy: TITLE, orderByDirection: ASC, limit:$limit){ id path title } }
      }`, { limit: 2000 });
    const hit = data?.data?.pages?.list?.find(p => (p.path || '') === path);
    if (hit) id = hit.id;
  }
  if (!id) throw new Error('DEL_NO_ID');

  const mutation = `
    mutation($id:Int!){
      pages {
        delete(id:$id){
          responseResult { succeeded errorCode message }
        }
      }
    }`;
  const resp = await gqlRequest(gqlURL, token, mutation, { id: Number(id) });
  const rr = resp?.data?.pages?.delete?.responseResult;
  if (!rr?.succeeded) {
    throw new Error(rr?.errorCode ? `${rr.errorCode} ${rr.message || ''}` : 'DELETE_FAILED');
  }
  await new Promise(r => setTimeout(r, 400));
  return true;
}

// ---------- URL/path 与页面读取 ----------
function buildPathCandidates({ rawPath, baseURL }) {
  const norm = p => {
    if (!p) return '/';
    let s = String(p).trim();
    s = s.replace(/\/+/g, '/');
    if (!s.startsWith('/')) s = '/' + s;
    return s;
  };

  const candidates = new Set();

  if (rawPath) candidates.add(norm(rawPath));

  try {
    if (baseURL) {
      const bu = new URL(baseURL);
      const basePath = bu.pathname.replace(/\/+$/, '');
      if (basePath && rawPath && rawPath.startsWith(basePath)) {
        const stripped = rawPath.slice(basePath.length) || '/';
        candidates.add(norm(stripped));
      }
    }
  } catch (_) { }

  for (const p of [...candidates]) {
    if (p === '/' || p === '/(root)') {
      candidates.add('/');
      candidates.add('/(root)');
    }
  }
  return [...candidates];
}

function extractWikiPath({ url, path: pathFromBody, baseURL }) {
  let pagePath = pathFromBody;

  if (!pagePath) {
    if (!url) return null;
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return null;
    }
    pagePath = u.pathname || '/';
    pagePath = pagePath.split('?')[0].split('#')[0];
  }

  try {
    if (baseURL) {
      const bu = new URL(baseURL);
      let basePath = bu.pathname.replace(/\/+$/, '');
      if (basePath && basePath !== '/' && pagePath.startsWith(basePath + '/')) {
        pagePath = pagePath.slice(basePath.length) || '/';
      } else if (basePath && basePath === pagePath) {
        pagePath = '/';
      }
    }
  } catch (_) { }

  if (!pagePath) pagePath = '/';
  pagePath = pagePath.replace(/\/+/g, '/');
  if (!pagePath.startsWith('/')) pagePath = '/' + pagePath;
  return pagePath;
}

async function loadWikiPageForUser(uid, { url, path: pathFromBody }) {
  const st = db.prepare('SELECT * FROM user_settings WHERE user_id=?').get(uid) || {};
  const gqlURL = st.wiki_graphql_url || DEFAULT_WIKI_GRAPHQL;
  const baseURL = st.wiki_base_url || DEFAULT_WIKI_BASE;
  const token = st.wiki_token_cipher ? dec(st.wiki_token_cipher) : null;

  if (!token) {
    const err = new Error('NO_TOKEN');
    err.code = 'NO_TOKEN';
    throw err;
  }

  const rawPath = extractWikiPath({ url, pathFromBody, baseURL });
  if (!rawPath) {
    const err = new Error('BAD_URL_OR_PATH');
    err.code = 'BAD_URL_OR_PATH';
    throw err;
  }
  const candidates = buildPathCandidates({ rawPath, baseURL });

  const listQuery = `
    query($limit:Int!) {
      pages {
        list(orderBy: TITLE, orderByDirection: ASC, limit:$limit) {
          id
          path
          title
        }
      }
    }`;
  const listData = await gqlRequest(gqlURL, token, listQuery, { limit: 2000 });
  const list = listData?.data?.pages?.list || [];

  let hit = null;
  for (const cand of candidates) {
    hit = list.find(p => (p.path || '') === cand);
    if (hit) break;
  }

  if (!hit) {
    return { page: null, baseURL, candidates };
  }

  const byIdQuery = `
    query($id:Int!) {
      pages {
        single(id:$id) {
          id
          path
          title
          content
        }
      }
    }`;
  const singleData = await gqlRequest(gqlURL, token, byIdQuery, { id: Number(hit.id) });
  const page = singleData?.data?.pages?.single || null;

  return { page, baseURL, candidates };
}

module.exports = {
  normalizeSegment,
  pathify,
  normalizeTitle,
  splitTokens,
  tokenOverlap,
  isAbortErr,
  waitForPageByPath,
  gqlRequest,
  fetchCandidates,
  wikiDeletePage,
  buildPathCandidates,
  extractWikiPath,
  loadWikiPageForUser,
};
