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

  // 1. 普通管理尝试授予权限 -> 应被拒绝 403
  const failRes = await api('/admin/members/plain_user/role', 'normal_admin_user', 'POST', { role: 'admin' })
  assert.equal(failRes.status, 403)

  // 2. 总管理授予 plain_user 管理员权限 -> 成功 200
  const successRes = await api('/admin/members/plain_user/role', 'super_admin_user', 'POST', { role: 'admin' })
  assert.equal(successRes.status, 200)

  // 验证数据库状态
  const updatedUser = db.prepare('SELECT role, is_super_admin FROM profiles WHERE id=?').get('plain_user')
  assert.equal(updatedUser.role, 'admin')
  assert.equal(updatedUser.is_super_admin, 0)

  // 3. 总管理还可以撤销管理权限
  const revokeRes = await api('/admin/members/plain_user/role', 'super_admin_user', 'POST', { role: 'member' })
  assert.equal(revokeRes.status, 200)
  assert.equal(db.prepare('SELECT role FROM profiles WHERE id=?').get('plain_user').role, 'member')
})

test('管理和总管理可以更改别人的标签，支持自定义颜色与内容，普通用户不可更改', async t => {
  const { db, api } = await setupTest(t)

  // 1. 普通用户尝试修改标签 -> 拒绝 403
  const userTry = await api('/admin/members/regular_member_user/badge', 'plain_user', 'POST', {
    text: '资深社员',
    color: '#10b981'
  })
  assert.equal(userTry.status, 403)

  // 2. 普通管理员为社员授予自定义标签（内容：资深社员，颜色：#10b981） -> 成功 200
  const adminSet = await api('/admin/members/regular_member_user/badge', 'normal_admin_user', 'POST', {
    text: '资深社员',
    color: '#10b981'
  })
  assert.equal(adminSet.status, 200)

  // 验证数据库中该成员的标签内容和颜色
  const memberProfile = db.prepare('SELECT badge_text, badge_color FROM profiles WHERE id=?').get('regular_member_user')
  assert.equal(memberProfile.badge_text, '资深社员')
  assert.equal(memberProfile.badge_color, '#10b981')

  // 3. 总管理修改为另一个自定义标签与颜色
  const superSet = await api('/admin/members/regular_member_user/badge', 'super_admin_user', 'POST', {
    text: '核心技术支持',
    color: '#3b82f6'
  })
  assert.equal(superSet.status, 200)
  const memberUpdated = db.prepare('SELECT badge_text, badge_color FROM profiles WHERE id=?').get('regular_member_user')
  assert.equal(memberUpdated.badge_text, '核心技术支持')
  assert.equal(memberUpdated.badge_color, '#3b82f6')

  // 4. 非法颜色拦截测试
  const invalidColor = await api('/admin/members/regular_member_user/badge', 'normal_admin_user', 'POST', {
    text: '测试',
    color: 'invalid-red'
  })
  assert.equal(invalidColor.status, 400)
})

test('更改头像和昵称不用提交申请，直接自动通过生效', async t => {
  const { db, api, dataDir } = await setupTest(t)

  // 创建一个上传好的合法头像文件记录
  const avatarFileId = randomUUID()
  const avatarPath = 'plain_user/' + avatarFileId + '/avatar.png'
  db.prepare("INSERT INTO files(id,bucket,path,owner_id,mime,size) VALUES(?,'avatars',?,'plain_user','image/png',1024)").run(
    avatarFileId, avatarPath
  )
  writeFileSync(join(dataDir, 'uploads', avatarFileId), 'dummy-png-content')

  // 普通用户 plain_user 提交修改头像与昵称
  const changeRes = await api('/data/profile_changes', 'plain_user', 'POST', {
    username: '新昵称小明',
    avatar_url: '/api/files/avatars/' + avatarPath,
    bio: '这是我的新个人签名'
  })

  assert.equal(changeRes.status, 200)
  assert.equal(changeRes.data[0].status, 'approved') // 自动通过，不是 pending！

  // 检查 profiles 表，确认资料已经直接更新生效！
  const profile = db.prepare('SELECT username, avatar_url, bio FROM profiles WHERE id=?').get('plain_user')
  assert.equal(profile.username, '新昵称小明')
  assert.equal(profile.avatar_url, '/api/files/avatars/' + avatarPath)
  assert.equal(profile.bio, '这是我的新个人签名')
})
