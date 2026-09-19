//! AI 对话与 MCP 命令：发起/中止对话、回复命令确认、列出 MCP 工具。

use tauri::{AppHandle, State};

use crate::error::AppResult;
use crate::models::{AiChatRequest, AiChatStarted, McpToolsResult};
use crate::state::AppState;

/// 发起一次 AI 对话：立即返回 requestId，流式结果经 `ai:chat-event` 广播
#[tauri::command]
pub fn ai_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    req: AiChatRequest,
) -> AppResult<AiChatStarted> {
    Ok(state.ai.chat(&app, req))
}

#[tauri::command]
pub fn ai_abort(state: State<'_, AppState>, request_id: String) -> AppResult<()> {
    state.ai.abort(&request_id);
    Ok(())
}

#[tauri::command]
pub fn ai_confirm_resolve(
    state: State<'_, AppState>,
    id: String,
    approved: bool,
) -> AppResult<()> {
    state.ai.resolve_confirm(&id, approved);
    Ok(())
}

/// 设置页用：列出各 MCP server 暴露的工具与连接错误
#[tauri::command]
pub async fn mcp_list_tools(state: State<'_, AppState>) -> AppResult<McpToolsResult> {
    let servers = state.storage.list_mcp_servers();
    Ok(state.mcp.list_tools(&servers).await)
}
