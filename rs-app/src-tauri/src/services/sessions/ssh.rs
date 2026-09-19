//! SSH 远程会话（russh）。
//!
//! russh 是异步 API，而 `Session` trait 是同步的：会话对象通过无界通道把
//! 写入 / 调整尺寸 / 关闭命令投递给后台任务，由后台任务独占 SSH 通道。
//! 连接过程按 resolving → handshake → authenticating → opening-shell → ready
//! 分阶段上报，渲染端据此显示 4 步连接进度。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use async_trait::async_trait;
use russh::client::{self, Handle};
use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{Channel, ChannelMsg, Disconnect};
use tauri::AppHandle;
use tokio::sync::{mpsc, oneshot};

use crate::error::{AppError, AppResult};
use crate::events;
use crate::models::{SessionInfo, SshConnectProgress, SshProfile};

use super::local::append_output;
use super::manager::{now_ms, DataPayload, ExitPayload, Session, TERM_TYPE};

/// TCP 连接超时
const TCP_TIMEOUT: Duration = Duration::from_secs(20);
/// SSH 协议握手（密钥交换）超时
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
/// 握手阶段失败时的最大尝试次数（覆盖并发连接被服务端短暂丢弃等瞬时故障）
const MAX_CONNECT_ATTEMPTS: u32 = 3;
/// 重试退避基数：600ms * attempt
const RETRY_BACKOFF_MS: u64 = 600;
/// keepalive 默认间隔
const DEFAULT_KEEPALIVE_MS: u64 = 15_000;

/// 与原 ssh2 实现一致：不校验 known_hosts，接受任何服务端公钥
struct SshHandler;

impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

enum SshCommand {
    Write(Vec<u8>),
    Resize(u16, u16),
    Kill,
    /// 在独立 exec 通道执行一次性命令（监控采集），结果经 oneshot 回传
    Exec {
        command: String,
        reply: oneshot::Sender<AppResult<String>>,
    },
}

pub struct SshSession {
    info: Arc<Mutex<SessionInfo>>,
    ready: Arc<AtomicBool>,
    killed: Arc<AtomicBool>,
    output: Arc<Mutex<Vec<u8>>>,
    /// 目标 PTY 尺寸：shell 流建立前收到的 resize 先缓存，建立后补应用
    desired: Arc<Mutex<(u16, u16)>>,
    tx: mpsc::UnboundedSender<SshCommand>,
}

impl SshSession {
    pub fn new(app: &AppHandle, id: String, profile: &SshProfile, cols: u16, rows: u16) -> Self {
        let info = Arc::new(Mutex::new(SessionInfo {
            r#type: "ssh".into(),
            id: id.clone(),
            title: format!("{}@{}", profile.username, profile.host),
            profile_id: Some(profile.id.clone()),
            pid: None,
            created_at: now_ms(),
            exited: false,
        }));
        let ready = Arc::new(AtomicBool::new(false));
        let killed = Arc::new(AtomicBool::new(false));
        let output = Arc::new(Mutex::new(Vec::<u8>::new()));
        let desired = Arc::new(Mutex::new((cols.max(2), rows.max(2))));
        let (tx, rx) = mpsc::unbounded_channel();

        let session = Self {
            info: Arc::clone(&info),
            ready: Arc::clone(&ready),
            killed: Arc::clone(&killed),
            output: Arc::clone(&output),
            desired: Arc::clone(&desired),
            tx,
        };

        let app = app.clone();
        let profile = profile.clone();
        tauri::async_runtime::spawn(async move {
            run(app, id, profile, info, ready, killed, output, desired, rx).await;
        });

        session
    }
}

#[async_trait]
impl Session for SshSession {
    fn info(&self) -> SessionInfo {
        self.info.lock().unwrap().clone()
    }

    fn write(&self, data: &[u8]) -> AppResult<()> {
        self.tx
            .send(SshCommand::Write(data.to_vec()))
            .map_err(|_| AppError::msg("会话已关闭"))
    }

