// routes-wiki.js - Wiki.js 查重/提交/读取页面相关 API
'use strict';

const { db, logAction } = require('./db');
const { assertAuth, verifyCSRF, dec } = require('./security');
const {
  DEFAULT_WIKI_BASE,
  DEFAULT_WIKI_GRAPHQL,
  DEFAULT_LOCALE,
  DEFAULT_EDITOR,
} = require('../server-js/wf-server-config.js');
const {
  pathify,
  tokenOverlap,
  fetchCandidates,
  wikiDeletePage,
  gqlRequest,
  loadWikiPageForUser,
} = require('./wiki-utils');

function registerWikiRoutes(app) {
  // 查重
  app.post('/api/wiki/check-duplicate', verifyCSRF, assertAuth, async (req, res) => {
    const uid = req.session.uid;
    const { title } = req.body || {};
    if (!title) return res.status(400).json({ ok: false, error: 'NO_TITLE' });

    const st = db.prepare('SELECT * FROM user_settings WHERE user_id=?').get(uid) || {};
    const gqlURL = st.wiki_graphql_url || DEFAULT_WIKI_GRAPHQL;
    const token = st.wiki_token_cipher ? dec(st.wiki_token_cipher) : null;
    if (!token) return res.status(400).json({ ok: false, error: 'NO_TOKEN' });

    function norm(s) {
      return (s || '')
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[^\w\u4e00-\u9fa5]/g, '');
    }

    function similarity(a, b) {
      const x = norm(a);
      const y = norm(b);
      if (!x || !y) return 0;

      if (x === y) return 1;

      if (x.includes(y) || y.includes(x)) {
        const maxLen = Math.max(x.length, y.length) || 1;
        const minLen = Math.min(x.length, y.length) || 0;
        return minLen / maxLen;
      }

      const sa = new Set(x.split(''));
      const sb = new Set(y.split(''));
      let inter = 0;
      for (const ch of sa) {
        if (sb.has(ch)) inter++;
      }
      const uni = new Set([...sa, ...sb]).size || 1;
      return inter / uni;
    }

    function longestTokenLen(arr) {
      return (arr || []).reduce((m, t) => Math.max(m, (t || '').length), 0);
    }

    const candidates = await fetchCandidates(gqlURL, token, title);
    const queryNorm = norm(title);

    const matches = (candidates || [])
      .map((p) => {
        const candTitle = String(p.title || '').trim();
        if (!candTitle) return null;

        const ov = tokenOverlap(title, candTitle) || { matched: [], coverage: 0 };
        const matchedTokens = ov.matched || [];
        const tokenCoverage = ov.coverage || 0;
        const titleSim = similarity(title, candTitle) || 0;
        const maxTokenLen = longestTokenLen(matchedTokens);

        const candNorm = norm(candTitle);
        if (candNorm && candNorm === queryNorm) {
          return {
            id: p.id,
            path: p.path,
            title: candTitle,
            matchedTokens,
            similarity: 1,
            tokenCoverage: 1,
            titleSimilarity: 1,
            maxTokenLen,
          };
        }

        const primary = Math.max(tokenCoverage, titleSim);
        const secondary = Math.min(tokenCoverage, titleSim);
        const combined = 0.7 * primary + 0.3 * secondary;

        return {
          id: p.id,
          path: p.path,
          title: candTitle,
          matchedTokens,
          similarity: combined,
          tokenCoverage,
          titleSimilarity: titleSim,
          maxTokenLen,
        };
      })
      .filter((m) => {
        if (!m) return false;
        if (m.similarity < 0.3) return false;
        if ((!m.matchedTokens || !m.matchedTokens.length) && m.titleSimilarity < 0.85) {
          return false;
        }
        if ((m.maxTokenLen || 0) <= 1 && m.titleSimilarity < 0.85) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b.similarity - a.similarity);

    res.json({ ok: true, matches });
  });

  // 删除页面
  app.post('/api/wiki/delete', verifyCSRF, assertAuth, async (req, res) => {
    const uid = req.session.uid;
    const { id, path: pagePath } = req.body || {};

    const st = db.prepare('SELECT * FROM user_settings WHERE user_id=?').get(uid) || {};
    const gqlURL = st.wiki_graphql_url || DEFAULT_WIKI_GRAPHQL;
    const token = st.wiki_token_cipher ? dec(st.wiki_token_cipher) : null;
    if (!token) return res.status(400).json({ ok: false, error: 'NO_TOKEN' });
    if (!id && !pagePath) return res.status(400).json({ ok: false, error: 'MISS_ID_OR_PATH' });

    try {
      await wikiDeletePage(gqlURL, token, { id, path: pagePath });
      logAction(uid, 'wiki_delete_ok', { id, path: pagePath });
      res.json({ ok: true });
    } catch (e) {
      logAction(uid, 'wiki_delete_fail', { id, path: pagePath, err: String(e?.message || e) });
      res.status(500).json({ ok: false, error: 'DELETE_FAIL', message: String(e?.message || e) });
    }
  });

  // 直接提交页面（不经过内存 jobs 队列）
  app.post('/api/wiki/submit', verifyCSRF, assertAuth, async (req, res) => {
    const uid = req.session.uid;
    const { mode, existingId, title, tags, content } = req.body || {};
    const desc = String((req.body?.desc ?? req.body?.description ?? '') || '').slice(0, 500);

    if (!title || !content) {
      return res.status(400).json({ ok: false, error: 'MISS_FIELDS' });
    }

    const st = db.prepare('SELECT * FROM user_settings WHERE user_id=?').get(uid) || {};
    const gqlURL = st.wiki_graphql_url || DEFAULT_WIKI_GRAPHQL;
    const baseURL = st.wiki_base_url || DEFAULT_WIKI_BASE;
    const token = st.wiki_token_cipher ? dec(st.wiki_token_cipher) : null;
    const locale = st.locale || DEFAULT_LOCALE;
    const editor = st.editor || DEFAULT_EDITOR;

    if (!token) {
      return res.status(400).json({ ok: false, error: 'NO_TOKEN' });
    }

    let pathSlug = pathify(title);
    if (!pathSlug) {
      return res.status(400).json({ ok: false, error: 'BAD_TITLE' });
    }

    try {
      let resp;
      const normTags = Array.isArray(tags) ? tags.filter(t => t != null).map(String) : [];

      if (mode === 'overwrite' && existingId) {
        const mutation = `
        mutation ($id:Int!, $title:String!, $path:String!, $content:String!, $tags:[String]!, $locale:String!, $editor:String!, $description:String!) {
          pages {
            update(
              id:$id, title:$title, path:$path, content:$content, tags:$tags,
              locale:$locale, isPublished:true, isPrivate:false, editor:$editor
              , description:$description
            ) {
              responseResult { succeeded errorCode slug message }
              page { id path title }
            }
          }
        }`;

        resp = await gqlRequest(gqlURL, token, mutation, {
          id: Number(existingId),
          title,
          path: pathSlug,
          content,
          tags: normTags,
          description: desc,
          locale,
          editor,
        });
      } else {
        const mutation = `
        mutation ($title:String!, $path:String!, $content:String!, $tags:[String]!, $locale:String!, $editor:String!, $description:String!) {
          pages {
            create(
              title:$title, path:$path, description:$description, content:$content, tags:$tags,
              locale:$locale, isPublished:true, isPrivate:false, editor:$editor
            )  {
              responseResult { succeeded errorCode slug message }
              page { id path title }
            }
          }
        }`;

        resp = await gqlRequest(gqlURL, token, mutation, {
          title,
          path: pathSlug,
          content,
          tags: normTags,
          locale,
          editor,
          description: desc,
        });
      }

      const rr = resp.data?.pages?.create?.responseResult || resp.data?.pages?.update?.responseResult;
      const page = resp.data?.pages?.create?.page || resp.data?.pages?.update?.page;

      if (!rr?.succeeded) {
        return res.status(409).json({
          ok: false,
          error: 'WIKI_FAIL',
          code: rr?.errorCode,
          slug: rr?.slug,
          message: rr?.message,
        });
      }

      db.prepare(`
        INSERT INTO terms (user_id, term, status, title, tags_json, content, wiki_page_id, wiki_path)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(
        uid,
        title,
        'posted',
        title,
        JSON.stringify(tags || []),
        content.slice(0, 200000),
        page.id,
        page.path
      );

      const url = baseURL.replace(/\/+$/, '') + (page.path.startsWith('/') ? page.path : '/' + page.path);
      logAction(uid, 'wiki_submit_ok', { title, url, mode: mode || 'create' });

      res.json({ ok: true, url, page });
    } catch (err) {
      logAction(uid, 'wiki_submit_fail', { title, err: String(err?.message || err) });

      return res.status(500).json({
        ok: false,
        error: 'WIKI_SUBMIT_FAIL',
        message: String(err?.message || err),
      });
    }
  });

  // 读取单个页面（新接口）
  app.post('/api/wiki/get', verifyCSRF, assertAuth, async (req, res) => {
    const uid = req.session.uid;
    const { url, path: pathFromBody } = req.body || {};

    try {
      const { page } = await loadWikiPageForUser(uid, { url, path: pathFromBody });

      if (!page) {
        return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
      }

      return res.json({
        ok: true,
        page: {
          id: page.id,
          path: page.path,
          title: page.title,
          content: page.content || '',
        },
      });
    } catch (e) {
      console.error('[wiki.get] FAIL', e);

      if (e.code === 'NO_TOKEN') {
        return res.status(400).json({ ok: false, error: 'NO_TOKEN' });
      }
      if (e.code === 'BAD_URL_OR_PATH') {
        return res.status(400).json({ ok: false, error: 'BAD_URL_OR_PATH' });
      }

      return res.status(500).json({
        ok: false,
        error: 'GQL_FAIL',
        message: String(e?.message || e),
      });
    }
  });

  // 兼容老前端：只取 content + 少量 meta
  app.post('/api/wiki/get-content', verifyCSRF, assertAuth, async (req, res) => {
    const uid = req.session.uid;
    const { url, path: pathFromBody } = req.body || {};

    try {
      const { page } = await loadWikiPageForUser(uid, { url, path: pathFromBody });

      if (!page) {
        return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
      }

      return res.json({
        ok: true,
        content: page.content || '',
        meta: {
          id: page.id,
          path: page.path,
          title: page.title,
        },
      });
    } catch (e) {
      console.error('[wiki.get-content] FAIL', e);

      if (e.code === 'NO_TOKEN') {
        return res.status(400).json({ ok: false, error: 'NO_TOKEN' });
      }
      if (e.code === 'BAD_URL_OR_PATH') {
        return res.status(400).json({ ok: false, error: 'BAD_URL_OR_PATH' });
      }

      return res.status(500).json({
        ok: false,
        error: 'GQL_FAIL',
        message: String(e?.message || e),
      });
    }
  });
}

module.exports = {
  registerWikiRoutes,
};
