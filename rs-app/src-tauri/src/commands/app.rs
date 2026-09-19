//! 应用级命令：应用信息、外部链接、原生对话框、ZMODEM 文件传输、监控间隔。

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};
use crate::models::{AppInfo, Preferences, PreferencesPatch};
use crate::state::AppState;

/// 与原 `process.platform` 对齐的取值（win32 / darwin / linux）
pub fn platform_string() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppResult<AppInfo> {
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        // 原 Electron 版用于展示运行时版本；Tauri 版没有对应概念，留空保持字段形状一致
        electron: String::new(),
        node: String::new(),
        platform: platform_string().into(),
    })
}

/// 用系统默认程序打开外部链接，仅放行安全协议（避免任意协议弹窗）。
#[tauri::command]
pub fn app_open_external(app: AppHandle, url: String) -> AppResult<()> {
    let lower = url.to_lowercase();
    let allowed = ["http://", "https://", "mailto:", "file://"]
        .iter()
        .any(|p| lower.starts_with(p));
    if !allowed {
        crate::bail_msg!("不支持的链接协议：{url}");
    }
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(url, None::<&str>)
        .map_err(|e| AppError::msg(e.to_string()))?;
    Ok(())
}

/* ------------------------------ 原生对话框 ------------------------------ */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogOpenResult {
    pub canceled: bool,
    pub file_paths: Vec<String>,
}

/// 兼容 Electron `dialog.showOpenDialog` 的入参形状（properties / filters / title）。
#[tauri::command]
pub fn dialog_open(app: AppHandle, options: Option<serde_json::Value>) -> AppResult<DialogOpenResult> {
    let options = options.unwrap_or(serde_json::Value::Null);
    let title = options
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("选择")
        .to_string();
    let properties: Vec<String> = options
        .get("properties")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let wants_dir = properties.iter().any(|p| p == "openDirectory");
    let wants_file = properties.iter().any(|p| p == "openFile") || !wants_dir;

    let mut builder = app.dialog().file().set_title(title);
    if let Some(filters) = options.get("filters").and_then(|v| v.as_array()) {
        for f in filters {
            let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("文件");
            let exts: Vec<String> = f
                .get("extensions")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
            builder = builder.add_filter(name, &refs);
        }
    }

    let picked = if wants_dir && wants_file {
        // 同时允许文件与目录：优先按文件选择（Tauri 单次对话框只能二选一）
        builder.blocking_pick_files()
    } else if wants_dir {
        builder.blocking_pick_folder().map(|p| vec![p])
    } else {
        builder.blocking_pick_files()
    };

    let file_paths = picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    Ok(DialogOpenResult {
        canceled: file_paths.is_empty(),
        file_paths,
    })
}

/* -------------------------------- ZMODEM -------------------------------- */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub name: String,
    pub size: u64,
    /// 前端适配层负责 base64 → Uint8Array（Tauri IPC 不支持直接传二进制）
    pub data_base64: String,
}

#[tauri::command]
pub fn zmodem_pick_files(app: AppHandle) -> AppResult<Vec<PickedFile>> {
    let picked = app
        .dialog()
        .file()
        .set_title("选择要上传的文件")
        .blocking_pick_files()
        .unwrap_or_default();

    let mut out = Vec::new();
    for fp in picked {
        let path = fp.into_path().map_err(|e| AppError::msg(e.to_string()))?;
        let bytes = std::fs::read(&path)?;
        out.push(PickedFile {
            name: path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".into()),
            size: bytes.len() as u64,
            data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn zmodem_ask_save_path(app: AppHandle, default_name: String) -> AppResult<Option<String>> {
    let picked = app
        .dialog()
        .file()
        .set_title("保存文件")
        .set_file_name(&default_name)
        .blocking_save_file();
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn zmodem_save_file_to(
    file_path: String,
    data_base64: String,
) -> AppResult<Option<String>> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| AppError::msg(format!("数据解码失败：{e}")))?;
    match std::fs::write(&file_path, bytes) {
        Ok(()) => Ok(Some(file_path)),
        Err(_) => Ok(None),
    }
}

/* -------------------------------- 监控 --------------------------------- */

#[tauri::command]
pub fn monitor_set_interval(state: State<'_, AppState>, ms: u64) -> AppResult<Preferences> {
    // 归一化后立即作用于正在采集的会话，并持久化供下次启动沿用
    state.monitor.set_interval(ms);
    Ok(state.storage.save_preferences(PreferencesPatch {
        monitor_interval: Some(state.monitor.interval_ms()),
        ..Default::default()
    }))
}
