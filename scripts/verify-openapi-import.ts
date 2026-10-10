/**
 * OpenAPI / Swagger 规格导入解析器（`features/api/openapi-import.ts`）的验证：
 * 直接跑真源码，不需要打包 / 不起 Electron / 不写文件。
 *
 * 覆盖两种格式的转换：OpenAPI 3.x（servers / requestBody / components.schemas）
 * 与 Swagger 2.0（host + basePath / in: body / consumes / definitions），
 * 以及公共规则：tag 分组、路径参数示例替换、查询参数序列化、JSON 示例正文生成、
 * 表单字段映射、安全方案预填、$ref 解析、非法输入报错。
 *
 * 另外覆盖：
 * - YAML 输入（JSON 与 YAML 双解析）、`swagger: "3.x"` 按 OpenAPI 3 识别；
 * - 多级分组树模型（features/api/group-tree.ts）：树构建 / DFS 块摊平 /
 *   未分组收集 / 子树统计 / 带整棵子树的移动。
 *
 * 能直接跑：node --experimental-strip-types scripts/verify-openapi-import.ts
 */

import assert from 'node:assert/strict'
import { stringify } from 'yaml'
import { parseOpenApiSpec, type OpenApiImportResult } from '../src/renderer/src/features/api/openapi-import.ts'
import {
  buildGroupTree,
  collectUngrouped,
  countSubtreeRequests,
  flattenBlocks,
  moveGroup,
  subtreeOf
} from '../src/renderer/src/features/api/group-tree.ts'
import type { ApiGroup, ApiRequestEntry } from '../src/shared/types.ts'

let passed = 0
const check = (label: string, ok: boolean): void => {
  assert.ok(ok, `FAIL: ${label}`)
  passed++
  console.log(`  ok  ${label}`)
}

const parse = (doc: Record<string, unknown>): OpenApiImportResult =>
  parseOpenApiSpec(JSON.stringify(doc))

console.log('— OpenAPI 3.x —')

const oas3 = parse({
  openapi: '3.0.0',
  info: { title: '宠物店', version: '1.2.3' },
  servers: [{ url: 'https://api.example.com/v2' }],
  paths: {
    '/pets/{petId}': {
      get: {
        tags: ['pet'],
        summary: '按 id 查宠物',
        parameters: [
          { name: 'petId', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'verbose', in: 'query', schema: { type: 'boolean' } },
          { name: 'X-Trace-Id', in: 'header', schema: { type: 'string' } }
        ]
      }
    },
    '/pets': {
      post: {
        tags: ['pet'],
        operationId: 'createPet',
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } }
        }
      }
    }
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          bornAt: { type: 'string', format: 'date-time' }
        }
      }
    }
  }
})
check('OAS3: 格式识别为 OpenAPI 3.x', oas3.format === 'OpenAPI 3.x')
check('OAS3: 标题与版本', oas3.title === '宠物店' && oas3.version === '1.2.3')
check('OAS3: 按 tag 分组', oas3.groups.length === 1 && oas3.groups[0] === 'pet')
check('OAS3: 解析出 2 个操作', oas3.entries.length === 2)
const getPet = oas3.entries.find((e) => e.method === 'GET')!
check('OAS3: 服务端地址 + 路径', getPet.url.startsWith('https://api.example.com/v2/pets/'))
check('OAS3: 路径参数替换成示例值', getPet.url.includes('/pets/1'))
check('OAS3: 查询参数进 URL（布尔给 true）', getPet.url.includes('verbose=true'))
check('OAS3: header 参数进请求头', getPet.headers.some((h) => h.key === 'X-Trace-Id'))
check('OAS3: 名称取 summary', getPet.name === '按 id 查宠物')
const createPet = oas3.entries.find((e) => e.method === 'POST')!
check('OAS3: 名称取 operationId', createPet.name === 'createPet')
check('OAS3: 请求体为 raw JSON 示例', createPet.bodyType === 'raw' && createPet.body.includes('"bornAt": "2024-01-01T00:00:00Z"'))
check('OAS3: $ref schema 展开（含数组与嵌套对象）', createPet.body.includes('"tags": ['))
check('OAS3: Content-Type 用 requestBody 的媒体类型', createPet.headers.some((h) => h.key === 'Content-Type' && h.value === 'application/json'))

console.log('— OpenAPI 3.1: 表单与安全方案 —')

