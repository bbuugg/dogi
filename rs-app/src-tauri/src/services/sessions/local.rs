//! 本地 PTY 会话（Windows 走 ConPTY）。
//!
//! 输出以原始字节读取后 base64 编码经事件转发，保证 ZMODEM 等二进制协议的字节保真。

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::AppHandle;

use crate::error::{AppError, AppResult};
use crate::events;
use crate::models::SessionInfo;
use crate::services::shells::ResolvedShell;

use super::manager::{DataPayload, ExitPayload, Session, MAX_OUTPUT_BUFFER, TERM_TYPE};

/// 读取线程退出后回收子进程的最长等待时间
const REAP_TIMEOUT_MS: u64 = 3000;

pub struct LocalSession {
    info: Mutex<SessionInfo>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    output: Arc<Mutex<Vec<u8>>>,
}

impl LocalSession {
    pub fn new(
        app: &AppHandle,
        id: String,
        cols: u16,
        rows: u16,
        shell: ResolvedShell,
        profile_id: Option<String>,
        auto_command: Option<String>,
    ) -> AppResult<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.max(2),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::msg(format!("创建 PTY 失败：{e}")))?;

        let mut cmd = CommandBuilder::new(&shell.command);
        if let Some(args) = &shell.args {
            for a in args {
                cmd.arg(a);
            }
        }
        cmd.cwd(home_dir());
        cmd.env("TERM", TERM_TYPE);
        cmd.env("COLORTERM", "truecolor");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::msg(format!("启动 {} 失败：{e}", shell.command)))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::msg(format!("读取 PTY 失败：{e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::msg(format!("写入 PTY 失败：{e}")))?;

        let info = SessionInfo {
            r#type: "local".into(),
            id: id.clone(),
            title: shell.title,
            profile_id,
            pid: child.process_id(),
            created_at: now_ms(),
            exited: false,
        };

        let child = Arc::new(Mutex::new(child));
        let output = Arc::new(Mutex::new(Vec::<u8>::new()));

        // 读取线程：持续转发输出，EOF 后回收子进程并上报退出
        {
            let app = app.clone();
            let sid = id.clone();
            let output = Arc::clone(&output);
            let child = Arc::clone(&child);
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let chunk = &buf[..n];
                            append_output(&output, chunk);
                            events::broadcast(
                                &app,
                                events::TERMINAL_DATA,
                                DataPayload {
                                    session_id: sid.clone(),
                                    data: base64::engine::general_purpose::STANDARD.encode(chunk),
                                },
                            );
                        }
                    }
                }
                reap(&child);
                events::broadcast(
                    &app,
                    events::TERMINAL_EXIT,
                    ExitPayload {
                        session_id: sid,
                        exit_code: 0,
                    },
                );
            });
        }

        let session = Self {
            info: Mutex::new(info),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child,
            output,
        };

        // 终端启动后自动执行命令：PTY 输入带缓冲，spawn 后立即写入不会丢
        if let Some(cmd) = auto_command {
            if !cmd.trim().is_empty() {
                let _ = session.write(format!("{}\r", cmd.trim()).as_bytes());
            }
        }

        Ok(session)
    }
}

impl Session for LocalSession {
    fn info(&self) -> SessionInfo {
        self.info.lock().unwrap().clone()
    }

    fn write(&self, data: &[u8]) -> AppResult<()> {
        let mut w = self.writer.lock().unwrap();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    fn resize(&self, cols: u16, rows: u16) {
        let _ = self.master.lock().unwrap().resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        });
    }

    fn kill(&self) {
        let _ = self.child.lock().unwrap().kill();
    }

    fn recent_output(&self, max_chars: usize) -> String {
        let out = self.output.lock().unwrap();
        let start = out.len().saturating_sub(max_chars);
        String::from_utf8_lossy(&out[start..]).to_string()
    }

    fn is_ready(&self) -> bool {
        !self.info.lock().unwrap().exited
    }
}

/// 追加输出并裁剪到缓冲区上限
pub(crate) fn append_output(buf: &Arc<Mutex<Vec<u8>>>, chunk: &[u8]) {
    let mut out = buf.lock().unwrap();
    out.extend_from_slice(chunk);
    if out.len() > MAX_OUTPUT_BUFFER {
        let cut = out.len() - MAX_OUTPUT_BUFFER;
        out.drain(..cut);
    }
}

/// 回收子进程（有界等待，避免读取线程长期持锁阻塞 kill）
fn reap(child: &Arc<Mutex<Box<dyn Child + Send + Sync>>>) {
    let deadline = now_ms() + REAP_TIMEOUT_MS;
    while now_ms() < deadline {
        {
            let mut c = child.lock().unwrap();
            match c.try_wait() {
                Ok(Some(_)) | Err(_) => return,
                Ok(None) => {}
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
