import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHmac } from 'node:crypto'
import { openDatabase } from '../database.mjs'
import { createApp } from '../app.mjs'

test('comments are auto-approved for all users and admin overview excludes comment/profile review queues', async (t) => {
  const db = openDatabase(':memory:')
  const dataDir = mkdtempSync(join(tmpdir(), 'rd-comment-test-'))
  const secret = 'admin-system-update-secret-thirty-two-chars-min'
  const cookies = {}
  let time = Date.now()

  const roles = [
    { id: 'admin_user', role: 'admin', is_super: 1 },
    { id: 'normal_member_user', role: 'member', is_super: 0 }
  ]

  for (const r of roles) {
    db.prepare('INSERT INTO users(id,github_id,github_username) VALUES(?,?,?)').run(r.id, r.id, r.id)
    db.prepare('INSERT INTO profiles(id,username,role,is_super_admin) VALUES(?,?,?,?)').run(r.id, r.id, r.role, r.is_super)
    const sid = randomUUID()
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(
      sid,
      JSON.stringify({ passport: { user: r.id }, cookie: { expires: new Date(time + 86400000), httpOnly: true, path: '/' } }),
      time + 86400000
    )
    cookies[r.id] = 'rd.sid=' + encodeURIComponent('s:' + sid + '.' + createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, ''))
  }

  const articleId = 'test_article_' + randomUUID()
  db.prepare("INSERT INTO articles(id,author_id,title,content,status,visibility) VALUES(?,?,'Test','Content','published','public')").run(articleId, 'normal_member_user')

  const server = createApp(db, {
    now: () => time,
    dataDir,
    production: false,
    sessionSecret: secret,
    siteUrl: 'http://localhost',
    maxUploadMb: 10,
    adminGithubIds: []
  }).listen(0, '127.0.0.1')

  await new Promise(r => server.once('listening', r))
  t.after(async () => {
    await new Promise(r => server.close(r))
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  async function api(path, asUser = null, method = 'GET', body = null) {
    const headers = {
      'X-RD-CSRF': '1',
      ...(asUser ? { Cookie: cookies[asUser] } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    }
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null
    }
  }

  // 1. Verify admin overview sections
  const overviewRes = await api('/admin/overview', 'admin_user')
  assert.equal(overviewRes.status, 200)
  const kinds = overviewRes.body.queues.map(q => q.kind)
  assert.ok(!kinds.includes('comment'), 'overview should not include comment queue')
  assert.ok(!kinds.includes('profile'), 'overview should not include profile queue')

  // 2. Post comment as normal member
  const postRes = await api('/comments', 'normal_member_user', 'POST', {
    article_id: articleId,
    content: '这是一条普通用户的免审评论测试'
  })
  assert.equal(postRes.status, 201)
  assert.equal(postRes.body.status, 'approved', 'normal user comment should be directly approved')

  // 3. Verify in database
  const saved = db.prepare('SELECT status, review_note FROM comments WHERE id=?').get(postRes.body.id)
  assert.equal(saved.status, 'approved', 'comment in DB should be approved')
  assert.equal(saved.review_note, '免审直接发布')

  const articleRecord = db.prepare('SELECT comments_count FROM articles WHERE id=?').get(articleId)
  assert.equal(articleRecord.comments_count, 1, 'article comments_count should increment immediately')
})
