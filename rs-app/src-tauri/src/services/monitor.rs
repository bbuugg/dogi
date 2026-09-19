//! 服务器监控采集：按会话周期性地经独立 exec 通道执行一段 bash，解析 /proc 与 df。
//!
//! 语义照搬原 Electron 版 `monitor.ts`：依赖 Linux 的 /proc 与 df，非 Linux 的本地
//! 终端直接跳过；命令执行失败 / 结果无效连续多次后即停止，避免空转。采到的指标
//! 经 `monitor:data` 事件广播给渲染端。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::models::{DiskUsage, ServerMetrics};
use crate::services::sessions::manager::{now_ms, Session};
use crate::state::AppState;
use crate::events;

/// 允许的采集间隔范围（渲染端提供 200ms~5s 选项，此处仅做兜底校验）
const MIN_INTERVAL_MS: i64 = 100;
const MAX_INTERVAL_MS: i64 = 60_000;

/// 结果无效（目标无 /proc，如 Windows / BSD / macOS）的连续次数上限，达限即停止
const MAX_INVALID: u32 = 3;
/// 采集命令执行失败的连续次数上限（连接抖动应能自愈，阈值放宽）
const MAX_EXEC_FAILURES: u32 = 15;

/// 睡眠分片粒度：既保证 stop / 间隔调整能及时生效，又避免高频空转
const SLEEP_SLICE_MS: u64 = 200;

/// 一次性采集命令：各段用固定分隔标记，便于解析。仅依赖 Linux 的 /proc 与 df。
const COLLECT_CMD: &str = "cat /proc/loadavg 2>/dev/null; echo '===MEM==='; cat /proc/meminfo 2>/dev/null; echo '===CPU==='; cat /proc/stat 2>/dev/null; echo '===NET==='; cat /proc/net/dev 2>/dev/null; echo '===UP==='; cat /proc/uptime 2>/dev/null; echo '===DISK==='; df -P -B1 2>/dev/null";

/// 归一化采集间隔：越界值收敛到边界
fn normalize_interval(ms: u64) -> u64 {
    (ms as i64).clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS) as u64
}

/// 取出 raw 中 start 与 end 标记之间的内容（不含标记）
fn section<'a>(raw: &'a str, start: &str, end: Option<&str>) -> &'a str {
    let Some(s) = raw.find(start) else {
        return "";
    };
    let from = s + start.len();
    match end {
        None => &raw[from..],
        Some(end) => match raw[from..].find(end) {
            None => &raw[from..],
            Some(e) => &raw[from..from + e],
        },
    }
}

/// 采集结果是否为有效数据（目标含 /proc）——不是则前端不显示指标
fn is_supported(m: &ServerMetrics) -> bool {
    m.mem_total > 0 || m.cores > 0 || !m.disk.is_empty()
}

/// 形如 `cpu0` / `cpu12` 的逐核行
fn is_per_core_line(line: &str) -> bool {
    line.strip_prefix("cpu")
        .and_then(|rest| rest.chars().next())
        .is_some_and(|c| c.is_ascii_digit())
}

/// 内存盘 / 只读层等伪文件系统
fn is_pseudo_fs(fs: &str) -> bool {
    ["tmpfs", "devtmpfs", "squashfs", "overlay", "snap"]
        .iter()
        .any(|k| fs.contains(k))
}

fn parse_f64(s: Option<&str>) -> f64 {
    s.and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0)
}

/// CPU 跨采样差分状态
#[derive(Default)]
struct CpuState {
    total: u64,
    idle: u64,
}

/// 网卡跨采样差分状态（rx, tx 累计字节）
#[derive(Default)]
struct NetState {
    map: HashMap<String, (u64, u64)>,
}

