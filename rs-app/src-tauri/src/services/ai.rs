//! AI 助手：基于 genai（第三方开源 crate）的多 provider 流式对话 + 终端工具 + MCP 工具。
//!
//! 设计要点（与原 Electron 版行为对齐）：
//! - 每个终端会话一个独立的 `AiAssistant` 实例：确认卡串行链、工具执行队列、中止互不影响。
//! - 模型可调用的工具 = 4 个终端工具 + 所有已启用 MCP server 的工具。
//! - 确认模式（confirm）下执行终端命令前先弹卡请示用户，超时 10 分钟按「取消」处理。
//! - 流式事件经 `ai:chat-event` 广播，载荷形状与渲染层 `AiStreamEvent` 完全一致。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::StreamExt;
use genai::adapter::AdapterKind;
use genai::chat::{
    ChatMessage, ChatOptions, ChatRequest, ChatStreamEvent, ChatStreamResponse, StreamEnd, Tool,
    ToolCall, ToolResponse,
};
use genai::resolver::{AuthData, Endpoint};
use genai::{Client, ModelIden, ModelSpec, ServiceTarget};
use regex::Regex;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::{oneshot, watch};

use crate::events;
use crate::models::{
    AiChatMessage, AiChatRequest, AiChatStarted, AiConfirmRequest, AiMessagePart, AiModelConfig,
    AiStreamEvent,
};
use crate::state::AppState;

/// 默认系统提示词（与原 Electron 版逐字一致）
const DEFAULT_SYSTEM_PROMPT: &str = "你是一个专业的运维助手，运行在一个运维终端工具（OpsDesk）中。
你可以操作用户的终端会话：执行命令、读取输出。
执行命令前先简要说明要做什么；优先使用安全、无破坏性的命令。
涉及删除文件、重启服务、修改配置等危险操作时，先简要说明影响再执行。
使用 run_in_terminal 执行命令后，终端原始输出即为事实依据；失败时结合输出排查原因再尝试。
终端命令按队列串行执行：前一条命令执行完毕并读取到输出后，下一条才会开始，不会出现并发冲突。
注意根据会话标题判断操作系统（PowerShell 与 bash 语法不同）。
部分命令会启动交互式 / 前台程序（如 htop、top、vim、nano、less、man、watch、python、node 等），它们占据终端且不返回 shell 提示符。执行这类命令后，不要继续向该会话输入新命令，应先用 send_keys 工具发送退出指令（多数程序用 \"q\"，卡死用 \"C-c\"，个别用 \"exit\" / \"C-d\"），并用 read_terminal_output 确认已回到 shell 提示符后再继续。";

/// 单次对话最多执行的「模型步数」（含工具调用轮次）
const MAX_STEPS: usize = 15;
/// 确认模式下等待用户响应的最长时间，超时按「取消」处理
const CONFIRM_TIMEOUT_MS: u64 = 10 * 60 * 1000;
/// 未绑定会话时的兜底实例 key
const NO_SESSION_KEY: &str = "__no_session__";
/// 事件必须晚于 `ai_chat` 的返回值到达渲染端，否则 requestId 尚未登记会被丢弃
const FIRST_EVENT_DELAY_MS: u64 = 50;

/* ------------------------------ 中止标记 ------------------------------- */

/// 一次对话请求的中止标记：`watch` 通道先改值后通知，避免 abort 早于等待而漏掉
struct AbortFlag {
    tx: watch::Sender<bool>,
}

impl AbortFlag {
    fn new() -> Self {
        let (tx, _rx) = watch::channel(false);
        Self { tx }
    }

    fn abort(&self) {
        let _ = self.tx.send(true);
    }
}

/* ------------------------------ 工具队列 ------------------------------- */

/// 单个对话的工具执行串行链：模型并行发出的多条命令逐条排队执行
struct ToolQueue {
    lock: tokio::sync::Mutex<()>,
    aborted: AtomicBool,
}

impl ToolQueue {
    fn new() -> Self {
        Self {
            lock: tokio::sync::Mutex::new(()),
            aborted: AtomicBool::new(false),
        }
    }
}

