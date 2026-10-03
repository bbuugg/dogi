import { useEffect, useRef } from 'react'
import { Button, notification } from 'antd'
import type { AppUpdateStatus } from '@shared/types'

/**
 * 自动更新的**唯一提示出口**：后台静默下完新版后，在这里问一次「要不要现在装」。
 *
 * ## 为什么挂在应用根部、而不是塞进设置页
 *
 * 静默检查是主进程自己跑的（`services/updater.ts`），用户不会主动去看设置页——
 * 提示必须自己出现。但它也**只能是通知**：不进标题栏 / 状态栏常驻（那会变成新的噪音），
 * 一次运行内只提示一次（用户点「稍后」就不再打扰）。
 *
 * ## 三条产品约定（与 updater 服务一一对应）
 *
 * - 只提示**正式通道**的版本（`allowPrerelease = false` 由主进程侧把关）；
 * - 不自动装：装 = 重启，必须用户点头；主进程会先冲刷渲染端状态再退，不丢最后几秒产出；
 * - 检查失败**不提示**（断网 / 限流是常态，只进主机日志的 `app` 作用域）。
 */
export function UpdateNotifier() {
  /** 本次运行是否已经提示过 */
  const notifiedRef = useRef(false)

  useEffect(() => {
    const prompt = (status: AppUpdateStatus): void => {
      if (notifiedRef.current) return
      notifiedRef.current = true
      notification.open({
        key: 'app-update',
        message: `Dogi ${status.latest ?? ''} 已下载完成`,
        description: '重启即可安装；正在进行的会话会先落盘再退出。',
        duration: 0,
        placement: 'bottomRight',
        // antd 6 的 `actions` 是**自定义内容区**（ReactNode），不是 v5 那套描述符数组；
        // 关通知用 `destroy`（`close` 在 antd 6 已移除）
        actions: (
          <div className="flex gap-2">
            <Button size="small" onClick={() => notification.destroy('app-update')}>
              稍后
            </Button>
            <Button
              size="small"
              type="primary"
              onClick={() => {
                notification.destroy('app-update')
                void window.api.updater.install()
              }}
            >
              重启安装
            </Button>
          </div>
        )
      })
    }

    // 挂载时补读一次状态：应用刚启动、后台已经下完（比如上次没退干净）的情况不能漏
    void window.api.updater.status().then((status) => {
      if (status.state === 'downloaded') prompt(status)
    })

    return window.api.updater.onStatus((status) => {
      if (status.state === 'downloaded') prompt(status)
    })
  }, [])

  return null
}