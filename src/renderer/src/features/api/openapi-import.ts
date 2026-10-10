/**
 * OpenAPI / Swagger 规格导入解析器：把一份 JSON / YAML 规格解析成「接口请求」侧边栏的条目 + 分组。
 *
 * 支持两种**同源但结构不同**的格式（Swagger 是 OpenAPI 的旧称，两者不是一回事；Swagger 3 就是
 * OpenAPI 3）：
 * - Swagger 2.0（`swagger: "2.0"`）：`host` + `basePath` + `schemes` 拼地址，
 *   参数用 `in: body / formData`，`consumes` / `produces` 定媒体类型，引用 `#/definitions/...`；
 * - OpenAPI 3.x（`openapi: "3.0.x / 3.1.x"`，`swagger: "3.x"` 同义）：`servers[].url` 拼地址，
 *   请求体在 `requestBody.content.<mediaType>.schema`，引用 `#/components/schemas/...`。
 *
 * ## 转换规则（两边一致处优先）
 * - 名称：`summary` → `operationId` → `METHOD path`；
 * - 分组：按操作第一个 `tags[0]`；整份文档都没有 tag 时统一进一个
 *   以 `info.title` 命名的分组（避免整批堆进「未分组」）；
 * - 路径参数替换成示例值（参数上的 example/default/enum，或按类型推断），
 *   查询参数序列化进 URL 的查询串（与 api-client.ts 的「查询参数唯一事实来源是地址」约定一致）；
 * - 请求体：JSON 媒体类型生成示例 JSON 正文；表单类媒体类型映射成
 *   `x-www-form-urlencoded` / `form-data` 字段；
 * - 安全方案：`apiKey`（header/query）、`http` bearer/basic（及 Swagger 2 的 `type: basic`）
 *   会预填对应的认证头 / 查询参数（值为空，提醒用户填 token）。
 *
 * 纯函数（只依赖 `yaml` 包）、无 React / 无 DOM / 无 Electron，验证脚本可直接用
 * `node --experimental-strip-types` 跑（见 scripts/verify-openapi-import.ts）。
 */
import type { ApiBodyType, ApiFormField, ApiHeaderPair } from '@shared/types'
import { parse as parseYaml } from 'yaml'

/** 支持的 HTTP 方法（与 api-client.ts 的 METHODS 顺序无关，这里只决定遍历顺序） */
const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'] as const

type SpecKind = 'openapi3' | 'swagger2'

/** 解析出的单条请求（可直接作为 createApiRequest 的 seed） */
export interface OpenApiImportEntry {
  /** 分组名（operation.tags[0]；空串表示「未分组」） */
  group: string
  method: string
  url: string
  name: string
  headers: ApiHeaderPair[]
  body: string
  bodyType?: ApiBodyType
  bodyUrlencoded?: ApiHeaderPair[]
  bodyFormFields?: ApiFormField[]
}

