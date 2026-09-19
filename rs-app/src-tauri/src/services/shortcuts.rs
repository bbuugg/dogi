//! 系统级快捷键注册。
//!
//! 存储里的 accelerator 沿用 Electron 风格（`CommandOrControl+Alt+T`），
//! `global_hotkey` 的 `Shortcut` 解析器原生支持该写法，可直接使用。

use std::str::FromStr;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::events::APP_SHORTCUT;
use crate::models::ShortcutConfig;

/// 当前已注册的快捷键，便于整体注销（重注册 / 录制模式）
static REGISTERED: Mutex<Vec<Shortcut>> = Mutex::new(Vec::new());

/// 按配置重新注册全部系统级快捷键（先注销再注册）。
/// 解析失败或注册失败的条目静默跳过，不影响其它快捷键。
pub fn apply(app: &AppHandle, shortcuts: &[ShortcutConfig]) {
    unregister_all(app);
    let mut registered = Vec::new();
    for item in shortcuts {
        if item.accelerator.trim().is_empty() {
            continue;
        }
        let Ok(shortcut) = Shortcut::from_str(item.accelerator.trim()) else {
            continue;
        };
        let action = item.action.clone();
        let handle = app.clone();
        let ok = app
            .global_shortcut()
            .on_shortcut(shortcut.clone(), move |_app, _sc, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = handle.emit(APP_SHORTCUT, action.clone());
                }
            })
            .is_ok();
        if ok {
            registered.push(shortcut);
        }
    }
    *REGISTERED.lock().unwrap() = registered;
}

/// 注销全部系统级快捷键（录制模式开启时调用，避免抢按键）
pub fn unregister_all(app: &AppHandle) {
    let mut list = REGISTERED.lock().unwrap();
    for shortcut in list.iter() {
        let _ = app.global_shortcut().unregister(shortcut.clone());
    }
    list.clear();
}
