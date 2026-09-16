/**
 * api-client 插件主进程入口。
 * HTTP 与持久化能力由宿主（主进程 PluginHost）直接提供，
 * 因此此处无需注册额外 handler，仅做加载日志。
 */
export function activate(api) {
  api.log('api-client 主进程已加载')
  return { name: '接口请求' }
}