/* ---------------------------- 单会话助手实例 ---------------------------- */

/// 单个终端会话的 AI 助手实例：确认串行链与工具执行队列按会话隔离，
/// 各会话的确认卡、命令队列、中止互不影响。
#[derive(Default)]
pub struct AiAssistant {
    /// 确认请求串行锁：同一实例同一时刻只弹一张确认卡
    confirm_lock: tokio::sync::Mutex<()>,
    /// 挂起的确认：id -> (requestId, 结果发送端)
    pending_confirms: Mutex<HashMap<String, (String, oneshot::Sender<bool>)>>,
    /// 各对话的工具执行串行链（key 为 requestId）
    tool_queues: Mutex<HashMap<String, Arc<ToolQueue>>>,
    /// 进行中的请求中止标记（key 为 requestId）
    aborts: Mutex<HashMap<String, Arc<AbortFlag>>>,
}

impl AiAssistant {
    fn register_abort(&self, request_id: &str) -> Arc<AbortFlag> {
        let flag = Arc::new(AbortFlag::new());
        self.aborts
            .lock()
            .unwrap()
            .insert(request_id.to_string(), flag.clone());
        flag
    }

    fn tool_queue(&self, request_id: &str) -> Arc<ToolQueue> {
        let mut queues = self.tool_queues.lock().unwrap();
        queues
            .entry(request_id.to_string())
            .or_insert_with(|| Arc::new(ToolQueue::new()))
            .clone()
    }

    /// 终端工具执行排队：同一对话内串行——前一个工具完成（含确认等待、命令执行、
    /// 输出读取）后，下一个才开始。中止对话时排队中尚未开始的工具直接拒绝。
    /// 注意：`fut` 由调用方先行创建（async fn 未被 poll 前不会执行），
    /// 因此排队期间工具体不会开始运行。
    async fn queue_tool_execution<T>(
        &self,
        request_id: &str,
        fut: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let queue = self.tool_queue(request_id);
        let _guard = queue.lock.lock().await;
        if queue.aborted.load(Ordering::SeqCst) {
            return Err("对话已中止，命令未执行".into());
        }
        fut.await
    }

    /// 弹出确认卡并等待用户应答（超时 / 中止均按「取消」处理）
    async fn request_confirm(&self, app: &AppHandle, req: AiConfirmRequest) -> bool {
        // 串行化：模型可能在同一步并行发出多个工具调用，逐个弹出
        let _guard = self.confirm_lock.lock().await;
        let (tx, rx) = oneshot::channel();
        self.pending_confirms
            .lock()
            .unwrap()
            .insert(req.id.clone(), (req.request_id.clone(), tx));
        events::broadcast(app, events::AI_CONFIRM, req.clone());

        let approved = tokio::select! {
            res = rx => res.unwrap_or(false),
            _ = tokio::time::sleep(Duration::from_millis(CONFIRM_TIMEOUT_MS)) => false,
        };

        self.pending_confirms.lock().unwrap().remove(&req.id);
        events::broadcast(app, events::AI_CONFIRM_RESOLVED, json!({ "id": req.id }));
        approved
    }

    fn resolve_confirm(&self, id: &str, approved: bool) {
        let sender = self
            .pending_confirms
            .lock()
            .unwrap()
            .remove(id)
            .map(|(_, tx)| tx);
        if let Some(tx) = sender {
            let _ = tx.send(approved);
        }
    }

