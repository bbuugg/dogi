//! 与前端 `@shared/types` 一一对应的数据模型。
//!
//! 所有结构体统一 `rename_all = "camelCase"`，保证序列化后的 JSON 形状与
//! 原 Electron 版 preload/IPC 完全一致（渲染层无需为字段名做任何适配）。

use serde::{Deserialize, Deserializer, Serialize};

/// 反序列化「未传 / null / 有值」三态：缺失 => None，null => Some(None)，有值 => Some(Some(v))。
/// 用于分组颜色这类「不传=保留原值，null=清除」的语义。
fn double_option<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(de).map(Some)
}

/* ------------------------------- 偏好设置 ------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    /// system | light | dark
    pub theme: String,
    pub color_theme: String,
    pub custom_color: String,
    pub terminal_theme: String,
    pub copy_on_select: bool,
    pub right_click_paste: bool,
    pub command_prediction: bool,
    pub terminal_font_size: f64,
    pub local_shell: String,
    pub minimize_to_tray: bool,
    pub monitor_interval: u64,
}

impl Default for Preferences {
    fn default() -> Self {
        // 与渲染层 store 的初始值保持一致
        Self {
            theme: "system".into(),
            color_theme: "neutral".into(),
            custom_color: "#3b82f6".into(),
            terminal_theme: "auto".into(),
            copy_on_select: true,
            right_click_paste: true,
            command_prediction: true,
            terminal_font_size: 13.0,
            local_shell: "default".into(),
            minimize_to_tray: true,
            monitor_interval: 2000,
        }
    }
}

/// 偏好补丁：只覆盖显式传入的字段
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PreferencesPatch {
    pub theme: Option<String>,
    pub color_theme: Option<String>,
    pub custom_color: Option<String>,
    pub terminal_theme: Option<String>,
    pub copy_on_select: Option<bool>,
    pub right_click_paste: Option<bool>,
    pub command_prediction: Option<bool>,
    pub terminal_font_size: Option<f64>,
    pub local_shell: Option<String>,
    pub minimize_to_tray: Option<bool>,
    pub monitor_interval: Option<u64>,
}

impl Preferences {
    pub fn apply(&mut self, patch: PreferencesPatch) {
        macro_rules! set {
            ($field:ident) => {
                if let Some(v) = patch.$field {
                    self.$field = v;
                }
            };
        }
        set!(theme);
        set!(color_theme);
        set!(custom_color);
        set!(terminal_theme);
        set!(copy_on_select);
        set!(right_click_paste);
        set!(command_prediction);
        set!(terminal_font_size);
        set!(local_shell);
        set!(minimize_to_tray);
        set!(monitor_interval);
    }
}

/* ------------------------------- 本地 shell ------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellDetectResult {
    pub shells: Vec<ShellProfile>,
    pub default_id: String,
}

/* -------------------------------- 会话 --------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// local | ssh
    pub r#type: String,
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub created_at: u64,
    pub exited: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectProgress {
    pub session_id: String,
    /// resolving | handshake | authenticating | opening-shell | retrying | ready
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<u32>,
}

/* ------------------------------- 主机配置 ------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshGroup {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub created_at: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshGroupInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    /// 不传 = 保留原色；null = 清除颜色
    #[serde(default, deserialize_with = "double_option")]
    pub color: Option<Option<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProfile {
    pub id: String,
    /// ssh | local
    #[serde(default)]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    /// password | privateKey
    #[serde(default)]
    pub auth_type: String,
    /// 仅用于传输：落库前加密，列表接口不返回
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
    /// 脱敏展示标记（只出参，不落库）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_password: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_private_key: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_passphrase: Option<bool>,
    /// 仅 local：启动环境
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// 仅 local：终端启动后自动执行的命令
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keepalive_interval: Option<u64>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

fn default_port() -> u16 {
    22
}

/* --------------------------- 脚本 / 笔记 / 快捷键 -------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutConfig {
    pub action: String,
    pub accelerator: String,
}

/// 缺省快捷键（与渲染层 `@shared/shortcuts.ts` 的 DEFAULT_SHORTCUTS 对齐）
pub fn default_shortcuts() -> Vec<ShortcutConfig> {
    [
        ("new-session", "CommandOrControl+Alt+T"),
        ("open-command-palette", "CommandOrControl+Shift+P"),
        ("open-settings", "CommandOrControl+Alt+S"),
        ("open-scripts", "CommandOrControl+Alt+K"),
        ("toggle-ai-panel", ""),
    ]
    .into_iter()
    .map(|(action, accelerator)| ShortcutConfig {
        action: action.into(),
        accelerator: accelerator.into(),
    })
    .collect()
}

/* --------------------------------- AI --------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_api_key: Option<bool>,
    /// 注意：渲染层字段名是 `baseURL`（大写 URL），不能走 camelCase 自动推导
    #[serde(default, rename = "baseURL", skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default)]
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_messages: Option<u32>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_config_id: Option<String>,
    /// full | confirm
    #[serde(default)]
    pub permission_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
}

impl AiSettings {
    pub fn with_defaults(mut self) -> Self {
        if self.permission_mode.is_empty() {
            self.permission_mode = "full".into();
        }
        self
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettingsPatch {
    /// 不传 = 保留；null = 清空激活模型
    #[serde(deserialize_with = "double_option")]
    pub active_config_id: Option<Option<String>>,
    pub permission_mode: Option<String>,
    pub system_prompt: Option<String>,
}

/// 单条 AI 对话消息（渲染层 history 原样回传，仅取文本与工具摘要喂给模型）
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessage {
    #[serde(default)]
    pub id: String,
    /// user | assistant
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub parts: Vec<AiMessagePart>,
    #[serde(default)]
    pub created_at: u64,
}

/// 消息片段：与渲染层 `AiMessagePart` 的标签值一一对应
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum AiMessagePart {
    Text {
        #[serde(default)]
        text: String,
    },
    ToolCall {
        tool_call_id: String,
        tool_name: String,
        #[serde(default)]
        input: serde_json::Value,
    },
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        #[serde(default)]
        output: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
}

/// 发起 AI 对话：history 为完整对话历史，targetSessionId 为本段对话绑定的终端会话
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRequest {
    #[serde(default)]
    pub history: Vec<AiChatMessage>,
    #[serde(default)]
    pub target_session_id: Option<String>,
}

/// `ai_chat` 的立即返回值：流式事件随后经 `ai:chat-event` 广播
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatStarted {
    pub request_id: String,
}

/// 流式事件：序列化后的 JSON 形状必须与渲染层 `AiStreamEvent` 完全一致
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum AiStreamEvent {
    TextDelta {
        delta: String,
    },
    ToolCall {
        tool_call_id: String,
        tool_name: String,
        input: serde_json::Value,
    },
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        output: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
    Finish {
        finish_reason: String,
    },
    Error {
        message: String,
    },
}

/// 确认模式下推给渲染层的命令执行请示
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfirmRequest {
    pub id: String,
    pub request_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_title: Option<String>,
}

/* -------------------------------- MCP --------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default)]
    pub enabled: bool,
}

/// 单个 MCP 工具的展示信息（设置页 / 工具列表）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub server_name: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// MCP 工具汇总：成功列出的工具 + 各 server 的连接/列举错误
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolsResult {
    pub tools: Vec<McpToolInfo>,
    pub errors: Vec<String>,
}

/* ------------------------------ 服务器监控 ------------------------------ */