    fn resize(&self, cols: u16, rows: u16) {
        let (cols, rows) = (cols.max(2), rows.max(2));
        *self.desired.lock().unwrap() = (cols, rows);
        let _ = self.tx.send(SshCommand::Resize(cols, rows));
    }

    fn kill(&self) {
        self.killed.store(true, Ordering::SeqCst);
        self.ready.store(false, Ordering::SeqCst);
        let _ = self.tx.send(SshCommand::Kill);
    }

    fn recent_output(&self, max_chars: usize) -> String {
        let out = self.output.lock().unwrap();
        let start = out.len().saturating_sub(max_chars);
        String::from_utf8_lossy(&out[start..]).to_string()
    }

    fn output_len(&self) -> usize {
        self.output.lock().unwrap().len()
    }

    fn output_from(&self, start: usize) -> String {
        let out = self.output.lock().unwrap();
        if start >= out.len() {
            return String::new();
        }
        String::from_utf8_lossy(&out[start..]).to_string()
    }

    fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst) && !self.killed.load(Ordering::SeqCst)
    }

    /// 新开一条 exec 通道执行命令（与交互 shell 通道互不影响）
    async fn exec(&self, command: String) -> AppResult<String> {
        if self.killed.load(Ordering::SeqCst) || !self.ready.load(Ordering::SeqCst) {
            crate::bail_msg!("主机未就绪");
        }
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(SshCommand::Exec { command, reply })
            .map_err(|_| AppError::msg("会话已关闭"))?;
        rx.await
            .map_err(|_| AppError::msg("会话已关闭"))?
    }
}

/// 后台任务：连接（含重试）→ 主循环 → 上报退出
#[allow(clippy::too_many_arguments)]
async fn run(
    app: AppHandle,
    id: String,
    profile: SshProfile,
    info: Arc<Mutex<SessionInfo>>,
    ready: Arc<AtomicBool>,
    killed: Arc<AtomicBool>,
    output: Arc<Mutex<Vec<u8>>>,
    desired: Arc<Mutex<(u16, u16)>>,
    mut rx: mpsc::UnboundedReceiver<SshCommand>,
) {
    let mut attempt = 0u32;
    loop {
        if killed.load(Ordering::SeqCst) {
            return;
        }
        attempt += 1;
        if attempt == 1 {
            emit_status(&app, &id, "resolving", None);
        } else {
            emit_status(&app, &id, "retrying", Some((attempt, MAX_CONNECT_ATTEMPTS)));
        }

        // 连接期间也要消费命令：resize 需缓存（握手后补应用），kill 需立即中断
        let connect = connect_session(&app, &id, &profile, &desired);
        tokio::pin!(connect);
        let outcome = loop {
            tokio::select! {
                result = &mut connect => break result,
                cmd = rx.recv() => match cmd {
                    None | Some(SshCommand::Kill) => return,
                    Some(SshCommand::Resize(cols, rows)) => {
                        *desired.lock().unwrap() = (cols.max(2), rows.max(2));
                    }
                    // shell 尚未建立：与原实现一致，丢弃输入
                    Some(SshCommand::Write(_)) => {}
                    // shell 尚未建立：采集命令直接失败（监控在 is_ready 后才会调用）
                    Some(SshCommand::Exec { reply, .. }) => {
                        let _ = reply.send(Err(AppError::msg("主机未就绪")));
                    }
                }
            }
        };

        let (handle, mut channel) = match outcome {
            Ok(pair) => pair,
            Err(err) => {
                if killed.load(Ordering::SeqCst) {
                    return;
                }
                if attempt < MAX_CONNECT_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis(
                        RETRY_BACKOFF_MS * u64::from(attempt),
                    ))
                    .await;
                    continue;
                }
                fail(&app, &id, &info, &output, &err.to_string());
                return;
            }
        };

        // shell 流建立后才算就绪：此时写入的输入不会被丢弃（isReady 也用于脚本投递）
        ready.store(true, Ordering::SeqCst);
        emit_status(&app, &id, "ready", None);

        run_channel(&app, &id, &handle, &mut channel, &output, &mut rx).await;

        ready.store(false, Ordering::SeqCst);
        let _ = handle
            .disconnect(Disconnect::ByApplication, "", "English")
            .await;
        if let Ok(mut i) = info.lock() {
            i.exited = true;
        }
        events::broadcast(
            &app,
            events::TERMINAL_EXIT,
            ExitPayload {
                session_id: id.clone(),
                exit_code: 0,
            },
        );
        return;
    }
}