    /// 结束挂起的确认（中止对话 / 请求收尾），按「取消」处理
    fn clear_pending_confirms(&self, request_id: Option<&str>) {
        let senders: Vec<oneshot::Sender<bool>> = {
            let mut pending = self.pending_confirms.lock().unwrap();
            let ids: Vec<String> = pending
                .iter()
                .filter(|(_, (rid, _))| request_id.map_or(true, |r| r == rid))
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| pending.remove(&id).map(|(_, tx)| tx))
                .collect()
        };
        for tx in senders {
            let _ = tx.send(false);
        }
    }

    /// 中止某次对话：未执行的排队工具直接拒绝，挂起的确认释放，流式请求取消
    fn abort_request(&self, request_id: &str) {
        if let Some(queue) = self.tool_queues.lock().unwrap().get(request_id) {
            queue.aborted.store(true, Ordering::SeqCst);
        }
        self.clear_pending_confirms(Some(request_id));
        if let Some(flag) = self.aborts.lock().unwrap().get(request_id) {
            flag.abort();
        }
    }

    /// 会话关闭时销毁实例：中止一切进行中的请求与挂起的确认
    fn dispose(&self) {
        self.clear_pending_confirms(None);
        let mut queues = self.tool_queues.lock().unwrap();
        for queue in queues.values() {
            queue.aborted.store(true, Ordering::SeqCst);
        }
        queues.clear();
        drop(queues);
        let mut aborts = self.aborts.lock().unwrap();
        for flag in aborts.values() {
            flag.abort();
        }
        aborts.clear();
    }
}

/* ------------------------------ 服务注册中心 ---------------------------- */

/// AI 服务：按终端会话维护独立的助手实例，对命令层统一收口。
#[derive(Default)]
pub struct AiService {
    /// sessionId -> 助手实例（`__no_session__` 为未绑定会话时的共享兜底）
    assistants: Mutex<HashMap<String, Arc<AiAssistant>>>,
}

impl AiService {
    pub fn new() -> Self {
        Self::default()
    }

    fn assistant_for(&self, key: &str) -> Arc<AiAssistant> {
        let mut map = self.assistants.lock().unwrap();
        map.entry(key.to_string())
            .or_insert_with(|| Arc::new(AiAssistant::default()))
            .clone()
    }

    /// 发起一次对话：立即返回 requestId，流式结果经事件广播
    pub fn chat(self: &Arc<Self>, app: &AppHandle, req: AiChatRequest) -> AiChatStarted {
        let key = req
            .target_session_id
            .clone()
            .unwrap_or_else(|| NO_SESSION_KEY.to_string());
        let request_id = uuid::Uuid::new_v4().to_string();
        let app = app.clone();
        let request_id_for_task = request_id.clone();
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            run_chat(service, app, key, request_id_for_task, req).await;
        });
        AiChatStarted { request_id }
    }

    /// 渲染进程回复确认结果：转发给持有该确认的实例
    pub fn resolve_confirm(&self, id: &str, approved: bool) {
        for assistant in self.assistants.lock().unwrap().values() {
            assistant.resolve_confirm(id, approved);
        }
    }

    /// 中止某次对话：只作用于所属实例
    pub fn abort(&self, request_id: &str) {
        for assistant in self.assistants.lock().unwrap().values() {
            assistant.abort_request(request_id);
        }
    }

    /// 会话关闭：销毁其助手实例（中止进行中的对话与挂起的确认）
    pub fn dispose_session(&self, session_id: &str) {
        if let Some(assistant) = self.assistants.lock().unwrap().remove(session_id) {
            assistant.dispose();
        }
    }
}

/* -------------------------------- 对话主流程 ---------------------------- */

async fn run_chat(
    service: Arc<AiService>,
    app: AppHandle,
    key: String,
    request_id: String,
    req: AiChatRequest,
) {
    let assistant = service.assistant_for(&key);
    let abort_flag = assistant.register_abort(&request_id);
    let mut abort_rx = abort_flag.tx.subscribe();

    // 事件必须晚于 `ai_chat` 返回，否则渲染端还没登记 requestId 会丢弃
    tokio::time::sleep(Duration::from_millis(FIRST_EVENT_DELAY_MS)).await;

    let result = stream_conversation(&app, &assistant, &request_id, &req, &mut abort_rx).await;

    match result {
        Ok(reason) => {
            cleanup(&assistant, &request_id);
            emit(&app, &request_id, AiStreamEvent::Finish { finish_reason: reason });
        }
        Err(message) => {
            emit(&app, &request_id, AiStreamEvent::Error { message });
            cleanup(&assistant, &request_id);
            emit(
                &app,
                &request_id,
                AiStreamEvent::Finish {
                    finish_reason: "error".into(),
                },
            );
        }
    }
}

