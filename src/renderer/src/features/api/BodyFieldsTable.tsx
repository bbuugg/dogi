import { Button, Input, Select } from 'antd'
import { FolderOpen, Trash2 } from 'lucide-react'
import { isBlankFormField } from '@/features/api/api-client'
import type { ApiFormField } from '@shared/types'

/** 「类型」列的取值（仅 form-data 显示） */
const FIELD_KIND_OPTIONS = [
  { value: 'text', label: '文本' },
  { value: 'file', label: '文件' }
]

/**
 * 表单字段表：`x-www-form-urlencoded` 与 `form-data` 共用同一套行交互。
 *
 * 与「请求头」表一致 —— 末行永远是一个待填的空槽位、行尾删除按钮（空槽位不给删除按钮，
 * 删了 tidyFormRows 也会立刻补回来，是个空操作）。不用 antd Table：每行没有稳定 id，
 * 用 index 当 rowKey 会被 antd 弃用告警。
 *
 * `fileMode`（form-data）多一列「类型」（位置在**值这一列前面** —— 先决定这行是文本还是文件，
 * 再看/填值）：选「文件」时该行的值变成一个只读的文件名 + 「选择文件」按钮
 * （路径由主进程的系统对话框给出，见 api:pickFile）。
 */
export function BodyFieldsTable({
  fields,
  fileMode,
  onPatch,
  onRemove,
  onPickFile,
  fileLabel
}: {
  /** 展示用的行（调用方负责 tidy，末行恒为空槽位） */
  fields: ApiFormField[]
  /** form-data：显示「类型」列与文件选择 */
  fileMode: boolean
  onPatch: (index: number, patch: Partial<ApiFormField>) => void
  onRemove: (index: number) => void
  /** 选择本地文件（弹系统对话框 → 把路径写回该行） */
  onPickFile: (index: number) => void
  /** 文件字段的展示文案：缓存里有就用「文件名 (12.3 KB)」，否则退化成路径末段 */
  fileLabel: (path: string) => string
}) {
  return (
    <div className="flex flex-col divide-y divide-border/40">
      {fields.map((f, i) => {
        const isFile = fileMode && f.isFile === true
        // 末行的空槽位不给删除按钮
        const removable = !(i === fields.length - 1 && isBlankFormField(f))
        return (
          <div key={i} className="flex items-center gap-2 py-1">
            <div className="w-[200px] shrink-0">
              <Input
                size="small"
                variant="filled"
                value={f.key}
                onChange={(e) => onPatch(i, { key: e.target.value })}
                placeholder={fileMode ? '字段名，如 file' : '参数名'}
                className="w-full font-mono text-xs"
                style={{ height: 32 }}
              />
            </div>
            {/* 「类型」列放在**值这一列前面**：先决定这一行是文本还是文件，再看/填值 */}
            {fileMode && (
              <div className="w-[76px] shrink-0">
                {/* 换类型时值一起清掉：文本值当路径用必然读不到文件，反之亦然 */}
                <Select
                  value={isFile ? 'file' : 'text'}
                  options={FIELD_KIND_OPTIONS}
                  className="w-full"
                  onChange={(v) => onPatch(i, { isFile: v === 'file', value: '' })}
                />
              </div>
            )}
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {isFile ? (
                <>
                  <Input
                    size="small"
                    variant="filled"
                    readOnly
                    value={f.value ? fileLabel(f.value) : ''}
                    placeholder="未选择文件"
                    title={f.value || undefined}
                    className="min-w-0 flex-1 font-mono text-xs"
                    style={{ height: 32 }}
                  />
                  <Button
                    size="small"
                    icon={<FolderOpen className="size-3.5" />}
                    className="shrink-0"
                    onClick={() => onPickFile(i)}
                  >
                    选择文件
                  </Button>
                </>
              ) : (
                <Input
                  size="small"
                  variant="filled"
                  value={f.value}
                  onChange={(e) => onPatch(i, { value: e.target.value })}
                  placeholder={fileMode ? '字段值（上面的类型选「文件」可上传本地文件）' : '参数值'}
                  className="w-full font-mono text-xs"
                  style={{ height: 32 }}
                />
              )}
            </div>
            <div className="w-10 shrink-0 text-center">
              {removable && (
                <Button
                  type="text"
                  size="small"
                  className="size-7 text-muted-foreground"
                  title="删除该字段"
                  icon={<Trash2 className="size-3.5" />}
                  onClick={() => onRemove(i)}
                />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