/// 建立连接并打开交互 shell（分阶段上报进度）
async fn connect_session(
    app: &AppHandle,
    session_id: &str,
    profile: &SshProfile,
    desired: &Arc<Mutex<(u16, u16)>>,
) -> AppResult<(Handle<SshHandler>, Channel<client::Msg>)> {
    let host = profile.host.trim().to_string();
    if host.is_empty() {
        crate::bail_msg!("主机地址未配置");
    }
    let port = if profile.port == 0 { 22 } else { profile.port };

    // 1) TCP 连接
    let stream = match tokio::time::timeout(
        TCP_TIMEOUT,
        tokio::net::TcpStream::connect((host.as_str(), port)),
    )
    .await
    {
        Ok(Ok(stream)) => stream,
        Ok(Err(e)) => return Err(AppError::msg(format!("无法连接 {host}:{port}（{e}）"))),
        Err(_) => return Err(AppError::msg(format!("连接 {host}:{port} 超时"))),
    };

    // 2) SSH 协议握手（密钥交换）
    emit_status(app, session_id, "handshake", None);
    let keepalive = profile.keepalive_interval.unwrap_or(DEFAULT_KEEPALIVE_MS).max(1000);
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_millis(keepalive)),
        nodelay: true,
        ..Default::default()
    });
    let mut session = match tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        client::connect_stream(config, stream, SshHandler),
    )
    .await
    {
        Ok(Ok(session)) => session,
        Ok(Err(e)) => return Err(AppError::msg(format!("SSH 握手失败：{e}"))),
        Err(_) => return Err(AppError::msg("SSH 握手超时")),
    };

    // 3) 身份认证
    emit_status(app, session_id, "authenticating", None);
    let user = profile.username.clone();
    let authed = authenticate(&mut session, profile, &user).await?;
    if !authed {
        crate::bail_msg!("认证失败：用户名或凭据不正确（{user}）");
    }

    // 4) 打开 shell 通道
    emit_status(app, session_id, "opening-shell", None);
    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| AppError::msg(format!("打开会话通道失败：{e}")))?;
    let (cols, rows) = *desired.lock().unwrap();
    channel
        .request_pty(false, TERM_TYPE, u32::from(cols), u32::from(rows), 0, 0, &[])
        .await
        .map_err(|e| AppError::msg(format!("申请 PTY 失败：{e}")))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| AppError::msg(format!("打开 shell 失败：{e}")))?;

    Ok((session, channel))
}

/// 密码 / 私钥认证，返回是否通过
async fn authenticate(
    session: &mut Handle<SshHandler>,
    profile: &SshProfile,
    user: &str,
) -> AppResult<bool> {
    let has_key = profile
        .private_key
        .as_deref()
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false);

    if profile.auth_type == "privateKey" && has_key {
        let secret = profile.private_key.as_deref().unwrap_or_default();
        let passphrase = profile
            .passphrase
            .as_deref()
            .filter(|p| !p.is_empty());
        let key = decode_secret_key(secret, passphrase)
            .map_err(|e| AppError::msg(format!("私钥解析失败：{e}")))?;
        // 服务端支持的 RSA 签名算法（非 RSA 密钥时返回 None，无副作用）
        let hash = session.best_supported_rsa_hash().await.ok().flatten().flatten();
        let result = session
            .authenticate_publickey(
                user.to_string(),
                PrivateKeyWithHashAlg::new(Arc::new(key), hash),
            )
            .await
            .map_err(|e| AppError::msg(format!("认证失败：{e}")))?;
        return Ok(result.success());
    }

    let password = profile.password.clone().unwrap_or_default();
    let result = session
        .authenticate_password(user.to_string(), password)
        .await
        .map_err(|e| AppError::msg(format!("认证失败：{e}")))?;
    Ok(result.success())
}

