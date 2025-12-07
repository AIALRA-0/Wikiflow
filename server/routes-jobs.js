// routes-jobs.js - Wiki 页面提交任务队列 jobs 相关 API
'use strict';

const { jobs, newJobId } = require('./jobs');
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
  fetchCandidates,
  tokenOverlap,
  wikiDeletePage,
  gqlRequest,
} = require('./wiki-utils');

function registerJobRoutes(app) {
  app.post('/api/jobs/submit', verifyCSRF, assertAuth, async (req, res) => {
    const uid = req.session.uid;
    const { termId, mode, existingId, title, tags, content, cleanup, force, deleteFirst } = req.body || {};
    const desc = String((req.body?.desc ?? req.body?.description ?? '') || '').slice(0, 500);
    if (!title || !content) return res.status(400).json({ ok: false, error: 'MISS_FIELDS' });

    const id = newJobId();
    jobs.set(id, { userId: uid, title, status: 'queued', progress: 0, message: '排队中…' });
    res.json({ ok: true, id });

    (async () => {
      const job = jobs.get(id); if (!job) return;
      try {
        job.status = 'running'; job.progress = 10; job.message = '准备参数…';

        const st = db.prepare('SELECT * FROM user_settings WHERE user_id=?').get(uid) || {};
        const gqlURL = st.wiki_graphql_url || DEFAULT_WIKI_GRAPHQL;
        const baseURL = st.wiki_base_url || DEFAULT_WIKI_BASE;
        const token = st.wiki_token_cipher ? dec(st.wiki_token_cipher) : null;
        const locale = st.locale || DEFAULT_LOCALE;
        const editor = st.editor || DEFAULT_EDITOR;
        if (!token) throw new Error('NO_TOKEN');

        const pathSlug = pathify(title);
        if (!pathSlug) throw new Error('BAD_TITLE');

        job.progress = 20; job.message = '检查可能重复/相似…';
        const candidates = await fetchCandidates(gqlURL, token, title);
        const dupList = (candidates || [])
          .map(p => {
            const ov = tokenOverlap(title, p.title || '');
            return { id: p.id, path: p.path, title: p.title, matchedTokens: ov.matched, similarity: ov.coverage };
          })
          .filter(m => m.matchedTokens.length > 0)
          .sort((a, b) => b.similarity - a.similarity);

        if (dupList.length) {
          job.dups = dupList;
          if (!force) {
            job.status = 'error'; job.progress = 0;
            job.message = '检测到可能重复/相似页面（可改标题；或点“坚持提交”继续）';
            return;
          } else {
            logAction(uid, 'duplicate_override', { title, top: dupList[0] });
            job.message = '检测到可能重复，已按“坚持提交”继续…';
          }
        }

        job.progress = 35; job.message = '提交到 Wiki.js…';
        let resp;
        const normTags = Array.isArray(tags) ? tags.filter(t => t != null).map(String) : [];

        if (mode === 'overwrite' && existingId) {
          if (deleteFirst) {
            job.message = '覆盖：先删除旧页面…';
            await wikiDeletePage(gqlURL, token, { id: Number(existingId) });
            await new Promise(r => setTimeout(r, 400));

            job.message = '覆盖：创建新页面…';
            const mCreate = `
              mutation ($title:String!, $path:String!, $content:String!, $tags:[String]!,
                        $locale:String!, $editor:String!, $description:String!) {
                pages {
                  create(
                    title:$title, path:$path, description:$description, content:$content, tags:$tags,
                    locale:$locale, isPublished:true, isPrivate:false, editor:$editor
                  ) {
                    responseResult { succeeded errorCode slug message }
                    page { id path title }
                  }
                }
              }`;
            resp = await gqlRequest(gqlURL, token, mCreate, {
              title, path: pathSlug, content, tags: normTags,
              locale, editor, description: desc,
            });
          } else {
            const mUpdate = `
              mutation ($id:Int!, $title:String!, $path:String!, $content:String!, $tags:[String]!,
                        $locale:String!, $editor:String!) {
                pages {
                  update(
                    id:$id, title:$title, path:$path, content:$content, tags:$tags,
                    locale:$locale, isPublished:true, isPrivate:false, editor:$editor
                  ) {
                    responseResult { succeeded errorCode slug message }
                    page { id path title }
                  }
                }
              }`;
            resp = await gqlRequest(gqlURL, token, mUpdate, {
              id: Number(existingId), title, path: pathSlug, content,
              tags: normTags, locale, editor,
            });
          }
        } else {
          const mCreate = `
            mutation ($title:String!, $path:String!, $content:String!, $tags:[String]!,
                      $locale:String!, $editor:String!, $description:String!) {
              pages {
                create(
                  title:$title, path:$path, description:$description, content:$content, tags:$tags,
                  locale:$locale, isPublished:true, isPrivate:false, editor:$editor
                ) {
                  responseResult { succeeded errorCode slug message }
                  page { id path title }
                }
              }
            }`;
          resp = await gqlRequest(gqlURL, token, mCreate, {
            title, path: pathSlug, content, tags: normTags,
            locale, editor, description: desc,
          });
        }

        const rr = resp.data?.pages?.create?.responseResult || resp.data?.pages?.update?.responseResult;
        const page = resp.data?.pages?.create?.page || resp.data?.pages?.update?.page;
        if (!rr?.succeeded) {
          throw new Error(`WIKI_FAIL ${rr?.errorCode || ''} ${rr?.message || ''}`.trim());
        }

        if (cleanup && termId) {
          db.prepare('DELETE FROM terms WHERE id=? AND user_id=?').run(Number(termId), uid);
        }

        const url = baseURL.replace(/\/+$/, '') + (page.path.startsWith('/') ? page.path : '/' + page.path);
        logAction(uid, 'wiki_submit_ok', { title, url, mode: mode || 'create' });

        job.progress = 100; job.status = 'done'; job.url = url; job.message = '完成';
      } catch (err) {
        logAction(uid, 'wiki_submit_fail', { title, err: String(err?.message || err) });
        const job2 = jobs.get(id); if (!job2) return;
        job2.status = 'error'; job2.progress = 0; job2.message = String(err?.message || err);
      }
    })();
  });

  app.get('/api/jobs/:id', assertAuth, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.userId !== req.session.uid) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    }
    res.json({
      ok: true,
      id: req.params.id,
      title: job.title,
      status: job.status,
      progress: job.progress,
      message: job.message,
      url: job.url,
      dups: job.dups,
    });
  });

  app.get('/api/jobs', assertAuth, (req, res) => {
    const uid = req.session.uid;
    const items = [];
    for (const [id, j] of jobs.entries()) {
      if (j.userId === uid) {
        items.push({ id, title: j.title, status: j.status, progress: j.progress, message: j.message, url: j.url });
      }
    }
    items.sort((a, b) => {
      const ra = (a.status === 'done' || a.status === 'error') ? 1 : 0;
      const rb = (b.status === 'done' || b.status === 'error') ? 1 : 0;
      return ra - rb || (b.progress - a.progress);
    });
    res.json({ ok: true, items });
  });

  app.post('/api/jobs/clear', verifyCSRF, assertAuth, (req, res) => {
    const uid = req.session.uid;
    const { scope } = req.body || {};
    for (const [id, j] of [...jobs.entries()]) {
      if (j.userId !== uid) continue;
      if (scope === 'all' || (scope === 'done' && (j.status === 'done' || j.status === 'error'))) {
        jobs.delete(id);
      }
    }
    res.json({ ok: true });
  });
}

module.exports = {
  registerJobRoutes,
};
