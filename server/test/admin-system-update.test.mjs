import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHmac } from 'node:crypto'
import { openDatabase } from '../database.mjs'
import { createApp } from '../app.mjs'

async function setupTest(t) {
  const db = openDatabase(':memory:')
  const dataDir = mkdtempSync(join(tmpdir(), 'rd-admin-test-'))
  const secret = 'admin-system-update-secret-thirty-two-chars-min'
  const cookies = {}
  let time = Date.now()

  const roles = [
    { id: 'super_admin_user', role: 'admin', is_super: 1 },
    { id: 'normal_admin_user', role: 'admin', is_super: 0 },
    { id: 'regular_member_user', role: 'member', is_super: 0 },
    { id: 'plain_user', role: 'user', is_super: 0 }
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
      data: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text
    }
  }

  return { db, api, dataDir }
}

test('总管理可以授予别人管理，普通管理不能授予管理', async t => {
  const { db, api } = await setupTest(t)

  const failRes = await api('/admin/members/plain_user/role', 'normal_admin_user', 'POST', { role: 'admin' })
  assert.equal(failRes.status, 403)

  const successRes = await api('/admin/members/plain_user/role', 'super_admin_user', 'POST', { role: 'admin' })
  assert.equal(successRes.status, 200)

  const updatedUser = db.prepare('SELECT role, is_super_admin FROM profiles WHERE id=?').get('plain_user')
  assert.equal(updatedUser.role, 'admin')
  assert.equal(updatedUser.is_super_admin, 0)

  const revokeRes = await api('/admin/members/plain_user/role', 'super_admin_user', 'POST', { role: 'member' })
  assert.equal(revokeRes.status, 200)
  assert.equal(db.prepare('SELECT role FROM profiles WHERE id=?').get('plain_user').role, 'member')
})

test('管理和总管理可以更改别人的标签，支持自定义颜色与内容，普通用户不可更改', async t => {
  const { db, api } = await setupTest(t)

  const userTry = await api('/admin/members/regular_member_user/badge', 'plain_user', 'POST', {
    text: '资深社员',
    color: '#10b981'
  })
  assert.equal(userTry.status, 403)

  const adminSet = await api('/admin/members/regular_member_user/badge', 'normal_admin_user', 'POST', {
    text: '资深社员',
    color: '#10b981'
  })
  assert.equal(adminSet.status, 200)

  const memberProfile = db.prepare('SELECT badge_text, badge_color FROM profiles WHERE id=?').get('regular_member_user')
  assert.equal(memberProfile.badge_text, '资深社员')
  assert.equal(memberProfile.badge_color, '#10b981')

  const superSet = await api('/admin/members/regular_member_user/badge', 'super_admin_user', 'POST', {
    text: '核心技术支持',
    color: '#3b82f6'
  })
  assert.equal(superSet.status, 200)
  const memberUpdated = db.prepare('SELECT badge_text, badge_color FROM profiles WHERE id=?').get('regular_member_user')
  assert.equal(memberUpdated.badge_text, '核心技术支持')
  assert.equal(memberUpdated.badge_color, '#3b82f6')
})

test('更改头像和昵称不用提交申请，直接自动通过生效', async t => {
  const { db, api, dataDir } = await setupTest(t)

  const avatarFileId = randomUUID()
  const avatarPath = 'plain_user/' + avatarFileId + '/avatar.png'
  db.prepare("INSERT INTO files(id,bucket,path,owner_id,mime,size) VALUES(?,'avatars',?,'plain_user','image/png',1024)").run(
    avatarFileId, avatarPath
  )
  writeFileSync(join(dataDir, 'uploads', avatarFileId), 'dummy-png-content')

  const changeRes = await api('/data/profile_changes', 'plain_user', 'POST', {
    username: '新昵称小明',
    avatar_url: '/api/files/avatars/' + avatarPath,
    bio: '这是我的新个人签名'
  })

  assert.equal(changeRes.status, 200)
  assert.equal(changeRes.data[0].status, 'approved')

  const profile = db.prepare('SELECT username, avatar_url, bio FROM profiles WHERE id=?').get('plain_user')
  assert.equal(profile.username, '新昵称小明')
  assert.equal(profile.avatar_url, '/api/files/avatars/' + avatarPath)
  assert.equal(profile.bio, '这是我的新个人签名')
})

test('管理的所有申请都直接免审通过生效', async t => {
  const { db, api } = await setupTest(t)

  // 1. 管理员发布文章 -> 直接 published
  const articleRes = await api('/data/articles', 'normal_admin_user', 'POST', {
    title: '管理员技术周刊',
    summary: '周刊摘要',
    content: '# 详细内容\n这是一篇管理员文章。',
    visibility: 'public',
    status: 'published'
  })
  assert.equal(articleRes.status, 200)
  const articleId = articleRes.data[0].id
  const article = db.prepare('SELECT status, published_at FROM articles WHERE id=?').get(articleId)
  assert.equal(article.status, 'published')
  assert.ok(article.published_at)

  // 2. 管理员发表评论 -> 直接 approved
  const commentRes = await api('/comments', 'normal_admin_user', 'POST', {
    article_id: articleId,
    content: '管理员第一条精彩点评！'
  })
  assert.equal(commentRes.status, 201)
  assert.equal(commentRes.data.status, 'approved')
  const comment = db.prepare('SELECT status FROM comments WHERE id=?').get(commentRes.data.id)
  assert.equal(comment.status, 'approved')

  // 3. 管理员申请知识库分支 -> 直接 approved 并自动建好分支挂载
  const branchReqRes = await api('/data/knowledge_branch_requests', 'normal_admin_user', 'POST', {
    article_id: articleId,
    requested_path: '游戏开发/Godot引擎',
    requested_description: 'Godot分支简介'
  })
  assert.equal(branchReqRes.status, 200)
  assert.equal(branchReqRes.data[0].status, 'approved')
  const articleAfterKb = db.prepare('SELECT kb_enabled, kb_branch_id FROM articles WHERE id=?').get(articleId)
  assert.equal(articleAfterKb.kb_enabled, 1)
  assert.ok(articleAfterKb.kb_branch_id)
})