/// shell 建立后的主循环：双向转发数据 / 尺寸 / 关闭 / 采集命令
async fn run_channel(
    app: &AppHandle,
    id: &str,
    handle: &Handle<SshHandler>,
    channel: &mut Channel<client::Msg>,
    output: &Arc<Mutex<Vec<u8>>>,
    rx: &mut mpsc::UnboundedReceiver<SshCommand>,
) {
    loop {
        tokio::select! {
            cmd = rx.recv() => match cmd {
                None => return,
                Some(SshCommand::Kill) => {
                    let _ = channel.eof().await;
                    let _ = channel.close().await;
                    return;
                }
                Some(SshCommand::Write(data)) => {
                    let _ = channel.data_bytes(data).await;
                }
                Some(SshCommand::Resize(cols, rows)) => {
                    let _ = channel
                        .window_change(u32::from(cols), u32::from(rows), 0, 0)
                        .await;
                }
                Some(SshCommand::Exec { command, reply }) => {
                    let result = exec_on_shell(handle, &command).await;
                    let _ = reply.send(result);
                }
            },
            msg = channel.wait() => match msg {
                None => return,
                Some(ChannelMsg::Data { data }) => {
                    let bytes = data.as_ref();
                    append_output(output, bytes);
                    broadcast_data(app, id, bytes);
                }
                // 远端 stderr（ext == 1）也原样送到终端，与原实现一致
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    let bytes = data.as_ref();
                    append_output(output, bytes);
                    broadcast_data(app, id, bytes);
                }
                Some(_) => {}
            },
        }
    }
}

/// 开一条独立 exec 通道执行命令并收齐全量输出（stdout + stderr）
async fn exec_on_shell(
    handle: &Handle<SshHandler>,
    command: &str,
) -> AppResult<String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::msg(format!("打开 exec 通道失败：{e}")))?;
    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| AppError::msg(format!("发送 exec 失败：{e}")))?;

    let mut out = Vec::<u8>::new();
    loop {
        match channel.wait().await {
            None => break,
            Some(ChannelMsg::Data { data }) => out.extend_from_slice(data.as_ref()),
            Some(ChannelMsg::ExtendedData { data, .. }) => out.extend_from_slice(data.as_ref()),
            // exit-status / exit-signal 等在将来可能先于 close 到来，无需处理
            Some(_) => {}
        }
    }
    let _ = channel.close().await;
    Ok(String::from_utf8_lossy(&out).to_string())
}

/// 连接彻底失败：把错误行写进终端并上报退出
fn fail(
    app: &AppHandle,
    id: &str,
    info: &Arc<Mutex<SessionInfo>>,
    output: &Arc<Mutex<Vec<u8>>>,
    message: &str,
) {
    let line = format!("\r\n\x1b[31m[主机连接失败] {message}\x1b[0m\r\n");
    let bytes = line.as_bytes();
    append_output(output, bytes);
    broadcast_data(app, id, bytes);
    if let Ok(mut i) = info.lock() {
        i.exited = true;
    }
    events::broadcast(
        app,
        events::TERMINAL_EXIT,
        ExitPayload {
            session_id: id.to_string(),
            exit_code: 1,
        },
    );
}

fn broadcast_data(app: &AppHandle, id: &str, bytes: &[u8]) {
    events::broadcast(
        app,
        events::TERMINAL_DATA,
        DataPayload {
            session_id: id.to_string(),
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        },
    );
}

fn emit_status(app: &AppHandle, session_id: &str, stage: &str, attempt: Option<(u32, u32)>) {
    events::broadcast(
        app,
        events::TERMINAL_STATUS,
        SshConnectProgress {
            session_id: session_id.to_string(),
            stage: stage.to_string(),
            attempt: attempt.map(|(a, _)| a),
            max_attempts: attempt.map(|(_, m)| m),
        },
    );
}
