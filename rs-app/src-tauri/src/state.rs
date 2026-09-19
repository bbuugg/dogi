//! 应用全局状态：在 `setup` 中构建并交给 Tauri 托管。

use std::sync::Arc;

use crate::services::ai::AiService;
use crate::services::mcp::McpManager;
use crate::services::sessions::manager::SessionManager;
use crate::storage::Storage;

pub struct AppState {
    pub storage: Storage,
    pub sessions: SessionManager,
    /// AI 对话服务：按终端会话维护独立的助手实例
    pub ai: Arc<AiService>,
    /// MCP 客户端连接池
    pub mcp: McpManager,
}

impl AppState {
    pub fn new(storage: Storage) -> Self {
        Self {
            storage,
            sessions: SessionManager::new(),
            ai: Arc::new(AiService::new()),
            mcp: McpManager::new(),
        }
    }
}