/// 请求收尾：释放挂起的确认、标记队列中止、移除中止标记
fn cleanup(assistant: &AiAssistant, request_id: &str) {
    assistant.clear_pending_confirms(Some(request_id));
    if let Some(queue) = assistant.tool_queues.lock().unwrap().get(request_id) {
        queue.aborted.store(true, Ordering::SeqCst);
    }
    assistant.tool_queues.lock().unwrap().remove(request_id);
    assistant.aborts.lock().unwrap().remove(request_id);
}

async fn stream_conversation(
    app: &AppHandle,
    assistant: &Arc<AiAssistant>,
    request_id: &str,
    req: &AiChatRequest,
    abort_rx: &mut watch::Receiver<bool>,
) -> Result<String, String> {
    let state = app.state::<AppState>();
    let settings = state.storage.get_ai_settings();
    let config = settings
        .active_config_id
        .as_deref()
        .and_then(|id| state.storage.get_ai_config(id));
    let Some(config) = config else {
        return Err("尚未配置 AI 模型，请先在设置中添加模型配置".into());
    };

    let mcp_servers = state.storage.list_mcp_servers();
    let (mcp_tools, mcp_errors) = state.mcp.build_tools(&mcp_servers).await;

    let confirm_mode = settings.permission_mode == "confirm";
    let bound = req.target_session_id.as_deref();
    let bound_title = bound
        .and_then(|id| state.sessions.get(id))
        .map(|s| s.info().title);

    let system_prompt = build_system_prompt(&settings.system_prompt, confirm_mode, bound_title.as_deref(), &mcp_errors);

    let mut tools = terminal_tools();
    for def in &mcp_tools {
        let tool = Tool::new(def.exposed_name.clone()).with_schema(def.schema.clone());
        let tool = match &def.description {
            Some(desc) if !desc.is_empty() => tool.with_description(desc.clone()),
            _ => tool,
        };
        tools.push(tool);
    }

    let limit = config.context_messages.unwrap_or(20).max(1) as usize;
    let mut chat_req = ChatRequest::new(to_model_messages(&req.history, limit))
        .with_system(system_prompt)
        .with_tools(tools);

    let mut options = ChatOptions::default()
        .with_capture_content(true)
        .with_capture_tool_calls(true);
    if let Some(temperature) = config.temperature {
        options = options.with_temperature(temperature);
    }
    if let Some(max_tokens) = config.max_tokens {
        options = options.with_max_tokens(max_tokens);
    }

    let client = build_client(api_key_of(&config));
    let spec = model_spec(&config);

    for _step in 0..MAX_STEPS {
        if *abort_rx.borrow() {
            return Ok("aborted".into());
        }

        let response = tokio::select! {
            _ = abort_rx.changed() => return Ok("aborted".into()),
            res = client.exec_chat_stream(spec.clone(), chat_req.clone(), Some(&options)) => res,
        };
        let ChatStreamResponse { mut stream, .. } = response.map_err(|e| format!("请求失败: {e}"))?;

        let mut end: Option<StreamEnd> = None;
        loop {
            let item = tokio::select! {
                _ = abort_rx.changed() => return Ok("aborted".into()),
                item = stream.next() => item,
            };
            match item {
                None => break,
                Some(Err(e)) => return Err(format!("流式读取失败: {e}")),
                Some(Ok(event)) => match event {
                    ChatStreamEvent::Chunk(chunk) => {
                        if !chunk.content.is_empty() {
                            emit(
                                app,
                                request_id,
                                AiStreamEvent::TextDelta {
                                    delta: chunk.content,
                                },
                            );
                        }
                    }
                    ChatStreamEvent::End(stream_end) => {
                        end = Some(stream_end);
                        break;
                    }
                    _ => {}
                },
            }
        }

        let Some(end) = end else { return Ok("done".into()) };
        let calls: Vec<ToolCall> = end
            .captured_tool_calls()
            .map(|calls| calls.into_iter().cloned().collect())
            .unwrap_or_default();
        if calls.is_empty() {
            return Ok("done".into());
        }

        for (index, call) in calls.iter().enumerate() {
            if *abort_rx.borrow() {
                return Ok("aborted".into());
            }
            emit(
                app,
                request_id,
                AiStreamEvent::ToolCall {
                    tool_call_id: call.call_id.clone(),
                    tool_name: call.fn_name.clone(),
                    input: call.fn_arguments.clone(),
                },
            );

            let (output, is_error) = execute_tool(
                app,
                assistant,
                request_id,
                bound,
                confirm_mode,
                call,
                &mcp_tools,
            )
            .await;

            emit(
                app,
                request_id,
                AiStreamEvent::ToolResult {
                    tool_call_id: call.call_id.clone(),
                    tool_name: call.fn_name.clone(),
                    output: output.clone(),
                    is_error: if is_error { Some(true) } else { None },
                },
            );

            let response = ToolResponse::from_tool_call(call, tool_content(&output));
            chat_req = if index == 0 {
                chat_req.append_tool_use_from_stream_end(&end, response)
            } else {
                chat_req.append_message(response)
            };
        }
    }

    Ok("done".into())
}