const oas31 = parse({
  openapi: '3.1.0',
  info: { title: '表单接口' },
  servers: [{ url: 'https://s.example.com' }],
  security: [{ ApiKey: [] }],
  components: {
    securitySchemes: {
      ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      Auth: { type: 'http', scheme: 'bearer' }
    }
  },
  paths: {
    '/upload': {
      post: {
        requestBody: {
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: { file: { type: 'string' }, note: { type: 'string' } }
              }
            }
          }
        }
      }
    },
    '/login': {
      post: {
        security: [{ Auth: [] }],
        requestBody: {
          content: {
            'application/x-www-form-urlencoded': {
              schema: { type: 'object', properties: { username: { type: 'string' } } }
            }
          }
        }
      }
    }
  }
})
const upload = oas31.entries.find((e) => e.url.endsWith('/upload'))!
check('OAS3.1: multipart 映射成 form-data 字段', upload.bodyType === 'form-data' && upload.bodyFormFields?.length === 2)
check('OAS3.1: 安全 apiKey 预填 header（空值）', upload.headers.some((h) => h.key === 'X-API-Key' && h.value === ''))
const login = oas31.entries.find((e) => e.url.endsWith('/login'))!
check('OAS3.1: 操作级 security 覆盖根级（只预填 bearer）', !login.headers.some((h) => h.key === 'X-API-Key') && login.headers.some((h) => h.key === 'Authorization' && h.value === 'Bearer '))
check('OAS3.1: urlencoded 映射成键值对', login.bodyType === 'x-www-form-urlencoded' && login.bodyUrlencoded?.[0]?.key === 'username')

console.log('— Swagger 2.0 —')

const sw2 = parse({
  swagger: '2.0',
  info: { title: '老接口', version: '1.0' },
  host: 'old.example.com',
  basePath: '/api',
  schemes: ['https'],
  consumes: ['application/json'],
  produces: ['application/json'],
  definitions: {
    Order: { type: 'object', properties: { id: { type: 'integer' }, status: { type: 'string', enum: ['open', 'closed'] } } }
  },
  securityDefinitions: { BasicAuth: { type: 'basic' } },
  paths: {
    '/orders': {
      post: {
        summary: '下单',
        parameters: [{ name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Order' } }],
        security: [{ BasicAuth: [] }]
      }
    },
    '/orders/{id}/files': {
      post: {
        summary: '传附件',
        consumes: ['multipart/form-data'],
        parameters: [
          { name: 'id', in: 'path', required: true, type: 'integer' },
          { name: 'file', in: 'formData', required: true, type: 'file' },
          { name: 'desc', in: 'formData', type: 'string' }
        ]
      }
    }
  }
})
check('Swagger2: 格式识别', sw2.format === 'Swagger 2.0')
check('Swagger2: schemes+host+basePath 拼地址', sw2.entries[0].url.startsWith('https://old.example.com/api/orders'))
check('Swagger2: in:body 参数生成 JSON 示例（enum 取首项）', sw2.entries[0].body.includes('"status": "open"'))
check('Swagger2: consumes 给 Content-Type', sw2.entries[0].headers.some((h) => h.key === 'Content-Type' && h.value === 'application/json'))
check('Swagger2: produces 给 Accept', sw2.entries[0].headers.some((h) => h.key === 'Accept' && h.value === 'application/json'))
check('Swagger2: basic 安全预填 Authorization', sw2.entries[0].headers.some((h) => h.key === 'Authorization' && h.value === 'Basic '))
const fileUp = sw2.entries.find((e) => e.url.includes('/orders/1/files'))!
check('Swagger2: formData 文件字段标 isFile', fileUp.bodyType === 'form-data' && fileUp.bodyFormFields?.some((f) => f.key === 'file' && f.isFile))
check('Swagger2: multipart Content-Type', fileUp.headers.some((h) => h.key === 'Content-Type' && h.value.includes('multipart/form-data')))

console.log('— 分组兜底与错误输入 —')

const noTags = parse({
  openapi: '3.0.0',
  info: { title: '无标签规格' },
  paths: { '/ping': { get: { summary: 'ping' } } }
})
check('无 tag：统一进标题组', noTags.groups.length === 1 && noTags.groups[0] === '无标签规格' && noTags.entries[0].group === '无标签规格')

const untaggedMixed = parse({
  openapi: '3.0.0',
  info: { title: '混标签' },
  paths: {
    '/a': { get: { tags: ['x'], summary: 'a' } },
    '/b': { get: { summary: 'b' } }
  }
})
check('混标签：无 tag 的操作进未分组（group 为空串）', untaggedMixed.entries.find((e) => e.url.endsWith('/b'))!.group === '' && untaggedMixed.groups.length === 1)

const serverless = parse({
  openapi: '3.0.0',
  paths: { '/bare': { get: { operationId: 'bareGet' } } }
})
check('无 servers/无 tag：标题为空时分组回落「导入的接口」', serverless.groups[0] === '导入的接口' && serverless.entries[0].url === '/bare')

const assertThrows = (label: string, fn: () => unknown, snippet: string): void => {
  let msg = ''
  try {
    fn()
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e)
  }
  check(label, msg.includes(snippet))
}
assertThrows('非法 JSON 报错', () => parseOpenApiSpec('{oops'), '不是有效的 JSON')
assertThrows('缺格式字段报错', () => parseOpenApiSpec('{"info":{}}'), '无法识别的规格')
assertThrows('不支持的版本号报错', () => parseOpenApiSpec('{"swagger":"1.2"}'), '无法识别的规格')
assertThrows('非法 YAML 报错', () => parseOpenApiSpec('openapi: [未闭合'), '不是有效的 JSON 或 YAML')

console.log('— YAML 输入与 Swagger 3.x（= OpenAPI 3） —')

const yamlOas3 = stringify({
  openapi: '3.0.3',
  info: { title: 'YAML 接口', version: '0.1' },
  servers: [{ url: 'https://y.example.com' }],
  paths: {
    '/pets': { get: { tags: ['pet'], summary: 'yaml 查询' } },
    '/cats': {
      post: {
        tags: ['cat'],
        summary: 'yaml 建猫',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } }
        }
      }
    }
  }
})
const yamlRes = parseOpenApiSpec(yamlOas3)
check('YAML 可解析：识别为 OpenAPI 3.x', yamlRes.format === 'OpenAPI 3.x' && yamlRes.title === 'YAML 接口')
check('YAML：操作数与 tag 分组', yamlRes.entries.length === 2 && yamlRes.groups.join(',') === 'pet,cat')
check('YAML：请求体照样生成示例', yamlRes.entries.find((e) => e.method === 'POST')!.body.includes('"name"'))