/// 解析一段采集输出。`elapsed` 为距上次**有效**采样的秒数（首采为 0）。
fn parse(
    raw: &str,
    elapsed: f64,
    now: u64,
    cpu: &mut CpuState,
    net: &mut NetState,
) -> ServerMetrics {
    let load_raw = raw.split("===MEM===").next().unwrap_or("").trim();
    let mem_raw = section(raw, "===MEM===", Some("===CPU==="));
    let cpu_raw = section(raw, "===CPU===", Some("===NET==="));
    let net_raw = section(raw, "===NET===", Some("===UP==="));
    let up_raw = section(raw, "===UP===", Some("===DISK==="));
    let disk_raw = section(raw, "===DISK===", None);

    // ---- 负载 ----
    let load_parts: Vec<&str> = load_raw.split_whitespace().collect();
    let load1 = parse_f64(load_parts.first().copied());
    let load5 = parse_f64(load_parts.get(1).copied());
    let load15 = parse_f64(load_parts.get(2).copied());

    // ---- 内存（meminfo 单位 kB）----
    let mem_get = |key: &str| -> u64 {
        mem_raw
            .lines()
            .find_map(|l| {
                let (k, v) = l.split_once(':')?;
                if k.trim() != key {
                    return None;
                }
                v.trim().split_whitespace().next()?.parse::<u64>().ok()
            })
            .unwrap_or(0)
            * 1024
    };
    let mem_total = mem_get("MemTotal");
    let mem_free = mem_get("MemFree");
    let buffers = mem_get("Buffers");
    let cached = mem_get("Cached");
    let mem_available_raw = mem_get("MemAvailable");
    // 老内核没有 MemAvailable 时回退为 free + buffers + cached
    let mem_available = if mem_available_raw > 0 {
        mem_available_raw
    } else {
        mem_free + buffers + cached
    };
    let mem_used = mem_total.saturating_sub(mem_available);
    let mem_percent = if mem_total > 0 {
        (mem_used as f64 / mem_total as f64) * 100.0
    } else {
        0.0
    };

    // ---- CPU（聚合行 cpu + 各核 cpuN）----
    let cpu_lines: Vec<&str> = cpu_raw
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let agg = cpu_lines
        .iter()
        .find(|l| l.starts_with("cpu "))
        .copied()
        .unwrap_or_else(|| cpu_lines.first().copied().unwrap_or(""));
    let cpu_parts: Vec<u64> = agg
        .split_whitespace()
        .skip(1)
        .map(|n| n.parse::<u64>().unwrap_or(0))
        .collect();
    let core_lines = cpu_lines.iter().filter(|l| is_per_core_line(l)).count() as u64;
    let cores = if core_lines > 0 {
        core_lines
    } else if cpu_parts.is_empty() {
        0
    } else {
        1
    };
    let cpu_total: u64 = cpu_parts.iter().sum();
    // user nice system idle iowait ...：使用率取 (1 - (idle+iowait)/total) 的增量
    let cpu_idle = cpu_parts.get(3).copied().unwrap_or(0) + cpu_parts.get(4).copied().unwrap_or(0);
    let mut cpu_percent = None;
    if elapsed > 0.0 {
        let d_total = cpu_total as i64 - cpu.total as i64;
        let d_idle = cpu_idle as i64 - cpu.idle as i64;
        if d_total > 0 {
            cpu_percent = Some(((1.0 - d_idle as f64 / d_total as f64) * 100.0).clamp(0.0, 100.0));
        }
    }
    cpu.total = cpu_total;
    cpu.idle = cpu_idle;

    // ---- 网络（汇总非回环网卡，按速率计算）----
    let mut net_rx_rate = 0.0f64;
    let mut net_tx_rate = 0.0f64;
    let mut cur_net = HashMap::new();
    for line in net_raw.lines().skip(2) {
        let Some(idx) = line.find(':') else { continue };
        let iface = line[..idx].trim();
        if iface == "lo" {
            continue;
        }
        let fields: Vec<u64> = line[idx + 1..]
            .split_whitespace()
            .map(|n| n.parse::<u64>().unwrap_or(0))
            .collect();
        let rx = fields.first().copied().unwrap_or(0);
        let tx = fields.get(8).copied().unwrap_or(0);
        if elapsed > 0.0 {
            if let Some(prev) = net.map.get(iface) {
                net_rx_rate += (rx.saturating_sub(prev.0)) as f64 / elapsed;
                net_tx_rate += (tx.saturating_sub(prev.1)) as f64 / elapsed;
            }
        }
        cur_net.insert(iface.to_string(), (rx, tx));
    }
    net.map = cur_net;

    // ---- 运行时长 ----
    let uptime = parse_f64(up_raw.split_whitespace().next());

    // ---- 磁盘（df -P 列：Filesystem 1024-blocks Used Available Capacity Mounted-on）----
    let mut disk = Vec::new();
    for l in disk_raw.lines() {
        let f: Vec<&str> = l.split_whitespace().collect();
        if f.len() < 6 {
            continue;
        }
        let fs = f[0];
        // 表头行的 Used / Available 列不是数字（"Mounted on" 还会被拆成两列），据此跳过
        let (Ok(used), Ok(available)) = (f[2].parse::<u64>(), f[3].parse::<u64>()) else {
            continue;
        };
        // "12%" → 12
        let percent = f[4].trim_end_matches('%').parse::<u32>().unwrap_or(0);
        let mount = f[5];
        // 跳过伪文件系统（保留根分区）
        if is_pseudo_fs(fs) && mount != "/" {
            continue;
        }
        disk.push(DiskUsage {
            mount: mount.to_string(),
            used,
            total: used + available,
            percent,
        });
    }

    ServerMetrics {
        cpu_percent,
        cores,
        mem_total,
        mem_used,
        mem_percent,
        load1,
        load5,
        load15,
        net_rx_rate,
        net_tx_rate,
        disk,
        uptime,
        timestamp: now,
    }
}

