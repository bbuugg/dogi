import { useEffect, useState } from 'react'
import { Checkbox, Modal } from 'antd'
import { useAppStore } from '@/stores/app-store'

/**
 * 「关闭标签二次确认」弹窗（受设置里的「关闭标签前二次确认」控制，见 PrefSettings）。
 *
 * 关闭入口（标签上的 ×、标签右键菜单的「关闭标签」、关闭整个组）都不直接关，
 * 而是走 `requestClosePanelTab` / `requestCloseGroup` 把请求挂到 `ui.pendingTabClose`，
 * 由这里弹框确认后再真正执行。
 *
 * 勾选「以后都不再提示」= 把 `Preferences.confirmCloseTab` 改成 false（可在设置里重新打开）。
 */
export function TabCloseConfirm() {
  const pending = useAppStore((s) => s.ui.pendingTabClose)
  const cancelPendingTabClose = useAppStore((s) => s.cancelPendingTabClose)
  const confirmPendingTabClose = useAppStore((s) => s.confirmPendingTabClose)
  const [dontAsk, setDontAsk] = useState(false)

  // 每次重新弹框都复位勾选，避免上一次的勾选残留到下一次
  useEffect(() => {
    if (pending) setDontAsk(false)
  }, [pending])

  const isGroup = pending?.kind === 'group'

  return (
    <Modal
      open={pending !== null}
      title={isGroup ? '关闭整个组' : '关闭标签'}
      okText="关闭"
      cancelText="取消"
      centered
      width={420}
      okButtonProps={{ danger: true }}
      onOk={() => void confirmPendingTabClose(dontAsk)}
      onCancel={cancelPendingTabClose}
    >
      <div className="space-y-3">
        <div className="text-sm">
          {isGroup
            ? `确定关闭该面板组及其 ${pending?.kind === 'group' ? pending.count : 0} 个标签？组内终端会话会被一并结束。`
            : `确定关闭标签「${pending?.kind === 'tab' ? pending.label : ''}」？`}
        </div>
        <Checkbox checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)}>
          以后都不再提示
        </Checkbox>
      </div>
    </Modal>
  )
}
