/**
 * AI 设置里的「技能」区块。
 *
 * 技能遵循 Agent Skills 约定：**一个目录 + 里面的 `SKILL.md`**（frontmatter 里写
 * name / description）。磁盘是唯一真源 —— 这里不做增删改，只做：
 * 自动发现（重新扫描）、启停、添加额外技能根目录、打开目录。
 * 发现结果会进 Agent 的系统提示词，正文由 `read_skill` 工具按需加载。
 */
import { useEffect, useState } from 'react'
import { Button, Popconfirm, Switch, Tooltip, message } from 'antd'
import { FolderOpen, FolderPlus, RefreshCw, Trash2 } from 'lucide-react'
import { useAppStore } from '@/stores/app-store'
import type { SkillInfo, SkillSource } from '@shared/types'

/** 技能来源的展示名（与 services/ai/skills.ts 的扫描顺序一致） */
const SOURCE_LABELS: Record<SkillSource, string> = {
  workspace: '工作区',
  user: '用户',
  agents: 'agents 共享',
  claude: 'Claude 兼容',
  custom: '自定义目录'
}

function SourceTag({ source }: { source: SkillSource }) {
  return (
    <span className="shrink-0 rounded border border-border/70 px-1 py-0.5 text-[10px] leading-3 text-muted-foreground">
      {SOURCE_LABELS[source]}
    </span>
  )
}

/** 打开一个本地目录（失败只提示，不抛） */
async function openDir(dir: string): Promise<void> {
  const result = await window.api.shell.openFileManager(dir)
  if (!result.ok) message.error(result.error ?? `打不开目录：${dir}`)
}

/** 单个技能行：启停开关 + 名称 / 描述 / 来源 + 打开所在目录 */
function SkillRow({
  skill,
  enabled,
  busy,
  onToggle
}: {
  skill: SkillInfo
  enabled: boolean
  busy: boolean
  onToggle: (enabled: boolean) => void
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border/70 px-2.5 py-2">
      <Switch
        size="small"
        checked={enabled}
        loading={busy}
        aria-label={`启用技能 ${skill.name}`}
        onChange={onToggle}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm text-foreground">{skill.name}</span>
          <SourceTag source={skill.source} />
        </div>
        <div className="mt-0.5 line-clamp-2 text-xs leading-4 text-muted-foreground">
          {skill.description}
        </div>
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground/60" title={skill.file}>
          {skill.file}
        </div>
      </div>
      <Tooltip title="打开技能目录">
        <Button
          type="text"
          size="small"
          className="shrink-0 px-1.5 text-muted-foreground"
          icon={<FolderOpen className="size-3.5" />}
          aria-label={`打开技能目录 ${skill.name}`}
          onClick={() => void openDir(skill.dir)}
        />
      </Tooltip>
    </div>
  )
}

export function SkillsSettings() {
  const skills = useAppStore((s) => s.skills)
  const roots = useAppStore((s) => s.skillRoots)
  const settings = useAppStore((s) => s.skillSettings)
  const loadSkills = useAppStore((s) => s.loadSkills)
  const saveSkillSettings = useAppStore((s) => s.saveSkillSettings)
  /** 工作区级技能来自当前选中的工作区，说明文字里点出来，免得用户困惑「为什么没有」 */
  const activeWorkspaceName = useAppStore(
    (s) => s.agentWorkspaces.find((w) => w.id === s.activeAgentWorkspaceId)?.name
  )
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  const disabled = settings?.disabled ?? []
  const extraDirs = settings?.extraDirs ?? []

  const toggle = async (skill: SkillInfo, enabled: boolean) => {
    setBusyId(skill.id)
    try {
      await saveSkillSettings({
        disabled: enabled ? disabled.filter((id) => id !== skill.id) : [...disabled, skill.id]
      })
    } finally {
      setBusyId(null)
    }
  }

  /** 添加额外技能根目录（选中的目录可以是「一堆技能的父目录」，也可以就是某个技能目录） */
  const addDir = async () => {
    const { canceled, filePaths } = await window.api.dialog.open({ properties: ['openDirectory'] })
    const dir = filePaths[0]
    if (canceled || !dir) return
    if (extraDirs.includes(dir)) {
      message.info('该目录已经在扫描列表里了')
      return
    }
    await saveSkillSettings({ extraDirs: [...extraDirs, dir] })
  }

  const userRoot = roots.find((r) => r.source === 'user')

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="text-sm font-medium text-foreground">技能（Skills）</span>
          <p className="mt-1 text-xs leading-4 text-muted-foreground">
            一个技能就是「一个目录 + 里面的 SKILL.md」（frontmatter 写 name / description）。
            放进下面的目录即自动发现，AI Agent 判断任务相关时会先读技能说明再照做。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="small"
            type='text'
            icon={<RefreshCw className="size-3.5" />}
            onClick={() => void loadSkills()}
          >
            重新扫描
          </Button>
          <Button
            size="small"
            type='text'
            icon={<FolderPlus className="size-3.5" />}
            onClick={() => void addDir()}
          >
            添加目录
          </Button>
        </div>
      </div>

      {skills.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          还没有发现任何技能。
          <br />
          在下面任一目录里新建一个子目录、放入 SKILL.md 即可（也可以用「添加目录」指定别处）。
        </div>
      ) : (
        <div className="space-y-1.5">
          {skills.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              enabled={!disabled.includes(skill.id)}
              busy={busyId === skill.id}
              onToggle={(enabled) => void toggle(skill, enabled)}
            />
          ))}
        </div>
      )}

      <div className="space-y-1 rounded-md border border-border/60 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">自动扫描的位置</span>
          {userRoot && (
            <Button
              type="text"
              size="small"
              className="h-6 px-1.5 text-xs text-muted-foreground"
              icon={<FolderOpen className="size-3" />}
              onClick={() => void openDir(userRoot.dir)}
            >
              打开技能目录
            </Button>
          )}
        </div>
        {roots.map((root) => (
          <div key={`${root.source}:${root.dir}`} className="flex items-center gap-1.5 text-xs">
            <SourceTag source={root.source} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={root.dir}>
              {root.dir}
            </span>
            <span className="shrink-0 text-muted-foreground/60">
              {root.exists ? `${root.count} 个` : '不存在'}
            </span>
            {root.exists && (
              <Tooltip title="打开目录">
                <button
                  type="button"
                  aria-label={`打开目录 ${root.dir}`}
                  className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10"
                  onClick={() => void openDir(root.dir)}
                >
                  <FolderOpen className="size-3" />
                </button>
              </Tooltip>
            )}
            {root.source === 'custom' && (
              <Popconfirm
                title="不再扫描这个目录？"
                description="只移出扫描列表，不会删除目录里的任何文件。"
                okText="移除"
                cancelText="取消"
                onConfirm={() => void saveSkillSettings({ extraDirs: extraDirs.filter((d) => d !== root.dir) })}
              >
                <button
                  type="button"
                  aria-label={`移除扫描目录 ${root.dir}`}
                  className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-3" />
                </button>
              </Popconfirm>
            )}
          </div>
        ))}
        <p className="pt-0.5 text-[10px] leading-4 text-muted-foreground/70">
          工作区级技能来自当前工作区
          {activeWorkspaceName ? `「${activeWorkspaceName}」` : '（当前没有选中工作区，只看全局技能）'}
          的 .dogi/skills 目录。
        </p>
      </div>
    </section>
  )
}