/// 监控服务：按会话维护各自的采集任务，并对外广播指标
pub struct MonitorService {
    /// 采集间隔（毫秒）；采集任务每轮读取，调整后下一轮即生效
    interval_ms: Arc<AtomicU64>,
    /// 正在采集的会话 → 中止标志
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl MonitorService {
    pub fn new(interval_ms: u64) -> Self {
        Self {
            interval_ms: Arc::new(AtomicU64::new(normalize_interval(interval_ms))),
            active: Mutex::new(HashMap::new()),
        }
    }

    /// 当前采集间隔（毫秒）
    pub fn interval_ms(&self) -> u64 {
        self.interval_ms.load(Ordering::SeqCst)
    }

    /// 全局调整采集间隔：现有会话下一轮生效，后续新建沿用
    pub fn set_interval(&self, ms: u64) {
        self.interval_ms
            .store(normalize_interval(ms), Ordering::SeqCst);
    }

    /// 开始采集某会话。非 Linux 的本地终端必然取不到 /proc 数据，直接跳过。
    pub fn start(&self, app: &AppHandle, session_id: &str) {
        if self.active.lock().unwrap().contains_key(session_id) {
            return;
        }
        let Some(session) = session_of(app, session_id) else {
            return;
        };
        if session.info().r#type == "local" && !cfg!(target_os = "linux") {
            return;
        }

        let stop = Arc::new(AtomicBool::new(false));
        self.active
            .lock()
            .unwrap()
            .insert(session_id.to_string(), Arc::clone(&stop));

        let app = app.clone();
        let sid = session_id.to_string();
        let interval = Arc::clone(&self.interval_ms);
        tauri::async_runtime::spawn(async move {
            monitor_loop(app.clone(), sid.clone(), stop, interval).await;
            // 采集结束（会话关闭 / 长期失败 / 目标不可采集）：回收登记项
            app.state::<AppState>().monitor.stop(&sid);
        });
    }

    /// 停止采集某会话
    pub fn stop(&self, session_id: &str) {
        if let Some(flag) = self.active.lock().unwrap().remove(session_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

/// 取会话（持有的是 Arc，不长期占用 AppState 借用）
fn session_of(app: &AppHandle, session_id: &str) -> Option<Arc<dyn Session>> {
    app.state::<AppState>().sessions.get(session_id)
}

/// 某会话的周期采集：执行命令 → 解析 → 有效则广播
async fn monitor_loop(
    app: AppHandle,
    session_id: String,
    stop: Arc<AtomicBool>,
    interval: Arc<AtomicU64>,
) {
    let mut cpu = CpuState::default();
    let mut net = NetState::default();
    let mut exec_failures = 0u32;
    let mut invalid_results = 0u32;
    // 上次成功推送的时间戳（首采为 0）
    let mut prev_ts = 0u64;

    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let Some(session) = session_of(&app, &session_id) else {
            // 会话已关闭：停止采集
            return;
        };
        // 会话已退出（SSH 断开 / shell 结束）：不会再有数据，停止采集
        if session.info().exited {
            return;
        }
        // 连接尚未就绪（SSH 握手中 / shell 未起来）：跳过本轮
        if !session.is_ready() {
            sleep_interruptible(interval.load(Ordering::SeqCst), &stop, &interval).await;
            continue;
        }

        let raw = match session.exec(COLLECT_CMD.to_string()).await {
            Ok(raw) => raw,
            Err(_) => {
                // 瞬时故障：连续多次失败才判定该会话不可采集
                exec_failures += 1;
                if exec_failures >= MAX_EXEC_FAILURES {
                    return;
                }
                sleep_interruptible(interval.load(Ordering::SeqCst), &stop, &interval).await;
                continue;
            }
        };

        let now = now_ms();
        let elapsed = if prev_ts > 0 {
            (now.saturating_sub(prev_ts)) as f64 / 1000.0
        } else {
            0.0
        };
        let metrics = parse(&raw, elapsed, now, &mut cpu, &mut net);

        // 采集不到有效数据时不推送（前端据此不显示指标）
        if !is_supported(&metrics) {
            invalid_results += 1;
            if invalid_results >= MAX_INVALID {
                return;
            }
            sleep_interruptible(interval.load(Ordering::SeqCst), &stop, &interval).await;
            continue;
        }

        exec_failures = 0;
        invalid_results = 0;
        prev_ts = now;
        events::broadcast(
            &app,
            events::MONITOR_DATA,
            json!({ "sessionId": session_id, "metrics": metrics }),
        );

        sleep_interruptible(interval.load(Ordering::SeqCst), &stop, &interval).await;
    }
}

/// 分片睡眠：stop 置位或采集间隔被调整时提前返回（让新节奏尽快生效）
async fn sleep_interruptible(ms: u64, stop: &Arc<AtomicBool>, interval: &Arc<AtomicU64>) {
    let mut remaining = ms;
    while remaining > 0 {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let step = remaining.min(SLEEP_SLICE_MS);
        tokio::time::sleep(Duration::from_millis(step)).await;
        remaining -= step;
        if interval.load(Ordering::SeqCst) != ms {
            return;
        }
    }
}