/// 组装系统提示词：用户自定义（或默认）+ 模式提示 + 会话绑定提示 + MCP 不可用告警
fn build_system_prompt(
    custom: &Option<String>,
    confirm_mode: bool,
    bound_title: Option<&str>,
    mcp_errors: &[String],
) -> String {
    let mut prompt = custom
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_SYSTEM_PROMPT)
        .to_string();
    if confirm_mode {
        prompt.push_str(
            "\n当前处于「确认模式」：执行任何终端命令都会先请求用户确认，用户可能拒绝。被拒绝时不要反复重试同一条命令，先询问用户的意见。",
        );
    }
    if let Some(title) = bound_title {
        prompt.push_str(&format!(
            "\n本次对话绑定了一个终端会话（{title}）。除非用户明确要求操作其他会话，终端工具一律作用于该会话，不要切换。"
        ));
    }
    if !mcp_errors.is_empty() {
        prompt.push_str(&format!(
            "\n注意，以下 MCP 服务当前不可用：\n{}",
            mcp_errors.join("\n")
        ));
    }
    prompt
}

/* ------------------------------ 工具定义与执行 -------------------------- */

/// 4 个终端操作工具的 JSON Schema 定义
fn terminal_tools() -> Vec<Tool> {
    let session_id_prop = json!({
        "type": "string",
        "description": "目标会话 ID，缺省为本次对话绑定的会话"
    });

    vec![
        Tool::new("list_terminal_sessions")
            .with_description("列出当前打开的所有终端会话（本地终端与 SSH）")
            .with_schema(json!({ "type": "object", "properties": {} })),
        Tool::new("run_in_terminal")
            .with_description(
                "在指定终端会话中执行命令（等同于用户在键盘输入并回车），等待片刻后返回本次命令的新增输出（不含历史内容）。未指定会话时使用本次对话绑定的会话。命令串行执行：前一条完成并读取结果后才开始下一条。返回的输出中如果末尾有 shell 提示符（如 $ 或 # 结尾的行），说明命令已执行完毕、终端可继续输入；如果没有 shell 提示符，说明命令可能仍在运行或启动了交互式/前台程序（如 htop、vim、less、python REPL 等），此时不要继续执行新命令，应先用 send_keys 发送退出指令。",
            )
            .with_schema(json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "要执行的命令，无需附加换行符" },
                    "sessionId": session_id_prop,
                    "waitMs": { "type": "number", "description": "执行后等待毫秒数，默认 3000，长耗时命令可适当增大" }
                },
                "required": ["command"]
            })),
        Tool::new("read_terminal_output")
            .with_description("读取指定终端会话的最近输出（不执行任何命令）")
            .with_schema(json!({
                "type": "object",
                "properties": {
                    "sessionId": session_id_prop,
                    "maxChars": { "type": "number", "description": "最多返回字符数，默认 4000" }
                }
            })),
        Tool::new("send_keys")
            .with_description(
                "向终端发送按键或控制序列（不会自动回车）。主要用于退出交互式 / 前台程序：如发送 \"q\" 退出 htop/less/man，发送 \"C-c\" 发送 Ctrl-C，发送 \"C-d\" 发送 Ctrl-D，发送 \"Escape\" 退出某些程序。普通命令执行前一般不需要此工具。",
            )
            .with_schema(json!({
                "type": "object",
                "properties": {
                    "keys": {
                        "type": "string",
                        "description": "要发送的按键序列。普通字符直接写，如 'q'、'exit'；控制键写法 'C-c'、'C-d'、'C-z'、'Escape'；换行 / 回车用 'Enter' 或 '\\n'。"
                    },
                    "sessionId": session_id_prop
                },
                "required": ["keys"]
            })),
    ]
}

