//! 终端会话命令：列表 / 创建 / 写入 / 尺寸 / 关闭 / 输出回放 / 就绪后投递脚本。

use base64::Engine;
use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use crate::models::{SessionInfo, ShellDetectResult};
use crate::services::sessions::manager::profile_for_session;
use crate::state::AppState;

#[tauri::command]
pub fn terminal_list(state: State<'_, AppState>) -> AppResult<Vec<SessionInfo>> {
    Ok(state.sessions.list())
}

#[tauri::command]
pub fn terminal_list_shells() -> AppResult<ShellDetectResult> {
    Ok(crate::services::shells::detect_shells())
}

#[tauri::command]
pub fn terminal_create_local(
    app: AppHandle,
    state: State<'_, AppState>,
    cols: Option<u16>,
    rows: Option<u16>,
    shell_id: Option<String>,
) -> AppResult<SessionInfo> {
    state.sessions.create_local(
        &app,
        cols.unwrap_or(80),
        rows.unwrap_or(24),
        shell_id.as_deref(),
    )
}

/// 按主机配置创建会话：主进程根据主机类型（ssh/local）决定启动方式
#[tauri::command]
pub fn terminal_create_from_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> AppResult<SessionInfo> {
    let profile = profile_for_session(&state.storage, &profile_id)?;
    let (cols, rows) = (cols.unwrap_or(80), rows.unwrap_or(24));
    if profile.kind == "local" {
        state.sessions.create_local_host(&app, &profile, cols, rows)
    } else {
        state.sessions.create_ssh(&app, &profile, cols, rows)
    }
}

#[tauri::command]
pub fn terminal_create_ssh(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> AppResult<SessionInfo> {
    let profile = profile_for_session(&state.storage, &profile_id)?;
    state
        .sessions
        .create_ssh(&app, &profile, cols.unwrap_or(80), rows.unwrap_or(24))
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, AppState>,
    session_id: String,
    data_base64: String,
) -> AppResult<bool> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| AppError::msg(format!("终端数据解码失败：{e}")))?;
    Ok(state.sessions.write(&session_id, &data))
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    state.sessions.resize(&session_id, cols, rows);
    Ok(())
}

#[tauri::command]
pub fn terminal_kill(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<()> {
    // 会话关闭：销毁其独立的 AI 助手实例（中止进行中的对话与挂起的确认）
    state.ai.dispose_session(&session_id);
    state.sessions.kill(&app, &session_id);
    Ok(())
}

#[tauri::command]
pub fn terminal_recent_output(
    state: State<'_, AppState>,
    session_id: String,
    max_chars: Option<usize>,
) -> AppResult<Option<String>> {
    Ok(state.sessions.recent_output(&session_id, max_chars.unwrap_or(8000)))
}

/// 等待会话就绪后写入内容（连接主机后自动执行脚本）；超时 / 会话不存在返回 false
#[tauri::command]
pub async fn terminal_run_script(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> AppResult<bool> {
    Ok(state.sessions.write_when_ready(&session_id, &data, 20_000).await)
}