/** 一份规格的解析结果（UI 用它做导入前预览，store 按它建组 + 建请求） */
export interface OpenApiImportResult {
  format: 'OpenAPI 3.x' | 'Swagger 2.0'
  title: string
  version: string
  /** 需要建的分组名（按出现顺序，不含空串）；空 = 整批进「未分组」 */
  groups: string[]
  entries: OpenApiImportEntry[]
  /** 跳过的操作 / 路径项数量（信息性提示，不阻断导入） */
  skipped: number
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const asObj = (v: unknown): Record<string, unknown> | null => (isObj(v) ? v : null)

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 请求头列表是否已包含某头（键名大小写不敏感） */
const hasHeader = (rows: ApiHeaderPair[], key: string): boolean =>
  rows.some((r) => r.key.toLowerCase() === key.toLowerCase())

/**
 * 解析 `#/components/schemas/Foo` 这类**内部** JSON 引用。
 * 引用到文件外部 / 找不到目标一律返回 null（调用方决定跳过或保留原样）。
 */
function resolveRef(ref: string, root: Record<string, unknown>): unknown {
  if (!ref.startsWith('#/')) return null
  const parts = ref.slice(2).split('/').filter(Boolean)
  if (!parts.length) return null
  let cur: unknown = root
  for (const part of parts) {
    if (!isObj(cur)) return null
    cur = cur[part]
  }
  return cur
}

/** `#/components/schemas/Foo` → `Foo`（schema 注册表的键） */
function refKey(ref: string): string {
  const seg = ref.split('/').filter(Boolean)
  return seg.length ? seg[seg.length - 1] : ''
}

/**
 * 从 JSON Schema 生成一份示例值（预填请求体正文）。
 *
 * 优先级：example > default > enum[0] > 按 type 推断。`$ref` 走注册表并带循环守卫
 * （循环引用时返回 `{}`，避免无限递归）。allOf 合并、oneOf/anyOf 取第一个。
 */
function exampleFromSchema(
  raw: unknown,
  refs: Record<string, unknown>,
  stack: string[]
): unknown {
  const schema = asObj(raw)
  if (!schema) return null
  if (typeof schema.$ref === 'string') {
    const key = refKey(schema.$ref)
    if (!key || stack.includes(key)) return {}
    return exampleFromSchema(refs[key], refs, [...stack, key])
  }
  if ('example' in schema) return schema.example
  if ('default' in schema) return schema.default
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]
  if (Array.isArray(schema.allOf)) {
    const merged: Record<string, unknown> = {}
    for (const sub of schema.allOf) {
      const v = exampleFromSchema(sub, refs, stack)
      if (isObj(v)) Object.assign(merged, v)
    }
    return merged
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length)
    return exampleFromSchema(schema.oneOf[0], refs, stack)
  if (Array.isArray(schema.anyOf) && schema.anyOf.length)
    return exampleFromSchema(schema.anyOf[0], refs, stack)
  if (isObj(schema.properties)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(schema.properties)) {
      out[k] = exampleFromSchema(v, refs, stack)
    }
    return out
  }
  const type = asStr(schema.type)
  if (type === 'array') {
    return 'items' in schema ? [exampleFromSchema(schema.items, refs, stack)] : []
  }
  if (type === 'integer' || type === 'number') return 0
  if (type === 'boolean') return true
  if (type === 'null') return null
  if (type === 'string') {
    const fmt = asStr(schema.format)
    if (fmt === 'date-time') return '2024-01-01T00:00:00Z'
    if (fmt === 'date') return '2024-01-01'
    if (fmt === 'uuid' || fmt === 'guid') return '00000000-0000-0000-0000-000000000000'
    if (fmt === 'uri' || fmt === 'url' || fmt === 'hostname') return 'https://example.com'
    if (fmt === 'email') return 'user@example.com'
    return 'string'
  }
  return null
}

/**
 * 参数示例值。只有「显式示例 / 默认值 / 枚举首项」和「能按类型推断的值」才算数，
 * 其余返回 null（调用方按参数位置决定兜底：path/query 用参数名、header 用空串）。
 */
function paramExample(param: Record<string, unknown>, kind: SpecKind): string | null {
  // OAS3 的参数示例在 schema 里；Swagger 2 直接在参数上（schema 可能就是参数本身）
  const schema = kind === 'openapi3' ? (asObj(param.schema) ?? param) : param
  const explicit =
    schema.example ?? schema.default ?? (Array.isArray(schema.enum) ? schema.enum[0] : undefined)
  if (explicit !== undefined) {
    return typeof explicit === 'object' ? JSON.stringify(explicit) : String(explicit)
  }
  const type = asStr(schema.type)
  if (type === 'integer' || type === 'number') return '1'
  if (type === 'boolean') return 'true'
  return null
}