const yamlSw2 = stringify({
  swagger: '2.0',
  info: { title: '老 YAML', version: '1.0' },
  host: 'oldy.example.com',
  basePath: '/api',
  schemes: ['https'],
  paths: { '/ping': { get: { summary: 'ping' } } }
})
const sw2y = parseOpenApiSpec(yamlSw2)
check('Swagger 2.0 的 YAML 也能解析', sw2y.format === 'Swagger 2.0' && sw2y.entries[0].url === 'https://oldy.example.com/api/ping')

const sw3 = parse({ swagger: '3.0.0', info: { title: 'Swagger3 版' }, paths: { '/x': { get: { summary: 'x' } } } })
check('swagger: 3.x 即 OpenAPI 3，按 OpenAPI 3 处理', sw3.format === 'OpenAPI 3.x' && sw3.entries[0].url === '/x')

console.log('— 多级分组树模型（group-tree.ts） —')

const G = (id: string, parentId?: string): ApiGroup => ({ id, name: id, parentId, createdAt: 0 })
const R = (id: string, groupId?: string): ApiRequestEntry => ({
  id,
  name: id,
  method: 'GET',
  url: 'https://x.test',
  headers: [],
  body: '',
  groupId,
  createdAt: 0,
  updatedAt: 0
})
const groups6: ApiGroup[] = [G('a'), G('b', 'a'), G('c', 'b'), G('d'), G('e', 'd')]
const reqs6: ApiRequestEntry[] = [
  R('r-a1', 'a'),
  R('r-b1', 'b'),
  R('r-c1', 'c'),
  R('r-d1', 'd'),
  R('r-none'),
  R('r-ghost', 'zz')
]
const tree6 = buildGroupTree(groups6, reqs6)
check('树构建：三级父子链 a>b>c 与 d>e', tree6[0].children[0].children[0].group.id === 'c' && tree6[1].children[0].group.id === 'e')
check('树构建：请求挂到直接分组', tree6[0].items.some((x) => x.id === 'r-a1') && tree6[0].children[0].items.some((x) => x.id === 'r-b1'))
check('未分组收集：无分组 + 悬挂 groupId', collectUngrouped(reqs6, groups6).map((x) => x.id).join(',') === 'r-none,r-ghost')
const blocks6 = flattenBlocks(tree6, collectUngrouped(reqs6, groups6))
check('块摊平：未分组块恒在首位', blocks6[0].groupId === undefined && blocks6[0].items.length === 2)
check('块摊平：DFS 前序 a,b,c,d,e', blocks6.map((b) => b.groupId ?? '').join(',') === ',a,b,c,d,e')
check('子树收集：a=3 项 / d=2 项 / b=2 项（含 c）', subtreeOf(groups6, 'a').size === 3 && subtreeOf(groups6, 'd').size === 2 && subtreeOf(groups6, 'b').size === 2)
check('子树请求数：a=3（a/b/c 上的请求）, d=1', countSubtreeRequests(groups6, reqs6, 'a') === 3 && countSubtreeRequests(groups6, reqs6, 'd') === 1)
const movedRoot = moveGroup(groups6, 'b', undefined)
check('移动到顶级：整棵子树一起走', movedRoot.map((g) => g.id).join(',') === 'a,d,e,b,c' && movedRoot.find((g) => g.id === 'b')?.parentId === undefined)
const movedUnder = moveGroup(groups6, 'd', 'b')
check('移动到 b 下：插到 b 子树末尾且 DFS 序保持', movedUnder.map((g) => g.id).join(',') === 'a,b,c,d,e' && movedUnder.find((g) => g.id === 'd')?.parentId === 'b')
const badMove = moveGroup(groups6, 'a', 'c')
check('非法移动（挂到自己子孙）原样返回', badMove.map((g) => g.id).join(',') === groups6.map((g) => g.id).join(','))

console.log(`\n${passed} checks passed`)