/// 执行一次工具调用，返回（结果值, 是否错误）
async fn execute_tool(
    app: &AppHandle,
    assistant: &Arc<AiAssistant>,
    request_id: &str,
    bound: Option<&str>,
    confirm_mode: bool,
    call: &ToolCall,
    mcp_tools: &[crate::services::mcp::McpToolDef],
) -> (Value, bool) {
    let name = call.fn_name.as_str();
    let input = &call.fn_arguments;

    // 终端工具走串行队列（MCP 调用不占用终端，无需排队）
    if matches!(
        name,
        "list_terminal_sessions" | "run_in_terminal" | "read_terminal_output" | "send_keys"
    ) {
        let fut = run_terminal_tool(
            app,
            assistant,
            request_id,
            bound,
            confirm_mode,
            name,
            input,
            call,
        );
        let result = assistant.queue_tool_execution(request_id, fut).await;
        return match result {
            Ok(value) => (value, false),
            Err(message) => (json!(format!("工具执行失败: {message}")), true),
        };
    }

    match mcp_tools.iter().find(|t| t.exposed_name == name) {
        Some(def) => {
            let state = app.state::<AppState>();
            match state
                .mcp
                .call_tool(&def.server_id, &def.tool_name, input.clone())
                .await
            {
                Ok((text, is_error)) => (json!(text), is_error),
                Err(message) => (json!(format!("工具执行失败: {message}")), true),
            }
        }
        None => (
            json!(format!("工具执行失败: 未知工具 {name}")),
            true,
        ),
    }
}

