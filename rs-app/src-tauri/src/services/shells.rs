//! 本地 shell 检测。
//!
//! - Windows：PowerShell / CMD / PowerShell 7 / Git Bash / WSL
//! - Unix：$SHELL 与常见安装路径
//!
//! 检测不到时回退到写死的兜底列表，保证下拉永远有可选项。
//! 行为对齐原 `src/main/services/shells.ts`。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::models::{ShellDetectResult, ShellProfile};

/// 检测结果缓存：shell 安装情况在运行期基本不变，避免每次创建终端都扫盘。
static CACHE: OnceLock<ShellDetectResult> = OnceLock::new();

/// 在 PATH 中查找可执行文件（不依赖 `where`/`which` 外部命令）。
fn find_in_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(windows)]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

#[cfg(not(windows))]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(p) {
        Ok(m) => m.is_file() && m.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

fn exists(p: &Path) -> bool {
    is_executable(p)
}

fn id_from_command(command: &str) -> String {
    let base = Path::new(command)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| command.to_string());
    let trimmed = base
        .strip_suffix(".exe")
        .or_else(|| base.strip_suffix(".sh"))
        .unwrap_or(&base);
    let lower = trimmed.to_lowercase();
    if lower.is_empty() {
        command.to_string()
    } else {
        lower
    }
}

/// Git Bash 探测：常见安装路径 + 由 PATH 中 git.exe 推导
fn find_git_bash() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Git\bin\bash.exe"),
    ];
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Programs").join("Git").join("bin").join("bash.exe"));
    }
    if let Some(git) = find_in_path("git.exe") {
        let s = git.to_string_lossy().to_string();
        let lower = s.to_lowercase();
        if let Some(idx) = lower.rfind(r"\cmd\git.exe") {
            candidates.push(PathBuf::from(format!(r"{}\bin\bash.exe", &s[..idx])));
        }
        if let Some(idx) = lower.rfind(r"\mingw64\bin\git.exe") {
            candidates.push(PathBuf::from(format!(r"{}\usr\bin\bash.exe", &s[..idx])));
        }
    }
    candidates.into_iter().find(|p| exists(p))
}

#[cfg(windows)]
fn detect_platform() -> ShellDetectResult {
    let mut shells = vec![
        // PowerShell / CMD 为 Windows 自带，写死兜底，保证下拉永远有项
        ShellProfile {
            id: "powershell".into(),
            name: "PowerShell".into(),
            command: "powershell.exe".into(),
            args: None,
        },
        ShellProfile {
            id: "cmd".into(),
            name: "CMD".into(),
            command: "cmd.exe".into(),
            args: None,
        },
    ];

    let pwsh = find_in_path("pwsh.exe").or_else(|| {
        [
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            r"C:\Program Files\PowerShell\6\pwsh.exe",
        ]
        .iter()
        .map(PathBuf::from)
        .find(|p| exists(p))
    });
    if let Some(p) = pwsh {
        shells.push(ShellProfile {
            id: "pwsh".into(),
            name: "PowerShell 7".into(),
            command: p.to_string_lossy().to_string(),
            args: None,
        });
    }

    if let Some(p) = find_git_bash() {
        shells.push(ShellProfile {
            id: "gitbash".into(),
            name: "Git Bash".into(),
            command: p.to_string_lossy().to_string(),
            args: Some(vec!["--login".into(), "-i".into()]),
        });
    }

    let wsl = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32")
        .join("wsl.exe");
    if exists(&wsl) {
        shells.push(ShellProfile {
            id: "wsl".into(),
            name: "WSL".into(),
            command: "wsl.exe".into(),
            args: None,
        });
    }

    ShellDetectResult {
        shells,
        default_id: "powershell".into(),
    }
}

#[cfg(not(windows))]
fn detect_platform() -> ShellDetectResult {
    let default_shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let candidates = [
        default_shell.as_str(),
        "/bin/bash",
        "/usr/bin/bash",
        "/bin/zsh",
        "/usr/bin/zsh",
        "/bin/fish",
        "/usr/bin/fish",
        "/bin/sh",
        "/bin/dash",
    ];
    let mut seen = std::collections::HashSet::new();
    let mut shells: Vec<ShellProfile> = Vec::new();
    for command in candidates {
        if command.is_empty() || !seen.insert(command.to_string()) {
            continue;
        }
        if !exists(Path::new(command)) {
            continue;
        }
        let id = id_from_command(command);
        if shells.iter().any(|s| s.id == id) {
            continue;
        }
        shells.push(ShellProfile {
            id: id.clone(),
            name: id,
            command: command.into(),
            args: None,
        });
    }
    if shells.is_empty() {
        shells.push(ShellProfile {
            id: "sh".into(),
            name: "sh".into(),
            command: "/bin/sh".into(),
            args: None,
        });
    }
    let default_id = shells
        .iter()
        .find(|s| s.command == default_shell)
        .map(|s| s.id.clone())
        .unwrap_or_else(|| shells[0].id.clone());
    ShellDetectResult { shells, default_id }
}

/// 检测本地可用 shell（带缓存）
pub fn detect_shells() -> ShellDetectResult {
    CACHE.get_or_init(detect_platform).clone()
}

pub struct ResolvedShell {
    pub command: String,
    pub args: Option<Vec<String>>,
    /// 终端标签展示名
    pub title: String,
}

/// 按配置 id 解析出实际要 spawn 的 shell；id 为空 / 'default' / 无效时回退平台默认。
pub fn resolve_local_shell(shell_id: Option<&str>) -> ResolvedShell {
    let result = detect_shells();
    let id = match shell_id {
        Some(v) if !v.is_empty() && v != "default" => v,
        _ => result.default_id.as_str(),
    };
    if let Some(p) = result.shells.iter().find(|s| s.id == id) {
        return ResolvedShell {
            command: p.command.clone(),
            args: p.args.clone(),
            title: p.name.clone(),
        };
    }
    #[cfg(windows)]
    {
        ResolvedShell {
            command: std::env::var("PWSH_PATH").unwrap_or_else(|_| "powershell.exe".into()),
            args: None,
            title: "PowerShell".into(),
        }
    }
    #[cfg(not(windows))]
    {
        let command = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let title = id_from_command(&command);
        ResolvedShell {
            command,
            args: None,
            title,
        }
    }
}
