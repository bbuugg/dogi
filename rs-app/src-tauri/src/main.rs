// 发布构建不弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod error;
mod events;
mod models;
mod services;
mod state;
mod storage;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

use crate::state::AppState;

/// 显示并聚焦主窗口（托盘 / 二次启动共用）
fn focus_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 托盘：左键切换显隐，菜单提供「显示主窗口 / 退出」
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("OpsDesk")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => focus_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                match app.get_webview_window("main") {
                    Some(win) if win.is_visible().unwrap_or(false) => {
                        let _ = win.hide();
                    }
                    _ => focus_main(app),
                }
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // 单实例：二次启动时把已有窗口拉到前台
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();

            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let storage = storage::Storage::open(dir)?;

            // 按持久化的偏好设置主题（在窗口显示前生效，避免闪烁）
            let theme = storage.get_preferences().theme;
            services::theme::apply(&handle, &theme);

            let shortcuts = storage.get_shortcuts();
            app.manage(AppState::new(storage));

            build_tray(&handle)?;
            services::shortcuts::apply(&handle, &shortcuts);

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::Resized(_) => {
                    let maximized = window.is_maximized().unwrap_or(false);
                    let _ = window.emit(events::WINDOW_MAXIMIZED, maximized);
                }
                WindowEvent::CloseRequested { api, .. } => {
                    let app = window.app_handle();
                    let minimize_to_tray = app
                        .state::<AppState>()
                        .storage
                        .get_preferences()
                        .minimize_to_tray;
                    if minimize_to_tray {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            // 配置
            commands::config::prefs_get,
            commands::config::prefs_save,
            commands::config::ssh_list,
            commands::config::ssh_save,
            commands::config::ssh_delete,
            commands::config::ssh_arrange,
            commands::config::ssh_groups_list,
            commands::config::ssh_groups_save,
            commands::config::ssh_groups_delete,
            commands::config::scripts_list,
            commands::config::scripts_save,
            commands::config::scripts_delete,
            commands::config::notes_list,
            commands::config::notes_save,
            commands::config::notes_delete,
            commands::config::shortcuts_get,
            commands::config::shortcuts_save,
            commands::config::shortcuts_capture,
            commands::config::ai_config_list,
            commands::config::ai_config_save,
            commands::config::ai_config_delete,
            commands::config::ai_settings_get,
            commands::config::ai_settings_save,
            commands::config::mcp_list,
            commands::config::mcp_save,
            commands::config::mcp_delete,
            // AI 对话 / MCP 工具
            commands::ai::ai_chat,
            commands::ai::ai_abort,
            commands::ai::ai_confirm_resolve,
            commands::ai::mcp_list_tools,
            // 应用
            commands::app::app_info,
            commands::app::app_open_external,
            commands::app::dialog_open,
            commands::app::zmodem_pick_files,
            commands::app::zmodem_ask_save_path,
            commands::app::zmodem_save_file_to,
            commands::app::monitor_set_interval,
            // 窗口
            commands::window::window_minimize,
            commands::window::window_toggle_maximize,
            commands::window::window_close,
            commands::window::window_is_maximized,
            // 终端
            commands::terminal::terminal_list,
            commands::terminal::terminal_list_shells,
            commands::terminal::terminal_create_local,
            commands::terminal::terminal_create_from_profile,
            commands::terminal::terminal_create_ssh,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_kill,
            commands::terminal::terminal_recent_output,
            commands::terminal::terminal_run_script,
        ])
        .run(tauri::generate_context!())
        .expect("启动 OpsDesk 失败");
}
