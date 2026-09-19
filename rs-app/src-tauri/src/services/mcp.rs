//! MCP 客户端管理：用官方 Rust SDK（rmcp）以 stdio 方式连接 MCP server，
//! 把其工具包装成 AI 可调用的工具。
//!
//! 协议实现完全交给 rmcp，本模块只负责：进程启动参数拼装、连接缓存、
//! 工具列举与调用、以及错误信息汇总（供设置页展示）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rmcp::model::{CallToolRequestParams, ClientCapabilities, ClientInfo, ContentBlock, Implementation};
use rmcp::service::{RoleClient, RunningService};
use rmcp::transport::TokioChildProcess;
use rmcp::ServiceExt;
use serde_json::{Map, Value};

use crate::models::{McpServerConfig, McpToolInfo, McpToolsResult};

/// 连接 / 列举工具的超时（与 Electron 版一致）
const CONNECT_TIMEOUT_MS: u64 = 15_000;
/// 单次工具调用超时
const CALL_TIMEOUT_MS: u64 = 120_000;

/// 一个可暴露给模型的 MCP 工具
#[derive(Debug, Clone)]
pub struct McpToolDef {
    /// 所属 server 的配置 id（调用时用于定位连接）
    pub server_id: String,
    pub server_name: String,
    /// MCP server 中声明的原始工具名
    pub tool_name: String,
    /// 暴露给模型的名字（同名冲突时加 server 名前缀）
    pub exposed_name: String,
    pub description: Option<String>,
    /// 工具入参 JSON Schema
    pub schema: Value,
}

/// 一条已建立的 MCP 连接（含其工具清单缓存）
struct McpConnection {
    service: RunningService<RoleClient, ClientInfo>,
    tools: Vec<McpToolDef>,
}

impl McpConnection {
    fn shutdown(&self) {
        self.service.cancellation_token().cancel();
    }
}

/// MCP 连接池：按 server 配置 id 缓存连接，配置变更时失效重建
#[derive(Default)]
pub struct McpManager {
    connections: Mutex<HashMap<String, Arc<McpConnection>>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 失效指定 server（或全部）的连接：配置变更 / 删除后调用
    pub fn invalidate(&self, id: Option<&str>) {
        let mut conns = self.connections.lock().unwrap();
        match id {
            Some(id) => {
                if let Some(conn) = conns.remove(id) {
                    conn.shutdown();
                }
            }
            None => {
                for conn in conns.values() {
                    conn.shutdown();
                }
                conns.clear();
            }
        }
    }

    /// 取（必要时建立）连接
    async fn ensure(
        &self,
        config: &McpServerConfig,
    ) -> Result<Arc<McpConnection>, String> {
        if let Some(existing) = self.connections.lock().unwrap().get(&config.id).cloned() {
            if !existing.service.is_closed() {
                return Ok(existing);
            }
        }
        let conn = Arc::new(connect(config).await?);
        self.connections
            .lock()
            .unwrap()
            .insert(config.id.clone(), conn.clone());
        Ok(conn)
    }

    /// 为所有启用的 server 构建工具集；同时返回不可用 server 的错误信息
    pub async fn build_tools(
        &self,
        servers: &[McpServerConfig],
    ) -> (Vec<McpToolDef>, Vec<String>) {
        let mut tools: Vec<McpToolDef> = Vec::new();
        let mut errors: Vec<String> = Vec::new();

        for config in servers.iter().filter(|s| s.enabled) {
            match self.ensure(config).await {
                Ok(conn) => tools.extend(conn.tools.iter().cloned()),
                Err(err) => errors.push(format!("MCP[{}] {err}", display_name(config))),
            }
        }
        (tools, errors)
    }

    /// 设置页用：列出各 server 的工具与错误
    pub async fn list_tools(&self, servers: &[McpServerConfig]) -> McpToolsResult {
        let mut result = McpToolsResult::default();
        for config in servers.iter().filter(|s| s.enabled) {
            match self.ensure(config).await {
                Ok(conn) => result.tools.extend(conn.tools.iter().map(|t| McpToolInfo {
                    server_name: t.server_name.clone(),
                    name: t.exposed_name.clone(),
                    description: t.description.clone(),
                })),
                Err(err) => result.errors.push(format!("MCP[{}] {err}", display_name(config))),
            }
        }
        result
    }

