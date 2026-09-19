//! 事件名常量与广播辅助。
//!
//! 事件名与原 Electron 版 IPC 通道名保持完全一致，渲染端订阅无需改动。

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const TERMINAL_DATA: &str = "terminal:data";
pub const TERMINAL_EXIT: &str = "terminal:exit";
pub const TERMINAL_STATUS: &str = "terminal:status";
pub const TERMINAL_CLOSED: &str = "terminal:closed";
pub const WINDOW_MAXIMIZED: &str = "window:maximized";
pub const APP_SHORTCUT: &str = "app:shortcut";
pub const MONITOR_DATA: &str = "monitor:data";
pub const AI_CHAT_EVENT: &str = "ai:chat-event";
pub const AI_CONFIRM: &str = "ai:confirm";
pub const AI_CONFIRM_RESOLVED: &str = "ai:confirm-resolved";

/// 向主窗口广播一个事件（窗口不存在时静默忽略）。
pub fn broadcast<P: Serialize + Clone>(app: &AppHandle, event: &str, payload: P) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit(event, payload);
    }
}