/** 解析参数（可能是 `$ref`）：展开内部引用；展开不了返回 null（该参数被跳过） */
function resolveParam(
  raw: unknown,
  root: Record<string, unknown>
): Record<string, unknown> | null {
  const p = asObj(raw)
  if (!p) return null
  if (typeof p.$ref !== 'string') return p
  const target = resolveRef(p.$ref, root)
  return isObj(target) ? target : null
}

/** OpenAPI 3：多份 mediaType 里挑一份（json 优先），没有则取第一个 */
function pickMediaType(keys: string[]): string {
  const rank = (k: string): number => {
    const l = k.toLowerCase()
    if (l === 'application/json') return 0
    if (l.endsWith('+json')) return 1
    if (l.startsWith('multipart/form-data')) return 2
    if (l === 'application/x-www-form-urlencoded') return 3
    return 4
  }
  let best = keys[0]
  let bestRank = Number.POSITIVE_INFINITY
  for (const k of keys) {
    const r = rank(k)
    if (r < bestRank) {
      bestRank = r
      best = k
    }
  }
  return best
}

/** 拼基准地址：OAS3 取 servers[0].url 并展开 {变量}；Swagger 2 用 schemes + host + basePath */
function resolveBaseUrl(root: Record<string, unknown>, kind: SpecKind): string {
  if (kind === 'openapi3') {
    const servers = Array.isArray(root.servers) ? root.servers : []
    const first = asObj(servers[0])
    let base = asStr(first?.url).replace(/\/+$/, '')
    if (!base) return ''
    const vars = asObj(first?.variables)
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        const def = asStr(asObj(v)?.default)
        if (def) base = base.split(`{${k}}`).join(def)
      }
    }
    return base
  }
  const host = asStr(root.host)
  const basePath = asStr(root.basePath).replace(/\/+$/, '')
  if (!host) return basePath
  const scheme =
    Array.isArray(root.schemes) && root.schemes.length ? asStr(root.schemes[0]) : 'http'
  return `${scheme}://${host}${basePath}`
}

/** 安全方案 → 预填认证头 / 认证查询参数（值为空，提醒用户填 token） */
function applySecurity(
  root: Record<string, unknown>,
  op: Record<string, unknown>,
  kind: SpecKind,
  securitySchemes: Record<string, unknown>,
  headerRows: ApiHeaderPair[],
  queryPairs: ApiHeaderPair[]
): void {
  const reqs = Array.isArray(op.security)
    ? op.security
    : Array.isArray(root.security)
      ? root.security
      : []
  for (const req of reqs) {
    if (!isObj(req)) continue
    for (const schemeName of Object.keys(req)) {
      const scheme = asObj(securitySchemes[schemeName])
      if (!scheme) continue
      const type = asStr(scheme.type)
      if (type === 'apiKey') {
        const name = asStr(scheme.name)
        if (!name) continue
        if (scheme.in === 'header') {
          if (!hasHeader(headerRows, name)) headerRows.push({ key: name, value: '' })
        } else if (scheme.in === 'query') {
          if (!queryPairs.some((p) => p.key === name)) queryPairs.push({ key: name, value: '' })
        }
        // in: cookie 无法用请求头直接表示，跳过
      } else if (type === 'http') {
        const val = asStr(scheme.scheme).toLowerCase()
        if (!hasHeader(headerRows, 'authorization')) {
          headerRows.push({ key: 'Authorization', value: val === 'basic' ? 'Basic ' : 'Bearer ' })
        }
      } else if (type === 'basic') {
        // Swagger 2 的 basic 认证没有 scheme 字段
        if (!hasHeader(headerRows, 'authorization')) {
          headerRows.push({ key: 'Authorization', value: 'Basic ' })
        }
      }
    }
  }
}

/** 去重请求头（键名大小写不敏感，保留首次出现），并丢掉空键 */
function dedupeHeaders(rows: ApiHeaderPair[]): ApiHeaderPair[] {
  const seen = new Set<string>()
  const out: ApiHeaderPair[] = []
  for (const r of rows) {
    const key = r.key.trim()
    if (!key) continue
    const lower = key.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    out.push(r)
  }
  return out
}

