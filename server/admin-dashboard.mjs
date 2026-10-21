import {randomUUID,createHash} from 'node:crypto'
import {fail} from './repository.mjs'
import {formalMember} from './experience.mjs'
import {adminAudit} from './admin-audit.mjs'
const sections=[
  {kind:'article',label:'文章',table:'articles',owner:'author_id',title:'title',preview:'summary',href:'/admin/articles'},
  {kind:'comment',label:'评论',table:'comments',owner:'user_id',title:"'评论'",preview:'content',href:'/admin/comments/'},
  {kind:'catalog',label:'游戏/工具',table:'catalog_items',owner:'author_id',title:'title',preview:'summary',href:'/games-tools/?scope=review'},
  {kind:'profile',label:'个人资料',table:'profile_changes',owner:'user_id',title:"'个人资料修改'",preview:'bio',href:'/admin/profile-review'},
  {kind:'branch',label:'知识库申请',table:'knowledge_branch_requests',owner:'requester_id',title:'requested_path',preview:'requested_description',href:'/admin/kb'},
  {kind:'proof',label:'任务证明',table:'task_submissions',owner:'user_id',title:"'任务证明'",preview:'note',href:'/admin/tasks?view=reviews'}
]
const queueSql=sections.map(s=>`SELECT '${s.kind}' kind,t.id,${s.title.startsWith("'")?s.title:'t.'+s.title} title,substr(t.${s.preview},1,240) preview,t.${s.owner} user_id,p.username,p.avatar_url,t.${s.kind==='proof'?'submitted_at':'created_at'} created_at,'${s.href}' href FROM ${s.table} t LEFT JOIN profiles p ON p.id=t.${s.owner} WHERE t.status='pending'`).join(' UNION ALL ')
const offsetOf=req=>{const offset=Number(req.query.offset||0);if(!Number.isSafeInteger(offset)||offset<0||offset>100000)fail(400,'页码无效');return offset}
const text=(value,max,required=true)=>{if(typeof value!=='string'||value.length>max||required&&!value.trim())fail(400,'请填写有效内容');return value.trim()}
export function installAdminDashboard(app,db,repository,now=Date.now){
  app.use('/api/admin',(req,_res,next)=>{if(!req.user)fail(401,'请先登录');if(req.user.role!=='admin')fail(403,'需要管理员权限');next()})
  app.get('/api/admin/overview',(_req,res)=>{
    const queues=sections.map(s=>({...s,count:db.prepare(`SELECT count(*) n FROM ${s.table} WHERE status='pending'`).get().n})).map(({kind,label,href,count})=>({kind,label,href,count}))
    res.json({queues,pending:queues.reduce((n,q)=>n+q.count,0),users:db.prepare('SELECT count(*) n FROM profiles').get().n,published:db.prepare("SELECT count(*) n FROM articles WHERE status='published'").get().n,generated_at:now()})
  })
  app.get('/api/admin/queue',(req,res)=>{
    const kind=req.query.kind||'',q=text(req.query.q||'',100,false),offset=offsetOf(req)
    if(kind&&!sections.some(s=>s.kind===kind))fail(400,'未知审核类型')
    const rows=db.prepare(`SELECT * FROM (${queueSql}) WHERE (?='' OR kind=?) AND (?='' OR instr(lower(coalesce(title,'')||' '||coalesce(username,'')),lower(?))>0) ORDER BY CASE WHEN typeof(created_at)='integer' THEN created_at ELSE cast(strftime('%s',created_at) AS INTEGER)*1000 END,id LIMIT 31 OFFSET ?`).all(kind,kind,q,q,offset)
    res.json({items:rows.slice(0,30),has_more:rows.length>30})
  })
  app.get('/api/admin/activity',(req,res)=>{
    const rows=db.prepare('SELECT * FROM admin_activity ORDER BY created_at DESC,rowid DESC LIMIT 31 OFFSET ?').all(offsetOf(req))
    res.json({items:rows.slice(0,30),has_more:rows.length>30})
  })
  function recipients(body){
    if(!['all','formal','user'].includes(body?.audience))fail(400,'请选择接收范围')
    if(body.audience==='user'){
      const user=db.prepare('SELECT id FROM profiles WHERE id=?').get(text(body.user_id,100))
      if(!user)fail(404,'接收用户不存在');return [user]
    }
    return db.prepare('SELECT id,role FROM profiles').all().filter(u=>body.audience==='all'||formalMember(db,u))
  }
  app.post('/api/admin/notice-preview',(req,res)=>res.json({recipient_count:recipients(req.body).length}))
  app.post('/api/admin/notices',(req,res)=>{
    const body=req.body||{},title=text(body.title,100),content=text(body.body,3000),key=text(body.request_key,100),href=text(body.href||'/messages/',500)
    if(!href.startsWith('/')||href.startsWith('//')||/[\\\u0000-\u001f]/.test(href)||new URL(href,'https://local.invalid').origin!=='https://local.invalid')fail(400,'通知链接只能使用本站路径')
    const hash=createHash('sha256').update(JSON.stringify([title,content,href,body.audience,body.audience==='user'?body.user_id:null])).digest('hex')
    const result=repository.transaction(()=>{
      const previous=db.prepare('SELECT * FROM admin_notices WHERE sender_id=? AND request_key=?').get(req.user.id,key)
      if(previous){if(previous.payload_hash!==hash)fail(409,'发送标识已用于其他内容，请重新确认');return {id:previous.id,recipient_count:previous.recipient_count,reused:true}}
      const targets=recipients(body);if(!targets.length)fail(400,'该范围暂无接收用户');if(targets.length>10000)fail(413,'接收人数过多，请缩小范围')
      const id=randomUUID(),at=now()
      db.prepare('INSERT INTO admin_notices VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,req.user.id,key,hash,title,content,href,body.audience,targets.length,at)
      // Column names keep older notifications intact as the schema evolves.
      const insert=db.prepare("INSERT INTO notifications(id,user_id,event_key,title,body,href,created_at,category) VALUES(?,?,?,?,?,?,?,'announcement')")
      for(const user of targets)insert.run(randomUUID(),user.id,'notice:'+id,title,content,href,at)
      adminAudit(db,req.user,'发送通知','notice',id,'接收人数：'+targets.length,at)
      return {id,recipient_count:targets.length,reused:false}
    });res.json(result)
  })
  app.post('/api/admin/profile/:id/review',(req,res)=>{
    const approved=req.body?.approved,note=text(req.body?.note||'',1000,false)
    if(typeof approved!=='boolean'||!approved&&!note)fail(400,'拒绝时必须填写原因')
    repository.transaction(()=>{
      const row=db.prepare('SELECT * FROM profile_changes WHERE id=?').get(req.params.id)
      if(!row||row.status!=='pending')fail(409,'资料申请已处理或不存在')
      if(approved){
        repository.applyProfileChange(row,new Date(now()).toISOString())
      }
      db.prepare('UPDATE profile_changes SET status=?,review_note=?,reviewed_by=?,reviewed_at=? WHERE id=?').run(approved?'approved':'rejected',note,req.user.id,new Date(now()).toISOString(),row.id)
      adminAudit(db,req.user,'资料审核','profile',row.id,approved?'通过':note,now())
    });res.json({ok:true})
  })
  app.post('/api/admin/branch/:id/review',(req,res)=>{
    const approved=req.body?.approved,note=text(req.body?.note||'',1000,false)
    if(typeof approved!=='boolean'||!approved&&!note)fail(400,'拒绝时必须填写原因')
    repository.transaction(()=>{
      const row=db.prepare('SELECT * FROM knowledge_branch_requests WHERE id=?').get(req.params.id)
      if(!row||row.status!=='pending')fail(409,'分支申请已处理或不存在')
      if(approved){
        if(!db.prepare('SELECT id FROM articles WHERE id=? AND author_id=?').get(row.article_id,row.requester_id))fail(409,'文章已删除或不再属于申请人')
        const names=row.requested_path.split('/').map(n=>n.trim()).filter(Boolean)
        if(!names.length||names.length>20||names.some(n=>n.length>100))fail(400,'分支路径无效')
        let parent=null
        for(const [index,name] of names.entries()){
          let branch=db.prepare('SELECT id FROM knowledge_branches WHERE parent_id IS ? AND name=?').get(parent,name)
          if(!branch){branch=repository.insert('knowledge_branches',{parent_id:parent,name,slug:'review-'+randomUUID(),created_by:row.requester_id,description:index===names.length-1?row.requested_description:''},req.user)}
          parent=branch.id
        }
        db.prepare('UPDATE articles SET kb_enabled=1,kb_branch_id=? WHERE id=?').run(parent,row.article_id)
      }
      db.prepare('UPDATE knowledge_branch_requests SET status=?,review_note=?,reviewed_by=?,reviewed_at=? WHERE id=?').run(approved?'approved':'rejected',note,req.user.id,new Date(now()).toISOString(),row.id)
      adminAudit(db,req.user,'分支审核','branch',row.id,approved?'通过':note,now())
    });res.json({ok:true})
  })
  // 成员与权限管理
  app.get('/api/admin/members', (req, res) => {
    const q = text(req.query.q || '', 100, false)
    const role = req.query.role || ''
    const offset = offsetOf(req)
    const conditions = ["1=1"]
    const args = []
    if (role && ['user', 'member', 'admin'].includes(role)) {
      conditions.push("p.role=?")
      args.push(role)
    }
    if (q) {
      conditions.push("(instr(lower(p.username), lower(?)) > 0 OR instr(lower(coalesce(p.full_name,'')), lower(?)) > 0 OR instr(lower(coalesce(p.badge_text,'')), lower(?)) > 0)")
      args.push(q, q, q)
    }
    const rows = db.prepare(`SELECT p.id, p.username, p.full_name, p.avatar_url, p.role, p.is_super_admin, p.badge_text, p.badge_color, p.created_at, u.github_username FROM profiles p JOIN users u ON u.id=p.id WHERE ${conditions.join(' AND ')} ORDER BY p.is_super_admin DESC, CASE p.role WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, p.created_at DESC LIMIT 31 OFFSET ?`).all(...args, offset)
    res.json({ items: rows.slice(0, 30), has_more: rows.length > 30 })
  })

  // 总管理授予/调整管理员权限
  app.post('/api/admin/members/:id/role', (req, res) => {
    if (!req.user.is_super_admin) fail(403, '只有总管理可以授予或调整管理权限')
    const targetId = req.params.id
    const target = db.prepare('SELECT p.* FROM profiles p WHERE p.id=?').get(targetId)
    if (!target) fail(404, '目标成员不存在')
    const nextRole = req.body?.role
    if (!['user', 'member', 'admin'].includes(nextRole)) fail(400, '无效的成员权限等级')
    if (target.id === req.user.id && nextRole !== 'admin') fail(400, '总管理不能降级自己的管理权限')

    repository.transaction(() => {
      const isSuper = nextRole === 'admin' ? target.is_super_admin : 0
      db.prepare('UPDATE profiles SET role=?, is_super_admin=?, updated_at=? WHERE id=?').run(
        nextRole,
        isSuper,
        new Date(now()).toISOString(),
        target.id
      )
      adminAudit(db, req.user, '调整成员角色', 'member', target.id, `将成员 ${target.username} 的权限调整为: ${nextRole}`, now())
    })
    res.json({ ok: true, id: target.id, role: nextRole })
  })

  // 总管理授予/撤销总管理权限
  app.post('/api/admin/members/:id/super-admin', (req, res) => {
    if (!req.user.is_super_admin) fail(403, '只有总管理可以授予总管理权限')
    const targetId = req.params.id
    const target = db.prepare('SELECT p.* FROM profiles p WHERE p.id=?').get(targetId)
    if (!target) fail(404, '目标成员不存在')
    const isSuper = Boolean(req.body?.is_super_admin)
    if (target.id === req.user.id && !isSuper) fail(400, '不能撤销自己的总管理身份')

    repository.transaction(() => {
      db.prepare("UPDATE profiles SET is_super_admin=?, role=CASE WHEN ?=1 THEN 'admin' ELSE role END, updated_at=? WHERE id=?").run(
        isSuper ? 1 : 0,
        isSuper ? 1 : 0,
        new Date(now()).toISOString(),
        target.id
      )
      adminAudit(db, req.user, isSuper ? '任命总管理' : '撤销总管理', 'member', target.id, `目标用户: ${target.username}`, now())
    })
    res.json({ ok: true, id: target.id, is_super_admin: isSuper })
  })

  // 授予/自定义成员标签（只有管理和总管理可以操作，支持自定义颜色与内容）
  app.post('/api/admin/members/:id/badge', (req, res) => {
    if (req.user.role !== 'admin' && !req.user.is_super_admin) fail(403, '只有管理员和总管理员可以授予或修改标签')
    const targetId = req.params.id
    const target = db.prepare('SELECT p.* FROM profiles p WHERE p.id=?').get(targetId)
    if (!target) fail(404, '目标成员不存在')

    const rawText = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
    const rawColor = typeof req.body?.color === 'string' ? req.body.color.trim() : ''

    if (rawText.length > 30) fail(400, '标签内容最长不超过 30 个字符')
    if (rawColor && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(rawColor)) {
      fail(400, '标签颜色必须为合法的十六进制颜色码（例如 #10b981）')
    }

    repository.transaction(() => {
      db.prepare('UPDATE profiles SET badge_text=?, badge_color=?, updated_at=? WHERE id=?').run(
        rawText,
        rawColor,
        new Date(now()).toISOString(),
        target.id
      )
      adminAudit(db, req.user, '设置成员标签', 'member', target.id, `为 ${target.username} 设置标签: "${rawText}", 颜色: "${rawColor}"`, now())
    })
    res.json({ ok: true, id: target.id, badge_text: rawText, badge_color: rawColor })
  })
}
