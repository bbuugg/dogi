/**
 * 选一个本地文件并读出来（数据导入 / OpenAPI 规格导入共用）。
 *
 * 为什么不用 `showOpenFilePicker`（File System Access API）：那个 API 只在**安全上下文**
 * 且有**用户手势**时可用，局域网 `http://<ip>` 下直接没有；隐藏 `<input type="file">`
 * 到处都能用，功能上也没少什么（这里不需要写回原文件）。
 *
 * ## 取消要能分辨出来
 *
 * 用户点「取消」和「选了个空文件」都表现为「没有文件」，但界面要给不同的反应（前者静默、
 * 后者报错），所以这里统一回 `null` 表示取消。
 *
 * 取消事件各家浏览器不一致：`cancel` 事件（Chrome 113+ / Safari 16.4+ / Firefox 91+）
 * 是正路，老浏览器不发 —— 所以还挂一个 `focus` 兜底（对话框关掉后窗口拿回焦点）。
 * 兜底带 300ms 延迟：`change` 与 `focus` 的先后顺序不保证，不等一下会把「刚选好的文件」
 * 抢着当成「取消了」。
 *
 * ## 为什么在 shared
 *
 * 原先住在 `features/transfer/`，接口请求的 OpenAPI 导入也要选文件 —— 两个功能区都要用，
 * 按 renderer 分层规矩搬到 `shared/lib`（`features/<功能>/` 只服务一个功能区）。
 */
import { fileToBase64 } from '@fizz/agent-client/api'

/** 读成 base64 的选中文件（数据导入的入参形态） */
export interface PickedFile {
  name: string
  dataBase64: string
}

/** 读成文本的选中文件（OpenAPI / Swagger 规格） */
export interface PickedTextFile {
  name: string
  text: string
}

/**
 * 打开系统文件选择框，按 `read` 把选中的文件读出来；返回 null = 用户取消。
 *
 * `read` 抛出（文件被删 / 读失败）同样按「取消」回 null —— 调用方只分「拿到 / 没拿到」，
 * 具体原因由它自己再报（文件内容不合法的错误在解析那一步更清楚）。
 */
function pickFile<T>(
  accept: string,
  read: (file: File) => Promise<T>
): Promise<{ name: string; value: T } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    // 挂到 body 上再点：某些浏览器对游离节点的 click 不弹框
    document.body.appendChild(input)

    let settled = false
    const finish = (value: { name: string; value: T } | null): void => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onFocus)
      input.remove()
      resolve(value)
    }

    const onFocus = (): void => {
      // 窗口拿回焦点说明选择框关掉了；等一下 `change`（顺序不保证）
      window.setTimeout(() => finish(null), 300)
    }

    input.addEventListener('cancel', () => finish(null))
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) {
        finish(null)
        return
      }
      // 先认领，避免下面 focus 兜底的计时器把结果抢成 null
      settled = true
      window.removeEventListener('focus', onFocus)
      void read(file).then(
        (value) => {
          input.remove()
          resolve({ name: file.name, value })
        },
        () => {
          input.remove()
          resolve(null)
        }
      )
    })
    window.addEventListener('focus', onFocus)
    input.click()
  })
}

/** 选一个文件读成 base64（数据导入用） */
export async function pickFileBase64(accept: string): Promise<PickedFile | null> {
  const picked = await pickFile(accept, fileToBase64)
  return picked ? { name: picked.name, dataBase64: picked.value } : null
}

/** 选一个文件读成 UTF-8 文本（OpenAPI / Swagger 规格用；规格文件本来就是文本） */
export async function pickTextFile(accept: string): Promise<PickedTextFile | null> {
  const picked = await pickFile(accept, (file) => file.text())
  return picked ? { name: picked.name, text: picked.value } : null
}

/** base64 → 字节（导出时把服务端回的内容还原成 Blob） */
export function base64ToBytes(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