/** 键值对 → 查询串（与 api-client.ts 的 serializeParams 语义一致：空键跳过、空值保留） */
function toQueryString(pairs: ApiHeaderPair[]): string {
  const parts: string[] = []
  for (const p of pairs) {
    const k = (p.key ?? '').trim()
    if (!k) continue
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(p.value ?? ''))
  }
  return parts.join('&')
}

/** 把查询串拼进 URL（已有查询就追加） */
function appendQuery(url: string, query: string): string {
  if (!query) return url
  return url.includes('?') ? url + '&' + query : url + '?' + query
}

interface BuildEntryArgs {
  root: Record<string, unknown>
  kind: SpecKind
  op: Record<string, unknown>
  pathKey: string
  method: string
  pathParams: unknown[]
  baseUrl: string
  refs: Record<string, unknown>
  requestBodies: Record<string, unknown>
  securitySchemes: Record<string, unknown>
}

/** 把一个 operation 转成侧边栏条目；结构损坏返回 null（计入 skipped） */
function buildEntry(args: BuildEntryArgs): OpenApiImportEntry | null {
  const { root, kind, op, pathKey, method, pathParams, baseUrl, refs, requestBodies, securitySchemes } =
    args

  // 合并路径级与操作级参数：操作级同名（in + name）覆盖路径级
  const merged = new Map<string, Record<string, unknown>>()
  for (const raw of pathParams) {
    const p = resolveParam(raw, root)
    if (p) merged.set(`${asStr(p.in)}:${asStr(p.name)}`, p)
  }
  const opParams = Array.isArray(op.parameters) ? op.parameters : []
  for (const raw of opParams) {
    const p = resolveParam(raw, root)
    if (p) merged.set(`${asStr(p.in)}:${asStr(p.name)}`, p)
  }
  const params = [...merged.values()]

  // URL + 路径参数替换 + 查询参数收集
  let url = baseUrl + pathKey
  const queryPairs: ApiHeaderPair[] = []
  const headerRows: ApiHeaderPair[] = []
  for (const param of params) {
    const pname = asStr(param.name)
    if (!pname) continue
    const ex = paramExample(param, kind)
    if (param.in === 'path') {
      // 路径参数必须有值才能发出去：没有示例就用参数名兜底
      url = url.split(`{${pname}}`).join(ex !== null ? ex : pname)
    } else if (param.in === 'query') {
      queryPairs.push({ key: pname, value: ex !== null ? ex : pname })
    } else if (param.in === 'header') {
      headerRows.push({ key: pname, value: ex !== null ? ex : '' })
    }
  }

  // 安全方案可能再补查询参数 / 认证头，必须在「序列化查询串」之前
  applySecurity(root, op, kind, securitySchemes, headerRows, queryPairs)
  if (queryPairs.length) url = appendQuery(url, toQueryString(queryPairs))

  // ---------- 请求体（两种格式结构完全不同，分开处理） ----------
  let body = ''
  let bodyType: ApiBodyType | undefined
  let bodyUrlencoded: ApiHeaderPair[] | undefined
  let bodyFormFields: ApiFormField[] | undefined
  let contentType: string | null = null

  if (kind === 'swagger2') {
    const consumes = Array.isArray(op.consumes)
      ? op.consumes
      : Array.isArray(root.consumes)
        ? root.consumes
        : []
    const consumesText = consumes.map((c) => asStr(c).toLowerCase())
    const bodyParam = params.find((p) => p.in === 'body')
    const formParams = params.filter((p) => p.in === 'formData')
    if (bodyParam) {
      const schema = asObj(bodyParam.schema)
      const value = schema ? exampleFromSchema(schema, refs, []) : null
      body = value === null || value === undefined ? '' : JSON.stringify(value, null, 2)
      if (body) {
        bodyType = 'raw'
        contentType = consumesText.find((c) => c.includes('json')) || consumesText[0]
      }
    } else if (formParams.length) {
      const isMultipart = consumesText.some((c) => c.startsWith('multipart/form-data'))
      if (isMultipart) {
        bodyType = 'form-data'
        bodyFormFields = formParams.map((p) => ({
          key: asStr(p.name),
          value: paramExample(p, kind) ?? '',
          isFile: asStr(p.type) === 'file'
        }))
        contentType = 'multipart/form-data'
      } else {
        bodyType = 'x-www-form-urlencoded'
        bodyUrlencoded = formParams.map((p) => ({
          key: asStr(p.name),
          value: paramExample(p, kind) ?? ''
        }))
        contentType = 'application/x-www-form-urlencoded'
      }
    }
    // Accept：Swagger 2 的 produces 是显式的；OAS3 没有等价物，不猜
    const produces = Array.isArray(op.produces)
      ? op.produces
      : Array.isArray(root.produces)
        ? root.produces
        : []
    if (produces.length && !hasHeader(headerRows, 'accept')) {
      headerRows.push({ key: 'Accept', value: asStr(produces[0]) })
    }
  } else {
    let rb = asObj(op.requestBody)
    if (rb && typeof rb.$ref === 'string') {
      const target = requestBodies[refKey(rb.$ref)]
      rb = isObj(target) ? target : null
    }
    const content = asObj(rb?.content)
    if (content) {
      const keys = Object.keys(content)
      if (keys.length) {
        const media = pickMediaType(keys)
        const entry = asObj(content[media])
        const schema = asObj(entry?.schema)
        if (media.toLowerCase().includes('json')) {
          const value = schema ? exampleFromSchema(schema, refs, []) : null
          body = value === null || value === undefined ? '' : JSON.stringify(value, null, 2)
          if (body) {
            bodyType = 'raw'
            contentType = media
          }
        } else if (media.toLowerCase().startsWith('multipart/form-data')) {
          bodyType = 'form-data'
          const props = asObj(schema?.properties)
          bodyFormFields = props
            ? Object.entries(props).map(([k, v]) => ({
                key: k,
                value: String(exampleFromSchema(v, refs, []) ?? ''),
                isFile: false
              }))
            : []
          contentType = 'multipart/form-data'
        } else if (media.toLowerCase() === 'application/x-www-form-urlencoded') {
          bodyType = 'x-www-form-urlencoded'
          const props = asObj(schema?.properties)
          bodyUrlencoded = props
            ? Object.entries(props).map(([k, v]) => ({
                key: k,
                value: String(exampleFromSchema(v, refs, []) ?? '')
              }))
            : []
          contentType = 'application/x-www-form-urlencoded'
        } else {
          const value = schema ? exampleFromSchema(schema, refs, []) : null
          body =
            value === null || value === undefined
              ? ''
              : typeof value === 'object'
                ? JSON.stringify(value, null, 2)
                : String(value)
          if (body) {
            bodyType = 'raw'
            contentType = media
          }
        }
      }
    }
  }

  // 有正文才补 Content-Type（空的正文发 Content-Type 没意义）
  if (contentType && !hasHeader(headerRows, 'content-type')) {
    headerRows.push({ key: 'Content-Type', value: contentType })
  }

  const name = asStr(op.summary) || asStr(op.operationId) || `${method} ${pathKey}`
  const group = asStr((Array.isArray(op.tags) ? op.tags[0] : '') ?? '').trim()

  return {
    group,
    method,
    url,
    name,
    headers: dedupeHeaders(headerRows),
    body,
    bodyType,
    bodyUrlencoded,
    bodyFormFields
  }
}

