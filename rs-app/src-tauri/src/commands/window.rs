//! 窗口控制命令：最小化 / 最大化切换 / 关闭 / 状态查询。

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

fn main_win(app: &AppHandle) -> AppResult<tauri::WebviewWindow> {
    app.get_webview_window("main")
        .ok_or_else(|| AppError::msg("主窗口不存在"))
}

#[tauri::command]
pub fn window_minimize(app: AppHandle) -> AppResult<()> {
    main_win(&app)?.minimize().map_err(AppError::from)
}

#[tauri::command]
pub fn window_toggle_maximize(app: AppHandle) -> AppResult<()> {
    let win = main_win(&app)?;
    if win.is_maximized()? {
        win.unmaximize()?;
    } else {
        win.maximize()?;
    }
    Ok(())
}

#[tauri::command]
pub fn window_close(app: AppHandle) -> AppResult<()> {
    // 由主进程配置决定是隐藏到托盘还是真正退出
    main_win(&app)?.close().map_err(AppError::from)
}

#[tauri::command]
pub fn window_is_maximized(app: AppHandle) -> AppResult<bool> {
    main_win(&app)?.is_maximized().map_err(AppError::from)
}