async fn run_terminal_tool(
    app: &AppHandle,
    assistant: &Arc<AiAssistant>,
    request_id: &str,
    bound: Option<&str>,
    confirm_mode: bool,
    name: &str,
    input: &Value,
    call: &ToolCall,
) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let sessions = &state.sessions;
    let resolve = |key: &str| -> Option<String> {
        input
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| bound.map(|s| s.to_string()))
    };

    match name {
        "list_terminal_sessions" => {
            let sessions = sessions.list();
            Ok(json!({
                "activeSessionId": Value::Null,
                "boundSessionId": bound,
                "sessions": sessions
                    .iter()
                    .map(|s| json!({
                        "sessionId": s.id,
                        "type": s.r#type,
                        "title": s.title,
                        "exited": s.exited,
                    }))
                    .collect::<Vec<_>>(),
            }))
        }
        "read_terminal_output" => {
            let id = resolve("sessionId").ok_or("当前没有打开的终端会话")?;
            let max_chars = input
                .get("maxChars")
                .and_then(|v| v.as_u64())
                .unwrap_or(4000) as usize;
            let output = sessions
                .recent_output(&id, max_chars)
                .ok_or_else(|| format!("会话不存在: {id}"))?;
            Ok(json!(strip_ansi(&output)))
        }
        "send_keys" => {
            let id = resolve("sessionId").ok_or("当前没有打开的终端会话")?;
            let keys = input
                .get("keys")
                .and_then(|v| v.as_str())
                .ok_or("缺少 keys 参数")?;
            if sessions.get(&id).is_none() {
                return Err(format!("会话不存在: {id}"));
            }
            let before = sessions.output_len(&id);
            sessions.write(&id, translate_keys(keys).as_bytes());
            tokio::time::sleep(Duration::from_millis(300)).await;
            Ok(json!(strip_ansi(
                &sessions.output_from(&id, before).unwrap_or_default()
            )))
        }
        "run_in_terminal" => {
            let id = resolve("sessionId").ok_or("当前没有打开的终端会话")?;
            let command = input
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or("缺少 command 参数")?;
            let session = sessions.get(&id).ok_or_else(|| format!("会话不存在: {id}"))?;

            // 确认模式：先请示用户，被拒绝则不执行
            if confirm_mode {
                let approved = assistant
                    .request_confirm(
                        app,
                        AiConfirmRequest {
                            id: uuid::Uuid::new_v4().to_string(),
                            request_id: request_id.to_string(),
                            tool_call_id: call.call_id.clone(),
                            tool_name: "run_in_terminal".into(),
                            command: command.to_string(),
                            session_id: Some(id.clone()),
                            session_title: Some(session.info().title),
                        },
                    )
                    .await;
                if !approved {
                    return Ok(json!(
                        "用户取消了本次命令执行（命令未运行）。请询问用户接下来希望怎么做，不要擅自重试。"
                    ));
                }
            }

            // 记录写入前的缓冲区位置，执行后只返回新增部分（增量读取），
            // 避免每次都把 SSH 登录横幅等历史内容重复返回给 AI。
            let before = sessions.output_len(&id);
            let data = if command.ends_with('\n') {
                command.to_string()
            } else {
                format!("{command}\r")
            };
            sessions.write(&id, data.as_bytes());
            let wait_ms = input
                .get("waitMs")
                .and_then(|v| v.as_u64())
                .unwrap_or(3000)
                .min(180_000);
            tokio::time::sleep(Duration::from_millis(wait_ms)).await;
            Ok(json!(strip_ansi(
                &sessions.output_from(&id, before).unwrap_or_default()
            )))
        }
        other => Err(format!("未知工具 {other}")),
    }
}

/* ------------------------------ 模型 / provider ------------------------- */

/// 按配置解析 provider：kind 决定 adapter，apiStyle 决定 OpenAI 走 Responses 还是 Chat Completions
fn adapter_kind(config: &AiModelConfig) -> AdapterKind {
    match config.kind.as_str() {
        "anthropic" => AdapterKind::Anthropic,
        "deepseek" => AdapterKind::DeepSeek,
        "google" => AdapterKind::Gemini,
        "openai" => match config.api_style.as_deref() {
            Some("chat-completions") => AdapterKind::OpenAI,
            _ => AdapterKind::OpenAIResp,
        },
        // openai-compatible 及其它：默认 Chat Completions（兼容网关普遍没实现 Responses API）
        _ => AdapterKind::OpenAI,
    }
}

/// 取配置中的 API Key（未配置时用占位串，兼容不校验 key 的本地网关）
fn api_key_of(config: &AiModelConfig) -> String {
    config
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("EMPTY")
        .to_string()
}

/// 构造 client：未显式给出 base_url 时由 genai 用 adapter 默认端点，
/// 因此需要一个 auth resolver 把配置里的 key 注入进去。
fn build_client(api_key: String) -> Client {
    Client::builder()
        .with_auth_resolver_fn(
            move |_iden: ModelIden| -> Result<Option<AuthData>, genai::resolver::Error> {
                Ok(Some(AuthData::from_single(api_key.clone())))
            },
        )
        .build()
}

/// 解析模型调用目标：显式 base_url 时直接给完整 ServiceTarget（兼容各类网关），
/// 否则用 ModelSpec::Iden 交给 genai 推断端点。
fn model_spec(config: &AiModelConfig) -> ModelSpec {
    let kind = adapter_kind(config);
    let model = ModelIden::new(kind, config.model.clone());
    let base_url = config.base_url.as_deref().map(str::trim).unwrap_or("");
    if base_url.is_empty() {
        ModelSpec::from_iden(model)
    } else {
        ModelSpec::from_target(ServiceTarget {
            endpoint: Endpoint::from_owned(normalize_base_url(base_url)),
            auth: AuthData::from_single(api_key_of(config)),
            model,
        })
    }
}

