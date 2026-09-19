//! 配置类命令：SSH 主机/分组、脚本、笔记、偏好、快捷键、AI 配置、MCP 配置。
//!
//! 全部为纯存储操作，返回值形状与原 Electron IPC 完全一致。

use tauri::{AppHandle, Manager, State};

use crate::error::AppResult;
use crate::models::*;
use crate::services::shortcuts;
use crate::state::AppState;

/* ------------------------------- 偏好 ------------------------------- */

#[tauri::command]
pub fn prefs_get(state: State<'_, AppState>) -> AppResult<Preferences> {
    Ok(state.storage.get_preferences())
}

#[tauri::command]
pub fn prefs_save(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: PreferencesPatch,
) -> AppResult<Preferences> {
    let prefs = state.storage.save_preferences(patch);
    // 主题模式变化要落到窗口上，渲染层的 prefers-color-scheme 才会跟着变
    crate::services::theme::apply(&app, &prefs.theme);
    Ok(prefs)
}

/* ------------------------------- SSH -------------------------------- */

#[tauri::command]
pub fn ssh_list(state: State<'_, AppState>) -> AppResult<Vec<SshProfile>> {
    Ok(state.storage.list_ssh_profiles())
}

#[tauri::command]
pub fn ssh_save(state: State<'_, AppState>, profile: SshProfile) -> AppResult<Vec<SshProfile>> {
    Ok(state.storage.save_ssh_profile(profile))
}

#[tauri::command]
pub fn ssh_delete(state: State<'_, AppState>, id: String) -> AppResult<Vec<SshProfile>> {
    Ok(state.storage.delete_ssh_profile(&id))
}

#[tauri::command]
pub fn ssh_arrange(state: State<'_, AppState>, payload: ArrangePayload) -> AppResult<ArrangeResult> {
    Ok(state.storage.arrange_ssh(payload))
}

#[tauri::command]
pub fn ssh_groups_list(state: State<'_, AppState>) -> AppResult<Vec<SshGroup>> {
    Ok(state.storage.list_ssh_groups())
}

#[tauri::command]
pub fn ssh_groups_save(state: State<'_, AppState>, input: SshGroupInput) -> AppResult<Vec<SshGroup>> {
    Ok(state.storage.save_ssh_group(input))
}

#[tauri::command]
pub fn ssh_groups_delete(
    state: State<'_, AppState>,
    id: String,
    delete_profiles: Option<bool>,
) -> AppResult<Vec<SshGroup>> {
    Ok(state.storage.delete_ssh_group(&id, delete_profiles.unwrap_or(false)))
}

/* ------------------------------- 脚本 -------------------------------- */

#[tauri::command]
pub fn scripts_list(state: State<'_, AppState>) -> AppResult<Vec<ScriptEntry>> {
    Ok(state.storage.list_scripts())
}

#[tauri::command]
pub fn scripts_save(state: State<'_, AppState>, entry: ScriptEntry) -> AppResult<Vec<ScriptEntry>> {
    Ok(state.storage.save_script(entry))
}

#[tauri::command]
pub fn scripts_delete(state: State<'_, AppState>, id: String) -> AppResult<Vec<ScriptEntry>> {
    Ok(state.storage.delete_script(&id))
}

/* ------------------------------- 笔记 -------------------------------- */

#[tauri::command]
pub fn notes_list(state: State<'_, AppState>) -> AppResult<Vec<NoteEntry>> {
    Ok(state.storage.list_notes())
}

#[tauri::command]
pub fn notes_save(state: State<'_, AppState>, note: NoteEntry) -> AppResult<Vec<NoteEntry>> {
    Ok(state.storage.save_note(note))
}

#[tauri::command]
pub fn notes_delete(state: State<'_, AppState>, id: String) -> AppResult<Vec<NoteEntry>> {
    Ok(state.storage.delete_note(&id))
}

/* ------------------------------ 快捷键 ------------------------------- */

#[tauri::command]
pub fn shortcuts_get(state: State<'_, AppState>) -> AppResult<Vec<ShortcutConfig>> {
    Ok(state.storage.get_shortcuts())
}

/// 保存并返回合并缺省后的完整清单；系统级快捷键重注册由 `window` 命令层负责。
#[tauri::command]
pub fn shortcuts_save(
    state: State<'_, AppState>,
    app: AppHandle,
    shortcuts: Vec<ShortcutConfig>,
) -> AppResult<Vec<ShortcutConfig>> {
    let next = state.storage.save_shortcuts(shortcuts);
    shortcuts::apply(&app, &next);
    Ok(next)
}

/// 录制模式开关：开启时注销全部系统级快捷键，关闭时按存储重新注册。
#[tauri::command]
pub fn shortcuts_capture(app: AppHandle, enabled: bool) -> AppResult<()> {
    if enabled {
        shortcuts::unregister_all(&app);
    } else {
        let stored = shortcuts_registered_get(&app);
        shortcuts::apply(&app, &stored);
    }
    Ok(())
}

/// 从 Tauri 状态取当前快捷键（供 capture 关闭时重注册）
fn shortcuts_registered_get(app: &AppHandle) -> Vec<ShortcutConfig> {
    app.state::<AppState>().storage.get_shortcuts()
}

/* ------------------------------- AI --------------------------------- */

#[tauri::command]
pub fn ai_config_list(state: State<'_, AppState>) -> AppResult<Vec<AiModelConfig>> {
    Ok(state.storage.list_ai_configs())
}

#[tauri::command]
pub fn ai_config_save(
    state: State<'_, AppState>,
    config: AiModelConfig,
) -> AppResult<Vec<AiModelConfig>> {
    Ok(state.storage.save_ai_config(config))
}

#[tauri::command]
pub fn ai_config_delete(state: State<'_, AppState>, id: String) -> AppResult<Vec<AiModelConfig>> {
    Ok(state.storage.delete_ai_config(&id))
}

#[tauri::command]
pub fn ai_settings_get(state: State<'_, AppState>) -> AppResult<AiSettings> {
    Ok(state.storage.get_ai_settings())
}

#[tauri::command]
pub fn ai_settings_save(
    state: State<'_, AppState>,
    settings: AiSettingsPatch,
) -> AppResult<AiSettings> {
    Ok(state.storage.save_ai_settings_patch(settings))
}

/* ------------------------------- MCP -------------------------------- */

#[tauri::command]
pub fn mcp_list(state: State<'_, AppState>) -> AppResult<Vec<McpServerConfig>> {
    Ok(state.storage.list_mcp_servers())
}

#[tauri::command]
pub fn mcp_save(
    state: State<'_, AppState>,
    server: McpServerConfig,
) -> AppResult<Vec<McpServerConfig>> {
    // 配置变更后旧连接失效，下次对话按新配置重建
    state.mcp.invalidate(Some(&server.id));
    Ok(state.storage.save_mcp_server(server))
}

#[tauri::command]
pub fn mcp_delete(state: State<'_, AppState>, id: String) -> AppResult<Vec<McpServerConfig>> {
    state.mcp.invalidate(Some(&id));
    Ok(state.storage.delete_mcp_server(&id))
}
