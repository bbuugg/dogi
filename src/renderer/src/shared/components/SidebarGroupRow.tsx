import { Button, Dropdown } from 'antd'
import type { MenuProps } from 'antd'
import { ChevronRight, Plus } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { useDrag } from 'react-dnd'
import { cn } from 'cn'
import { asRef, DropLine, mergeRefs, useRowDrop, type RowDragItem } from '@/shared/components/SidebarRowDnd'
import {
  SidebarRowActions,
  SIDEBAR_ROW_TRAIL_RESERVE
} from '@/shared/components/SidebarRowActions'
import { tintText } from '@/shared/lib/color'

/**
 * 侧栏分组行（主机 / 脚本 / 笔记 / 接口共用）。
 *
 * 视觉对齐 AI 侧栏的工作区行：
 * 文件夹图标 → 名称 → 展开箭头（紧随名称）→【afterCount 槽】→ 悬浮出现的新建按钮。
 *
 * 行为：
 * - 点击整行展开/折叠；右键弹 menuItems（各功能区自建菜单项与分发）；
 * - 整行可拖动排序，也可作为资源的落点（拖到标题上 = 追加进组尾）；
 * - 名称与箭头必须是这一行的**同级 flex 子项**，名称**不给 flex-1**：
 *   它按自身宽度占位，箭头才会随名称长度往右走，最长顶到右侧按钮之前截断。
 */
export function SidebarGroupRow({
  name,
  expanded,
  onToggle,
  color,
  afterCount,
  onNew,
  newTitle,
  itemType,
  groupType,
  groupId,
  onDropItem,
  onDropGroup,
  menuItems,
  onMenuClick
}: {
  name: string
  /** 当前是否为展开状态（决定箭头方向） */
  expanded: boolean
  /** 点击整行切换展开/折叠 */
  onToggle: () => void
  /** 分组强调色：名称做主题混色、箭头用原色（仅主机分组使用） */
  color?: string
  /** 数量之后的附加内容（如主机分组的取色点） */
  afterCount?: ReactNode
  /** 悬浮新建按钮的动作 */
  onNew: () => void
  /** 悬浮新建按钮的 title */
  newTitle: string
  /** 资源（连接 / 笔记 / 请求 / 脚本）的 react-dnd 类型 */
  itemType: string
  /** 分组的 react-dnd 类型 */
  groupType: string
  groupId: string
  /** 资源拖进本行（本行是分组标题 = 追加到组尾） */
  onDropItem: (
    dragId: string,
    targetId: string | null,
    targetGroupId: string,
    after: boolean
  ) => void
  onDropGroup: (dragId: string, targetGroupId: string, after: boolean) => void
  /** 右键菜单项（图标与文案由各功能区自建） */
  menuItems: MenuProps['items']
  /** 右键菜单点击：key 由各功能区自行分发 */
  onMenuClick: (key: string) => void
}) {
  const [{ isDragging }, drag] = useDrag<RowDragItem, void, { isDragging: boolean }>(
    () => ({
      type: groupType,
      item: { id: groupId },
      collect: (m) => ({ isDragging: m.isDragging() })
    }),
    [groupType, groupId]
  )

  const { ref: dropRef, over, after } = useRowDrop<HTMLDivElement>({
    itemType,
    groupType,
    // 拖资源落在分组标题上 = 放进组尾
    appendWhenItemDrag: true,
    canDrop: (item, type) => type === itemType || item.id !== groupId,
    drop: (item, type, at) => {
      if (type === groupType) onDropGroup(item.id, groupId, at)
      else onDropItem(item.id, null, groupId, true)
    }
  })

  const dragRef = useMemo(() => asRef<HTMLDivElement>(drag), [drag])
  const ref = useMemo(() => mergeRefs(dropRef, dragRef), [dropRef, dragRef])

  // 拖拽 ref 放在最外层：antd Dropdown 会给子节点合并自己的 ref（React 19 下 element.ref 已变更），
  // 让 Dropdown 只包住内容，dnd 的连接器才不会被覆盖
  return (
    <div
      ref={ref}
      className={cn(
        'group/grp row-own-bg relative flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md pl-1.5 pr-1 transition-colors hover:bg-foreground/5',
        isDragging && 'opacity-40'
      )}
      onClick={onToggle}
      title="点击展开/折叠（可拖动排序）"
    >
      {over && <DropLine after={after} />}
      <Dropdown
        trigger={['contextMenu']}
        menu={{
          items: menuItems,
          onClick: ({ key }) => onMenuClick(key)
        }}
      >
        <div
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5',
            // hover 时把行尾一格让给悬浮的「新建」按钮
            SIDEBAR_ROW_TRAIL_RESERVE.one
          )}
        >
          {/* 文件夹图标对齐 AI 侧栏的工作区行 */}
          <button
            type="button"
            title={expanded ? '收起' : '展开'}
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-foreground/10"
          >
            <ChevronRight
              className={cn('size-4 transition-transform duration-200', expanded && 'rotate-90')}
              style={color ? { color } : undefined}
            />
          </button>
          {/*
            名称**不给 flex-1**：按自身宽度占位，箭头与 afterCount（取色点）才紧随其后，
            最长顶到行尾按钮之前截断。给了 flex-1 会把取色点顶到行尾、钻进浮层底下。
          */}
          <span
            className="truncate text-sm font-medium text-muted-foreground"
            style={color ? { color: tintText(color) } : undefined}
          >
            {name}
          </span>
          {afterCount}
        </div>
      </Dropdown>
      {/*
        「新建」绝对定位在行右侧、hover 整行才浮现（与 AI 侧栏的工作区行同一套做法）。
        放在 flex 流里的话，即便 `opacity-0` 也照样占一格 —— 分组名全程被提前截断。
      */}
      <SidebarRowActions hoverClass="group-hover/grp:pointer-events-auto group-hover/grp:opacity-100">
        <Button
          type="text"
          size="small"
          className="h-5 w-5 shrink-0 p-0 opacity-0 transition-opacity group-hover/grp:opacity-100"
          title={newTitle}
          icon={<Plus className="size-3.5" />}
          onClick={(e) => {
            e.stopPropagation()
            onNew()
          }}
        />
      </SidebarRowActions>
    </div>
  )
}