/// base_url 需要以 `/` 结尾，genai 用 `Url::join("chat/completions")` 拼路径
fn normalize_base_url(url: &str) -> String {
    if url.ends_with('/') {
        url.to_string()
    } else {
        format!("{url}/")
    }
}

/// 渲染进程的对话历史 -> 模型消息（文本保留，工具过程转为摘要行）
fn to_model_messages(history: &[AiChatMessage], limit: usize) -> Vec<ChatMessage> {
    let mut messages: Vec<ChatMessage> = Vec::new();
    for msg in history {
        let mut lines: Vec<String> = Vec::new();
        for part in &msg.parts {
            match part {
                AiMessagePart::Text { text } => {
                    if !text.trim().is_empty() {
                        lines.push(text.clone());
                    }
                }
                AiMessagePart::ToolCall { tool_name, .. } => {
                    lines.push(format!("[调用工具 {tool_name}]"));
                }
                AiMessagePart::ToolResult {
                    tool_name, output, ..
                } => {
                    let text = tool_content(output);
                    lines.push(format!(
                        "[工具 {tool_name} 返回] {}",
                        text.chars().take(400).collect::<String>()
                    ));
                }
            }
        }
        let content = lines.join("\n");
        let content = content.trim();
        if content.is_empty() {
            continue;
        }
        messages.push(if msg.role == "assistant" {
            ChatMessage::assistant(content.to_string())
        } else {
            ChatMessage::user(content.to_string())
        });
    }
    if messages.len() > limit {
        messages.split_off(messages.len() - limit)
    } else {
        messages
    }
}

/// 工具结果 -> 回传给模型的文本
fn tool_content(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/* -------------------------------- 文本处理 ------------------------------ */

fn emit(app: &AppHandle, request_id: &str, event: AiStreamEvent) {
    events::broadcast(
        app,
        events::AI_CHAT_EVENT,
        json!({ "requestId": request_id, "event": event }),
    );
}

/// 完整清除终端输出中的 ANSI 转义序列，使 AI 拿到的是纯文本
fn strip_ansi(input: &str) -> String {
    use std::sync::OnceLock;
    static RES: OnceLock<[Regex; 4]> = OnceLock::new();
    let res = RES.get_or_init(|| {
        [
            // OSC / DCS / SOS / PM / APC：\x1b 后跟 ] P _ ^ X，以 BEL 或 ST 结尾
            Regex::new(r"\x1b\][\s\S]*?(?:\x07|\x1b\\)").unwrap(),
            Regex::new(r"\x1b[DP^X][\s\S]*?\x1b\\").unwrap(),
            // CSI：\x1b[ 后跟参数与中间字节，以终结字节结尾
            Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap(),
            // 单字符转义序列：\x1b 后跟一个可打印字符
            Regex::new(r"\x1b[^\x1b]").unwrap(),
        ]
    });
    let mut out = res[0].replace_all(input, "").into_owned();
    out = res[1].replace_all(&out, "").into_owned();
    out = res[2].replace_all(&out, "").into_owned();
    out = res[3].replace_all(&out, "").into_owned();
    out.replace('\x1b', "")
}

/// 把 send_keys 的语义化按键翻译成终端控制字节
fn translate_keys(keys: &str) -> String {
    use std::sync::OnceLock;
    static PATTERNS: OnceLock<[Regex; 3]> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            Regex::new(r"C-([a-zA-Z])").unwrap(),
            Regex::new(r"(?i)Escape").unwrap(),
            Regex::new(r"(?i)Enter|Return").unwrap(),
        ]
    });

    let out = patterns[0]
        .replace_all(keys, |caps: &regex::Captures| {
            let c = caps[1].chars().next().unwrap().to_ascii_uppercase();
            (((c as u8) & 0x1f) as char).to_string()
        })
        .into_owned();
    let out = patterns[1].replace_all(&out, "\x1b").into_owned();
    let out = patterns[2].replace_all(&out, "\r").into_owned();
    out.replace("\r\n", "\r").replace('\n', "\r")
}
