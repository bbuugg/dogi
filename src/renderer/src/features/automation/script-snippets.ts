/**
 * 自动化脚本编辑器「插入」下拉里的代码片段。
 *
 * 每条片段都是**独立语句**（单行、以 `;` 结尾）—— runner 的逐行执行模式会把
 * 每行拆成一条语句，多行片段会被拆坏（见 runner.ts 的 isLinePerStatement）。
 */
export interface InsertSnippet {
  key: string
  label: string
  /** 插到光标处的代码 */
  code: string
}

export interface InsertSnippetGroup {
  key: string
  label: string
  items: InsertSnippet[]
}

export const INSERT_SNIPPET_GROUPS: InsertSnippetGroup[] = [
  {
    key: 'wait',
    label: '等待',
    items: [
      { key: 'wait-500', label: '等待 500 毫秒', code: 'await page.waitForTimeout(500);' },
      { key: 'wait-1s', label: '等待 1 秒', code: 'await page.waitForTimeout(1000);' },
      { key: 'wait-2s', label: '等待 2 秒', code: 'await page.waitForTimeout(2000);' },
      { key: 'wait-3s', label: '等待 3 秒', code: 'await page.waitForTimeout(3000);' },
      {
        key: 'wait-visible',
        label: '等待元素出现（可见）',
        code: "await page.locator('选择器').waitFor({ state: 'visible' });"
      },
      {
        key: 'wait-hidden',
        label: '等待元素消失',
        code: "await page.locator('选择器').waitFor({ state: 'hidden' });"
      },
      {
        key: 'wait-load',
        label: '等待页面加载完成',
        code: "await page.waitForLoadState('load');"
      },
      {
        key: 'wait-url',
        label: '等待跳转到某地址',
        code: "await page.waitForURL('**/path');"
      }
    ]
  }
]

/** 按 key 取片段（下拉点击时用） */
export function findSnippet(key: string): InsertSnippet | undefined {
  for (const group of INSERT_SNIPPET_GROUPS) {
    const hit = group.items.find((i) => i.key === key)
    if (hit) return hit
  }
  return undefined
}
