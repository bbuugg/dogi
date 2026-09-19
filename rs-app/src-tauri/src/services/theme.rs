//! 主题模式（system / light / dark）到窗口的落地。
//!
//! WebView2 的 `prefers-color-scheme` 由窗口主题决定，渲染层 `initThemeSync`
//! 再据此切换 html 的 `dark` class —— 所以偏好变化必须同步到窗口，
//! 否则渲染层的 `matchMedia` 永远不会收到变化事件（原 Electron 版由
//! `nativeTheme.themeSource` 承担这一步）。

use tauri::{AppHandle, Manager};

/// 把偏好里的主题模式应用到主窗口。
/// `system` / 未知值传 `None`，让窗口跟随系统深浅色。
pub fn apply(app: &AppHandle, mode: &str) {
    let theme = match mode {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    };
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_theme(theme);
    }
}
