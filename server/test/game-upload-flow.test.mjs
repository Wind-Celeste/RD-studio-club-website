import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHmac } from 'node:crypto'
import { openDatabase } from '../database.mjs'
import { createApp } from '../app.mjs'

async function setupGameTest(t) {
  const db = openDatabase(':memory:')
  const dataDir = mkdtempSync(join(tmpdir(), 'rd-game-test-'))
  const secret = 'game-upload-test-secret-at-least-thirty-two-bytes'
  const cookies = {}
  let time = Date.now()

  for (const role of ['admin', 'creator', 'player']) {
    db.prepare('INSERT INTO users(id,github_id,github_username) VALUES(?,?,?)').run(role, role, role)
    db.prepare('INSERT INTO profiles(id,username,role) VALUES(?,?,?)').run(role, role, role === 'admin' ? 'admin' : 'user')
    const sid = randomUUID()
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(
      sid,
      JSON.stringify({ passport: { user: role }, cookie: { expires: new Date(time + 86400000), httpOnly: true, path: '/' } }),
      time + 86400000
    )
    cookies[role] = 'rd.sid=' + encodeURIComponent('s:' + sid + '.' + createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, ''))
  }

  const server = createApp(db, {
    now: () => time,
    dataDir,
    production: false,
    sessionSecret: secret,
    siteUrl: 'http://localhost',
    maxUploadMb: 50,
    adminGithubIds: []
  }).listen(0, '127.0.0.1')

  await new Promise(r => server.once('listening', r))
  t.after(async () => {
    await new Promise(r => server.close(r))
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  async function api(path, role = null, method = 'GET', body = null, extraHeaders = {}) {
    const headers = {
      'X-RD-CSRF': '1',
      ...(role ? { Cookie: cookies[role] } : {}),
      ...(body && typeof body === 'object' && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders
    }
    const reqBody = Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers, body: reqBody })
    const text = await response.text()
    return {
      status: response.status,
      data: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text
    }
  }

  return { db, api, cookies, dataDir }
}

test('完整游戏上传与发布生命周期测试', async t => {
  const { api } = await setupGameTest(t)

  // 1. 上传游戏封面图片 (有效 PNG 1x1 像素)
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG 头部
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
    0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54,
    0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a,
    0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
  ])
  const coverPath = `creator/cover-${randomUUID()}.png`
  const uploadCoverRes = await api(`/storage/catalog/${coverPath}`, 'creator', 'POST', pngHeader, { 'Content-Type': 'image/png' })
  assert.equal(uploadCoverRes.status, 201)
  const coverFileId = uploadCoverRes.data.id
  assert.ok(coverFileId)

  // 2. 上传游戏包（zip 包或试玩包）
  const zipData = Buffer.from('PK\x03\x04' + 'MockGameDataForTesting')
  const gamePath = `creator/game-${randomUUID()}.zip`
  const uploadGameRes = await api(`/storage/catalog/${gamePath}`, 'creator', 'POST', zipData, { 'Content-Type': 'application/zip' })
  assert.equal(uploadGameRes.status, 201)
  const gameFileId = uploadGameRes.data.id
  assert.ok(gameFileId)

  // 3. 发布游戏 (POST /api/catalog, kind='game')
  const gamePayload = {
    kind: 'game',
    title: '我的独立游戏：勇者历险记',
    summary: '一款由 RD-Studio 社团成员开发的 2D 像素冒险游戏',
    content: `# 勇者历险记\n\n欢迎体验！支持手柄和键盘操作。\n\n![封面](/api/files/catalog/${coverPath})`,
    version: 'v1.0.0',
    platform: 'Windows, WebGL',
    license: 'MIT',
    external_url: 'https://pan.baidu.com/s/sample_game_link',
    cover_id: coverFileId,
    assets: [coverFileId, gameFileId],
    status: 'published' // 普通用户提交将自动转为 pending 等待审核
  }

  const createGameRes = await api('/catalog', 'creator', 'POST', gamePayload)
  assert.equal(createGameRes.status, 201)
  const gameId = createGameRes.data.id
  assert.equal(createGameRes.data.status, 'pending') // 普通用户被自动重置为 pending

  // 4. 验证审核前：游客看不到，作者在 mine 里可以看到
  const publicListBefore = await api('/catalog')
  assert.equal(publicListBefore.data.items.length, 0)

  const creatorList = await api('/catalog?scope=mine', 'creator')
  assert.equal(creatorList.data.items.length, 1)
  assert.equal(creatorList.data.items[0].id, gameId)

  // 5. 管理员审核通过该游戏
  const reviewRes = await api(`/catalog/${gameId}/review`, 'admin', 'POST', {
    status: 'published',
    revision: 1
  })
  assert.equal(reviewRes.status, 200)

  // 6. 审核通过后：公众专区可见，包含下载和详情
  const publicListAfter = await api('/catalog?kind=game')
  assert.equal(publicListAfter.data.items.length, 1)
  assert.equal(publicListAfter.data.items[0].title, '我的独立游戏：勇者历险记')
  assert.equal(publicListAfter.data.items[0].kind, 'game')

  // 7. 玩家下载游戏附件或外部链接，测试下载计数递增
  const downloadGameRes = await api(`/catalog/${gameId}/download`, 'player', 'POST', { target: gameFileId })
  assert.equal(downloadGameRes.status, 200)
  assert.equal(downloadGameRes.data.downloads, 1)

  // 8. 验证下载附件可以被公开访问
  const fileFetchRes = await api(`/files/catalog/${gamePath}`)
  assert.equal(fileFetchRes.status, 200)
})