    /// 调用某个 MCP 工具，返回（文本结果, 是否错误）
    pub async fn call_tool(
        &self,
        server_id: &str,
        tool_name: &str,
        arguments: Value,
    ) -> Result<(String, bool), String> {
        let conn = self
            .connections
            .lock()
            .unwrap()
            .get(server_id)
            .cloned()
            .ok_or_else(|| format!("MCP server 未连接: {server_id}"))?;

        let args: Map<String, Value> = match arguments {
            Value::Object(map) => map,
            Value::Null => Map::new(),
            other => {
                let mut map = Map::new();
                map.insert("value".into(), other);
                map
            }
        };

        let params = CallToolRequestParams::new(tool_name.to_string()).with_arguments(args);
        let call = conn.service.call_tool(params);
        let result = tokio::time::timeout(Duration::from_millis(CALL_TIMEOUT_MS), call)
            .await
            .map_err(|_| format!("MCP 工具调用超时（{CALL_TIMEOUT_MS}ms）"))?
            .map_err(|e| format!("MCP 工具调用失败: {e}"))?;

        let is_error = result.is_error.unwrap_or(false);
        let mut text = result
            .content
            .iter()
            .map(content_to_text)
            .collect::<Vec<_>>()
            .join("\n");
        if text.is_empty() {
            if let Some(structured) = &result.structured_content {
                text = structured.to_string();
            }
        }
        Ok((text, is_error))
    }
}

fn display_name(config: &McpServerConfig) -> String {
    if config.name.is_empty() {
        config.command.clone()
    } else {
        config.name.clone()
    }
}

/// 内容块转纯文本（图片 / 音频等二进制内容只给占位说明）
fn content_to_text(block: &ContentBlock) -> String {
    match block {
        ContentBlock::Text(t) => t.text.clone(),
        ContentBlock::Image(_) => "[图片内容]".into(),
        ContentBlock::Audio(_) => "[音频内容]".into(),
        ContentBlock::Resource(r) => serde_json::to_string(&r.resource).unwrap_or_default(),
        ContentBlock::ResourceLink(l) => format!("[资源链接] {}", l.uri),
        other => format!("[{other:?}]"),
    }
}

/// 启动 stdio 子进程并完成 MCP 握手，随后列举工具
async fn connect(config: &McpServerConfig) -> Result<McpConnection, String> {
    if config.command.trim().is_empty() {
        return Err("未配置启动命令".into());
    }
    let transport = build_transport(config)?;

    let info = ClientInfo::new(
        ClientCapabilities::default(),
        Implementation::new("opsdesk", env!("CARGO_PKG_VERSION")),
    );

    let service = tokio::time::timeout(Duration::from_millis(CONNECT_TIMEOUT_MS), info.serve(transport))
        .await
        .map_err(|_| format!("连接超时（{CONNECT_TIMEOUT_MS}ms）"))?
        .map_err(|e| format!("握手失败: {e}"))?;

    let listed = service
        .list_all_tools()
        .await
        .map_err(|e| format!("列出工具失败: {e}"))?;

    // 同名工具加 server 名前缀，避免多个 server 之间的名字冲突
    let duplicated: Vec<String> = {
        let mut seen: HashMap<&str, usize> = HashMap::new();
        for t in &listed {
            *seen.entry(t.name.as_ref()).or_insert(0) += 1;
        }
        seen.into_iter()
            .filter(|(_, n)| *n > 1)
            .map(|(name, _)| name.to_string())
            .collect()
    };

    let tools = listed
        .iter()
        .map(|t| {
            let raw = t.name.to_string();
            let exposed_name = if duplicated.contains(&raw) {
                format!("{}__{raw}", config.name)
            } else {
                raw.clone()
            };
            McpToolDef {
                server_id: config.id.clone(),
                server_name: display_name(config),
                tool_name: raw,
                exposed_name,
                description: t.description.as_ref().map(|d| d.to_string()),
                schema: Value::Object((*t.input_schema).clone()),
            }
        })
        .collect();

    Ok(McpConnection { service, tools })
}

/// 组装 stdio 传输：Windows 下 `npx` / `.cmd` 之类需要经 cmd.exe 转一层
fn build_transport(config: &McpServerConfig) -> Result<TokioChildProcess, String> {
    let command = config.command.trim();

    #[cfg(windows)]
    let mut cmd = {
        let needs_shell = !command.to_ascii_lowercase().ends_with(".exe");
        if needs_shell {
            let mut c = tokio::process::Command::new("cmd.exe");
            c.arg("/c").arg(command);
            c
        } else {
            tokio::process::Command::new(command)
        }
    };
    #[cfg(not(windows))]
    let mut cmd = tokio::process::Command::new(command);

    cmd.args(&config.args);
    if let Some(env) = &config.env {
        cmd.envs(env);
    }

    TokioChildProcess::new(cmd).map_err(|e| format!("启动子进程失败: {e}"))
}