/**
 * 解析 OpenAPI / Swagger 规格（JSON 或 YAML 文本）为可导入的请求列表。
 * 无法识别的格式 / 非法内容会抛错（错误信息可直接展示给用户）。
 *
 * 版本识别的口径：`openapi: 3.x` 与 `swagger: 3.x`（Swagger 3 即 OpenAPI 3 的旧名）
 * 都按 OpenAPI 3 处理；`swagger: 2.x` 按 Swagger 2 处理；其余报错。
 */
export function parseOpenApiSpec(text: string): OpenApiImportResult {
  let doc: unknown
  if (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
    // JSON：先按 JSON 解析（更快、报错信息更准）；失败再交给 YAML（JSON 是 YAML 的子集）
    try {
      doc = JSON.parse(text)
    } catch {
      try {
        doc = parseYaml(text)
      } catch {
        throw new Error('不是有效的 JSON 或 YAML（当前仅支持 OpenAPI / Swagger 的 JSON / YAML 格式）')
      }
    }
  } else {
    try {
      doc = parseYaml(text)
    } catch {
      // YAML 解析失败不吞 JSON 的错误：两者都试一遍再报混合错误
      try {
        doc = JSON.parse(text)
      } catch {
        throw new Error('不是有效的 JSON 或 YAML（当前仅支持 OpenAPI / Swagger 的 JSON / YAML 格式）')
      }
    }
  }
  const root = asObj(doc)
  if (!root) throw new Error('规格内容不是对象（需要 JSON / YAML 的 OpenAPI 或 Swagger 文档）')

  const versionField = asStr(root.openapi) || asStr(root.swagger)
  let kind: SpecKind
  if (versionField.startsWith('3.')) kind = 'openapi3'
  else if (versionField.startsWith('2.')) kind = 'swagger2'
  else {
    throw new Error(
      `无法识别的规格：需要 openapi 3.x 或 swagger 2.x 字段，实际读到「${versionField || '空'}」`
    )
  }

  const info = asObj(root.info)
  const title = asStr(info?.title)
  const version = asStr(info?.version)

  const components = asObj(root.components)
  const refs =
    kind === 'openapi3'
      ? (asObj(components?.schemas) ?? {})
      : (asObj(root.definitions) ?? {})
  const requestBodies =
    kind === 'openapi3' ? (asObj(components?.requestBodies) ?? {}) : {}
  const securitySchemes =
    kind === 'openapi3'
      ? (asObj(components?.securitySchemes) ?? {})
      : (asObj(root.securityDefinitions) ?? {})

  const baseUrl = resolveBaseUrl(root, kind)
  const paths = asObj(root.paths)

  const entries: OpenApiImportEntry[] = []
  const groups: string[] = []
  let skipped = 0

  for (const [pathKey, pathItemRaw] of Object.entries(paths ?? {})) {
    let pathItem = asObj(pathItemRaw)
    if (!pathItem) continue
    // 路径项允许是 $ref（OAS3）：只解析内部引用，外部引用跳过
    if (typeof pathItem.$ref === 'string') {
      const target = resolveRef(pathItem.$ref, root)
      const resolved = asObj(target)
      if (!resolved) {
        skipped += 1
        continue
      }
      pathItem = resolved
    }
    const pathParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : []
    for (const method of HTTP_METHODS) {
      const op = asObj(pathItem[method])
      if (!op || Object.keys(op).length === 0) continue
      const entry = buildEntry({
        root,
        kind,
        op,
        pathKey,
        method: method.toUpperCase(),
        pathParams,
        baseUrl,
        refs,
        requestBodies,
        securitySchemes
      })
      if (!entry) {
        skipped += 1
        continue
      }
      entries.push(entry)
      if (entry.group && !groups.includes(entry.group)) groups.push(entry.group)
    }
  }

  // 整份文档一个 tag 都没有：统一进一个以标题命名的分组，避免全部堆进「未分组」
  if (entries.length > 0 && groups.length === 0) {
    const fallback = title || '导入的接口'
    for (const e of entries) e.group = fallback
    groups.push(fallback)
  }

  return {
    format: kind === 'openapi3' ? 'OpenAPI 3.x' : 'Swagger 2.0',
    title,
    version,
    groups,
    entries,
    skipped
  }
}