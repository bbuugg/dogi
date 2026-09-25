/**
 * 技能（Agent Skills：目录 + SKILL.md）的验证，分两段：
 *
 * A. 纯函数段（真代码，Node 直接跑）：`read_skill` 工具能读到 SKILL.md 正文与技能内文件、
 *    越界路径被拒、名字写错时给出可用清单；技能清单进得了系统提示词；没有技能时不暴露工具、
 *    提示词里也不出现技能段落。
 *    ⚠️ 前置：先 `node .tooltest/build-skills.mjs` 生成 .tooltest/skills.mjs。
 *
 * B. 端到端段（隔离 Electron 实例 + CDP）：工作区 `.dogi/skills` 下的技能被自动发现
 *    （没有 frontmatter 的退化、非技能目录不算数）、来源与顺序正确、AI 设置里渲染出技能区块、
 *    开关能停用/启用并落盘。
 *
 * 跑：node scripts/verify-skills.mjs（在项目根目录执行）
 * ⚠️ 用独立的 --user-data-dir 起实例，不碰用户常驻的那个；antd 会给两个汉字的按钮插空格，
 *    比对文案前先去掉空白。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const PORT = 9333
const OUT_DIR = '.workbuddy-ai/shots'
const userData = join(tmpdir(), 'dogi-skills-cdp')
const wsPath = join(tmpdir(), 'dogi-skills-ws')

const check = (label, ok) => {
  assert.ok(ok, `FAIL: ${label}`)
  console.log(`  ok  ${label}`)
}

// ===================================================================
// A. 纯函数段：read_skill / 提示词
// ===================================================================
console.log('\n[A] read_skill 工具与技能提示词')

let skillsMod
let agentMod
try {
  skillsMod = await import('../.tooltest/skills.mjs')
  agentMod = await import('../.tooltest/agent.mjs')
} catch {
  console.error('缺少构建产物：先执行 `node .tooltest/build-skills.mjs`')
  process.exit(1)
}
const { buildReadSkillTool, buildSkillsPromptSection } = skillsMod
const { buildAgentSystemPrompt, buildAgentTools } = agentMod

// 造一个技能目录：SKILL.md + 目录内的脚本
const unitDir = await fs.mkdtemp(join(tmpdir(), 'dogi-skill-unit-'))
const skillDir = join(unitDir, 'deploy-check')
await fs.mkdir(join(skillDir, 'scripts'), { recursive: true })
await fs.writeFile(
  join(skillDir, 'SKILL.md'),
  [
    '---',
    'name: 部署前检查',
    'description: 发布前跑一遍检查清单',
    '---',
    '',
    '# 步骤',
    '1. 跑 typecheck',
    '2. 跑一遍冒烟脚本 scripts/smoke.mjs'
  ].join('\n'),
  'utf8'
)
await fs.writeFile(join(skillDir, 'scripts', 'smoke.mjs'), 'console.log("smoke ok")\n', 'utf8')

const skills = [
  {
    id: join(skillDir, 'SKILL.md'),
    name: '部署前检查',
    description: '发布前跑一遍检查清单',
    dir: skillDir,
    file: join(skillDir, 'SKILL.md')
  }
]

const tools = buildReadSkillTool(skills)
const call = (input) => tools.read_skill.execute(input, { toolCallId: 't1', messages: [] })

const defaultRead = await call({ name: '部署前检查' })
check('read_skill 返回 SKILL.md 正文', defaultRead.includes('# 步骤') && defaultRead.includes('跑 typecheck'))
check('read_skill 带上名称 / 用途 / 目录', defaultRead.includes('技能：部署前检查') && defaultRead.includes(skillDir))
check('read_skill 列出技能目录内容', defaultRead.includes('scripts/') && defaultRead.includes('SKILL.md'))

const fileRead = await call({ name: '部署前检查', file: 'scripts/smoke.mjs' })
check('read_skill 的 file 参数能读技能内文件', fileRead.includes('smoke ok'))

await assert.rejects(() => call({ name: '部署前检查', file: '../outside.txt' }), /路径越界/)
console.log('  ok  技能目录之外的文件被拒（路径越界）')

await assert.rejects(() => call({ name: '不存在的技能' }), /可用技能：部署前检查/)
console.log('  ok  名字写错时给出可用技能清单')

check('buildSkillsPromptSection 无技能时为空串', buildSkillsPromptSection([]) === '')
const section = buildSkillsPromptSection(skills)
check('技能清单段落含名称与描述', section.includes('部署前检查') && section.includes('发布前跑一遍检查清单'))
check('技能清单段落要求先读说明再动手', section.includes('read_skill'))

check(
  'buildAgentSystemPrompt 带技能时追加「可用技能」段落',
  buildAgentSystemPrompt('C:/ws', 'demo', skills).includes('## 可用技能（Skills）')
)
check(
  'buildAgentSystemPrompt 不带技能时没有该段落',
  !buildAgentSystemPrompt('C:/ws', 'demo').includes('## 可用技能')
)

check(
  'buildAgentTools 在无技能时不暴露 read_skill',
  !Object.keys(buildAgentTools(unitDir, { permissionMode: 'full' })).includes('read_skill')
)
check(
  'buildAgentTools 在有技能时暴露 read_skill',
  Object.keys(buildAgentTools(unitDir, { permissionMode: 'full', skills })).includes('read_skill')
)
await fs.rm(unitDir, { recursive: true, force: true })

// ===================================================================
// B. 端到端段：发现 + 设置页
// ===================================================================
console.log('\n[B] 自动发现与 AI 设置')

const packRoot = join(tmpdir(), 'dogi-skill-pack')
const singleRoot = join(tmpdir(), 'dogi-single-skill')
await fs.rm(wsPath, { recursive: true, force: true })
await fs.rm(packRoot, { recursive: true, force: true })
await fs.rm(singleRoot, { recursive: true, force: true })
const wsSkills = join(wsPath, '.dogi', 'skills')
await fs.mkdir(join(wsSkills, 'deploy-check'), { recursive: true })
await fs.mkdir(join(wsSkills, 'no-front'), { recursive: true })
await fs.mkdir(join(wsSkills, 'not-a-skill'), { recursive: true })
await fs.writeFile(
  join(wsSkills, 'deploy-check', 'SKILL.md'),
  '---\nname: 部署前检查\ndescription: 发布前跑一遍检查清单\n---\n\n先跑 typecheck。\n',
  'utf8'
)
await fs.writeFile(
  join(wsSkills, 'no-front', 'SKILL.md'),
  '# 手工技能\n\n这是个没有 frontmatter 的技能，描述取正文首段。\n',
  'utf8'
)
await fs.writeFile(join(wsSkills, 'not-a-skill', 'README.md'), 'x\n', 'utf8')

// 软链 / Windows 目录联接形式安装的技能（skills CLI 装技能包时就是这么挂的）
await fs.mkdir(join(packRoot, 'from-junction'), { recursive: true })
await fs.writeFile(
  join(packRoot, 'from-junction', 'SKILL.md'),
  '---\nname: 联接技能\ndescription: 通过目录联接挂进来的技能\n---\n\n内容。\n',
  'utf8'
)
await fs.symlink(join(packRoot, 'from-junction'), join(wsSkills, 'linked'), 'junction')

// 额外根目录「本身就是一个技能」（不加子目录层级）
await fs.mkdir(singleRoot, { recursive: true })
await fs.writeFile(
  join(singleRoot, 'SKILL.md'),
  '---\nname: 单目录技能\ndescription: 根目录本身就是技能\n---\n\n内容。\n',
  'utf8'
)

await fs.mkdir(OUT_DIR, { recursive: true })
const log = await fs.open(join(OUT_DIR, 'skills.log'), 'a')
const child = spawn(
  'node_modules/electron/dist/electron.exe',
  [
    '.',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userData}`,
    '--no-sandbox',
    '--in-process-gpu',
    '--disable-gpu-sandbox'
  ],
  { stdio: ['ignore', log.fd, log.fd], detached: true }
)
child.unref()

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('没有等到可调试的页面')
}

const page = await pageTarget()
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
})

let msgId = 0
const pending = new Map()
socket.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  const entry = pending.get(msg.id)
  if (!entry) return
  pending.delete(msg.id)
  msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate 失败')
  return r.result.value
}

const finish = async (code) => {
  try {
    socket.close()
  } catch {
    // 忽略
  }
  try {
    process.kill(child.pid)
  } catch {
    // 已退出
  }
  await log.close()
  process.exit(code)
}

try {
  await new Promise((r) => setTimeout(r, 1500))

  const result = await evaluate(`
    (async () => {
      await window.__store.getState().saveAgentWorkspace({ name: 'skills-ws', path: ${JSON.stringify(wsPath)} })
      // 额外根目录（选的目录本身就是技能）
      await window.__store.getState().saveSkillSettings({ extraDirs: [${JSON.stringify(singleRoot)}] })
      const s = window.__store.getState()
      return {
        workspaceId: s.activeAgentWorkspaceId,
        skills: s.skills.map((k) => ({ name: k.name, description: k.description, source: k.source, file: k.file })),
        roots: s.skillRoots.map((r) => ({ source: r.source, dir: r.dir, exists: r.exists, count: r.count })),
        settings: s.skillSettings
      }
    })()
  `)

  const wsNames = result.skills.filter((s) => s.source === 'workspace').map((s) => s.name)
  check('发现工作区级技能（两个目录 + 一个联接）', wsNames.length === 3)
  check('带 frontmatter 的用 name / description', wsNames.includes('部署前检查'))
  check('非技能目录（只有 README.md）不算技能', !wsNames.includes('not-a-skill'))
  check('目录联接（junction）挂进来的技能也被发现', wsNames.includes('联接技能'))
  const noFront = result.skills.find((s) => s.file.includes('no-front'))
  check('无 frontmatter 时名称退化为目录名', noFront?.name === 'no-front')
  check(
    '无 frontmatter 时描述取正文首段',
    noFront?.description.startsWith('这是个没有 frontmatter 的技能')
  )
  const custom = result.skills.filter((s) => s.source === 'custom')
  check('额外根目录本身就是技能时也能发现', custom.length === 1 && custom[0].name === '单目录技能')

  check('根目录顺序：工作区 > 用户 > agents > Claude', result.roots[0].source === 'workspace')
  check(
    'agents > Claude 的优先级顺序',
    result.roots.findIndex((r) => r.source === 'agents') <
      result.roots.findIndex((r) => r.source === 'claude')
  )
  check('用户级技能目录被自动建出来', result.roots.find((r) => r.source === 'user')?.exists === true)
  check('初始没有被停用的技能', result.settings.disabled.length === 0)

  // 家目录的跨智能体技能目录（本机存在时才会扫到东西，不存在也必须有这一行）
  const agentsRoot = result.roots.find((r) => r.source === 'agents')
  check('扫描列表里包含 ~/.agents/skills', !!agentsRoot && agentsRoot.dir.endsWith('.agents\\skills'))
  console.log(`      （~/.agents/skills 存在=${agentsRoot.exists}，扫到 ${agentsRoot.count} 个技能）`)

  // 打开设置 → AI 分区
  await evaluate(`
    (() => {
      window.__store.getState().setSettingsOpen(true, 'ai')
      return true
    })()
  `)
  await new Promise((r) => setTimeout(r, 900))
  const sectionUi = await evaluate(`
    (() => {
      const modal = Array.from(document.querySelectorAll('.ant-modal')).find((m) => m.offsetParent !== null)
      if (!modal) throw new Error('设置弹窗没打开')
      const text = modal.textContent
      return {
        hasTitle: text.includes('技能（Skills）'),
        hasHint: text.includes('SKILL.md'),
        names: Array.from(modal.querySelectorAll('[aria-label^="启用技能"]')).map((el) =>
          el.getAttribute('aria-label')
        ),
        switches: modal.querySelectorAll('.ant-switch').length
      }
    })()
  `)
  check('AI 设置里出现「技能（Skills）」区块', sectionUi.hasTitle && sectionUi.hasHint)
  // 家目录可能已经有别的技能（如 ~/.agents/skills），只断言「扫到几个就列几个」
  check('列表列出全部扫到的技能', sectionUi.names.length === result.skills.length)
  check('每个技能一个启停开关', sectionUi.switches === result.skills.length)
  check('工作区技能也在列表里', sectionUi.names.includes('启用技能 部署前检查'))

  // 停用一个技能 → 落盘 + 列表仍在（只是关掉）
  await evaluate(`
    (() => {
      const el = document.querySelector('[aria-label="启用技能 部署前检查"]')
      if (!el) throw new Error('找不到「部署前检查」的开关')
      el.click()
      return true
    })()
  `)
  await new Promise((r) => setTimeout(r, 800))
  const afterDisable = await evaluate(`
    (() => {
      const s = window.__store.getState()
      const el = document.querySelector('[aria-label="启用技能 部署前检查"]')
      return {
        disabled: s.skillSettings.disabled,
        count: s.skills.length,
        checked: el?.getAttribute('aria-checked')
      }
    })()
  `)
  check('停用后写进 skillSettings.disabled', afterDisable.disabled.length === 1)
  check(
    '停用只是关掉开关，技能仍在列表里',
    afterDisable.count === result.skills.length && afterDisable.checked === 'false'
  )

  // 重新启用
  await evaluate(`
    (() => {
      document.querySelector('[aria-label="启用技能 部署前检查"]').click()
      return true
    })()
  `)
  await new Promise((r) => setTimeout(r, 800))
  const afterEnable = await evaluate(`window.__store.getState().skillSettings.disabled.length`)
  check('重新启用后 disabled 清空', afterEnable === 0)

  // 浅色主题截图（把技能区块滚到视口中间，否则截到的是模型配置那一段）
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }]
  })
  await evaluate(`
    (() => {
      const label = Array.from(document.querySelectorAll('.ant-modal *')).find(
        (n) => n.textContent === '技能（Skills）'
      )
      label?.scrollIntoView({ block: 'center' })
      return !!label
    })()
  `)
  await new Promise((r) => setTimeout(r, 600))
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await fs.writeFile(join(OUT_DIR, 'skills-settings.png'), Buffer.from(shot.data, 'base64'))
  console.log(`  ok  截图已落盘 ${OUT_DIR}/skills-settings.png`)

  console.log('\nALL PASS')
  await finish(0)
} catch (err) {
  console.error(`\n${err.stack ?? err}`)
  await finish(1)
}
