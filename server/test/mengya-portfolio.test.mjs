import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHmac } from 'node:crypto'
import { openDatabase } from '../database.mjs'
import { createApp } from '../app.mjs'

async function setupTest(t) {
  const db = openDatabase(':memory:')
  const dataDir = mkdtempSync(join(tmpdir(), 'rd-mengya-test-'))
  const secret = 'mengya-portfolio-test-secret-at-least-32-chars'
  const cookies = {}
  let time = Date.now()

  const roles = [
    { id: 'super_admin_user', role: 'admin', is_super: 1 },
    { id: 'regular_user', role: 'user', is_super: 0 }
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

  return { db, api }
}

test('系统默认内置“萌芽作品集”无 GitHub 官方账号', async t => {
  const { db } = await setupTest(t)
  const profile = db.prepare("SELECT * FROM profiles WHERE id='system-mengya-portfolio'").get()
  assert.ok(profile)
  assert.equal(profile.username, '萌芽作品集')
  assert.equal(profile.badge_text, '官方展区')

  const user = db.prepare("SELECT * FROM users WHERE id='system-mengya-portfolio'").get()
  assert.ok(user)
  assert.equal(user.github_id, 'system:mengya-portfolio') // 格式安全，无法从真实 GitHub 登录
})

test('总管理发布游戏时可以指定以“萌芽作品集”身份发布并直接公开', async t => {
  const { db, api } = await setupTest(t)

  const payload = {
    kind: 'game',
    title: '社团游戏精选：萌芽先锋',
    summary: '由萌芽作品集官方收录的社团优秀游戏作品',
    content: '# 萌芽先锋\n\n欢迎游玩！',
    version: '1.0.0',
    platform: 'PC / WebGL',
    license: 'CC-BY-NC',
    external_url: 'https://pan.baidu.com/s/sample_mengya_game',
    status: 'published',
    assets: [],
    author_id: 'system-mengya-portfolio' // 总管理指定以萌芽作品集发布
  }

  // 总管理发布
  const createRes = await api('/catalog', 'super_admin_user', 'POST', payload)
  assert.equal(createRes.status, 201)
  const gameId = createRes.data.id

  // 验证作品在数据库中的作者确实是萌芽作品集，并且处于已发布状态
  const itemInDb = db.prepare('SELECT author_id, status, title FROM catalog_items WHERE id=?').get(gameId)
  assert.equal(itemInDb.author_id, 'system-mengya-portfolio')
  assert.equal(itemInDb.status, 'published')

  // 公开接口查看该游戏，展示的作者名字应为“萌芽作品集”
  const detailRes = await api(`/catalog/${gameId}`)
  assert.equal(detailRes.status, 200)
  assert.equal(detailRes.data.username, '萌芽作品集')

  // 总管理可以对萌芽作品集的游戏进行编辑
  const editRes = await api(`/catalog/${gameId}`, 'super_admin_user', 'PUT', {
    ...payload,
    summary: '更新后的精选简介',
    revision: 1
  })
  assert.equal(editRes.status, 200)

  // 普通用户发布时如果试图指定萌芽作品集，会自动将其发布者归还为其自身，防止越权
  const userTry = await api('/catalog', 'regular_user', 'POST', {
    ...payload,
    title: '普通用户试图冒名游戏',
    assets: [],
    author_id: 'system-mengya-portfolio'
  })
  assert.equal(userTry.status, 201)
  const userItem = db.prepare('SELECT author_id FROM catalog_items WHERE id=?').get(userTry.data.id)
  assert.equal(userItem.author_id, 'regular_user')
})
