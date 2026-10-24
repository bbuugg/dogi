// mkdir 路由已合并到 /api/fs/dirs 的 POST 中（与原 Hono 路由一致）
// 但契约中 fsMkdir 和 fsDirs 是分开的路径，所以这里保留一个独立文件
export { POST, GET } from '@/app/api/fs/dirs/route'
