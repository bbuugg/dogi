//! 统一终端会话管理器：创建 / 写入 / 调整尺寸 / 关闭 / 输出转发。

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use serde::Serialize;
use tauri::AppHandle;

use crate::error::{AppError, AppResult};
use crate::events;
use crate::models::{SessionInfo, SshProfile};

use super::local::LocalSession;
use super::ssh::SshSession;

/// 每个会话保留的输出缓冲上限（供 AI 读取）
pub const MAX_OUTPUT_BUFFER: usize = 256 * 1024;

/// 统一终端类型：必须是 256 色终端，否则远程 ncurses 程序（htop/btop 等）会按无色渲染。
pub const TERM_TYPE: &str = "xterm-256color";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataPayload {
    pub session_id: String,
    /// base64：渲染端适配层负责解码回 Uint8Array
    pub data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitPayload {
    pub session_id: String,
    pub exit_code: i32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedPayload {
    pub session_id: String,
}

pub trait Session: Send + Sync {
    fn info(&self) -> SessionInfo;
    fn write(&self, data: &[u8]) -> AppResult<()>;
    fn resize(&self, cols: u16, rows: u16);
    fn kill(&self);
    fn recent_output(&self, max_chars: usize) -> String;
    /// 输出缓冲的当前总字节数（AI 工具据此定位「写入前」的位置，只回传增量）
    fn output_len(&self) -> usize;
    /// 读取 `start` 偏移之后的新增输出（字节边界非法时回退到空串）
    fn output_from(&self, start: usize) -> String;
    fn is_ready(&self) -> bool;
}

#[derive(Default)]
pub struct SessionManager {
    sessions: RwLock<HashMap<String, Arc<dyn Session>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.sessions
            .read()
            .unwrap()
            .values()
            .map(|s| s.info())
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn Session>> {
        self.sessions.read().unwrap().get(id).cloned()
    }

    fn attach(&self, id: &str, session: Arc<dyn Session>) {
        self.sessions.write().unwrap().insert(id.to_string(), session);
    }

    /// 创建本地终端（按 shellId 解析，空 / default 走平台默认）
    pub fn create_local(
        &self,
        app: &AppHandle,
        cols: u16,
        rows: u16,
        shell_id: Option<&str>,
    ) -> AppResult<SessionInfo> {
        let shell = crate::services::shells::resolve_local_shell(shell_id);
        self.spawn_local(app, cols, rows, shell, None, None)
    }

    /// 按「本地主机」配置启动会话（保存的 shell 环境 + 启动后自动执行命令）
    pub fn create_local_host(
        &self,
        app: &AppHandle,
        profile: &SshProfile,
        cols: u16,
        rows: u16,
    ) -> AppResult<SessionInfo> {
        let command = profile.command.as_deref().unwrap_or("").trim().to_string();
        if command.is_empty() {
            crate::bail_msg!("本地终端未配置启动环境");
        }
        let shell = crate::services::shells::ResolvedShell {
            command,
            args: profile.args.clone(),
            title: if profile.name.is_empty() {
                profile.command.clone().unwrap_or_default()
            } else {
                profile.name.clone()
            },
        };
        let auto_command = profile.auto_command.clone();
        self.spawn_local(
            app,
            cols,
            rows,
            shell,
            Some(profile.id.clone()),
            auto_command,
        )
    }

    fn spawn_local(
        &self,
        app: &AppHandle,
        cols: u16,
        rows: u16,
        shell: crate::services::shells::ResolvedShell,
        profile_id: Option<String>,
        auto_command: Option<String>,
    ) -> AppResult<SessionInfo> {
        let id = uuid::Uuid::new_v4().to_string();
        let session = LocalSession::new(app, id.clone(), cols, rows, shell, profile_id, auto_command)?;
        let info = session.info();
        self.attach(&id, Arc::new(session));
        Ok(info)
    }

    /// 创建 SSH 会话（连接过程在后台任务中进行，进度经 `terminal:status` 上报）
    pub fn create_ssh(
        &self,
        app: &AppHandle,
        profile: &SshProfile,
        cols: u16,
        rows: u16,
    ) -> AppResult<SessionInfo> {
        let id = uuid::Uuid::new_v4().to_string();
        let session = SshSession::new(app, id.clone(), profile, cols, rows);
        let info = session.info();
        self.attach(&id, Arc::new(session));
        Ok(info)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> bool {
        match self.get(id) {
            Some(session) => session.write(data).is_ok(),
            None => false,
        }
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if let Some(session) = self.get(id) {
            session.resize(cols, rows);
        }
    }

    pub fn kill(&self, app: &AppHandle, id: &str) {
        let removed = self.sessions.write().unwrap().remove(id);
        if let Some(session) = removed {
            session.kill();
            events::broadcast(
                app,
                events::TERMINAL_CLOSED,
                ClosedPayload {
                    session_id: id.to_string(),
                },
            );
        }
    }

    pub fn recent_output(&self, id: &str, max_chars: usize) -> Option<String> {
        self.get(id).map(|s| s.recent_output(max_chars))
    }

    /// 输出缓冲长度（无该会话时返回 0）
    pub fn output_len(&self, id: &str) -> usize {
        self.get(id).map_or(0, |s| s.output_len())
    }

    /// 读取某会话自 `start` 偏移起的新增输出
    pub fn output_from(&self, id: &str, start: usize) -> Option<String> {
        self.get(id).map(|s| s.output_from(start))
    }

    /// 等待会话就绪后写入（SSH 握手 / shell 建立需要时间，未就绪时写入会被丢弃）
    pub async fn write_when_ready(&self, id: &str, data: &str, timeout_ms: u64) -> bool {
        let deadline = now_ms() + timeout_ms;
        while now_ms() < deadline {
            match self.get(id) {
                None => return false,
                Some(session) => {
                    if session.info().exited {
                        return false;
                    }
                    if session.is_ready() {
                        return session.write(data.as_bytes()).is_ok();
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        false
    }
}

/// 按 id 取主机配置（密钥字段已解密，仅主进程内部使用）
pub fn profile_for_session(
    storage: &crate::storage::Storage,
    profile_id: &str,
) -> AppResult<SshProfile> {
    storage
        .get_ssh_profile(profile_id)
        .ok_or_else(|| AppError::msg("主机配置不存在"))
}

pub(crate) fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
