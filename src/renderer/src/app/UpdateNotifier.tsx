import { useEffect, useRef } from 'react'
import { Button, notification } from 'antd'
import type { AppUpdateStatus } from '@shared/types'

/**
 * 自动更新的**唯一提示出口**：发现新版后引导用户「点一下再下载」，下载中可取消，
 * 下完再问一次「要不要现在装」。
 *
 * ## 为什么不自动下载（产品改动）
 *
 * 之前是「发现即后台下完」，现在改成：主进程发现新版只进 `available` 态（红徽章提示），
 * 用户**主动点击**才开始 `downloadUpdate`，且下载途中可 `cancel` 取消。所以这里要覆盖
 * 三个状态：
 *
 * - `available`：红徽章已在菜单 / 设置页亮起，这里**不**弹通知（避免和徽章重复打扰）；
 * - `downloading`：弹一条常驻通知，带「取消」按钮（调 `updater.cancel`）；
 * - `downloaded`：把下载通知收掉，弹「已下载完成，重启安装」通知（一次运行只提示一次）。
 *
 * 取消下载会回到 `available`，红徽章继续提示，可再次点击下载。
 */
const DOWNLOADING_KEY = 'app-update-downloading'
const READY_KEY = 'app-update-ready'

export function UpdateNotifier() {
  /** 本次运行是否已经提示过「安装」：装 = 重启，只打扰一次 */
  const notifiedRef = useRef(false)

  useEffect(() => {
    const showDownloading = (status: AppUpdateStatus): void => {
      notification.open({
        key: DOWNLOADING_KEY,
        message: `正在下载 Dogi ${status.latest ?? ''}`,
        description: '下载完成后会提示你安装；可随时取消。',
        duration: 0,
        placement: 'bottomRight',
        actions: (
          <Button
            size="small"
            onClick={() => {
              notification.destroy(DOWNLOADING_KEY)
              void window.api.updater.cancel()
            }}
          >
            取消
          </Button>
        )
      })
    }

    const showReady = (status: AppUpdateStatus): void => {
      if (notifiedRef.current) return
      notifiedRef.current = true
      notification.open({
        key: READY_KEY,
        message: `Dogi ${status.latest ?? ''} 已下载完成`,
        description: '重启即可安装；正在进行的会话会先落盘再退出。',
        duration: 0,
        placement: 'bottomRight',
        actions: (
          <div className="flex gap-2">
            <Button size="small" onClick={() => notification.destroy(READY_KEY)}>
              稍后
            </Button>
            <Button
              size="small"
              type="primary"
              onClick={() => {
                notification.destroy(READY_KEY)
                void window.api.updater.install()
              }}
            >
              重启安装
            </Button>
          </div>
        )
      })
    }

    const onStatus = (status: AppUpdateStatus): void => {
      if (status.state === 'downloading') {
        showDownloading(status)
      } else if (status.state === 'downloaded') {
        // 收掉下载中的通知，换成安装提示
        notification.destroy(DOWNLOADING_KEY)
        showReady(status)
      } else if (status.state === 'available') {
        // 取消下载后回到「待下载」：收掉下载中的通知（红徽章继续提示）
        notification.destroy(DOWNLOADING_KEY)
      }
    }

    // 挂载时补读一次：应用刚启动、后台已经下完 / 正在下（比如上次没退干净）的情况不能漏
    void window.api.updater.status().then((status) => {
      if (status.state === 'downloaded') showReady(status)
      else if (status.state === 'downloading') showDownloading(status)
    })

    return window.api.updater.onStatus(onStatus)
  }, [])

  return null
}