/// 单个挂载点的磁盘占用（`df -P -B1` 解析结果）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub mount: String,
    pub used: u64,
    pub total: u64,
    /// 使用率（0-100 整数）
    pub percent: u32,
}

/// 服务器监控指标：由主进程周期性地经独立 exec 通道采集 /proc 与 df 解析得到。
/// 流量为每秒速率（字节/秒），首次采样时 CPU 使用率暂为 null。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerMetrics {
    /// 首次采样无前值，无法计算增量，为 null
    pub cpu_percent: Option<f64>,
    pub cores: u64,
    pub mem_total: u64,
    pub mem_used: u64,
    pub mem_percent: f64,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub net_rx_rate: f64,
    pub net_tx_rate: f64,
    pub disk: Vec<DiskUsage>,
    /// 系统运行时长（秒）
    pub uptime: f64,
    /// 采集时间戳（毫秒）
    pub timestamp: u64,
}

/* ------------------------------ 应用信息 ------------------------------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    /// 原 Electron 版是 electron 版本号；Tauri 版留空以保持字段形状一致
    pub electron: String,
    pub node: String,
    pub platform: String,
}

/// 供 `ssh:arrange` 使用的重排入参
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrangePayload {
    pub group_ids: Vec<String>,
    pub profiles: Vec<ArrangeProfile>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrangeProfile {
    pub id: String,
    #[serde(default)]
    pub group_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrangeResult {
    pub groups: Vec<SshGroup>,
    pub profiles: Vec<SshProfile>,
}
