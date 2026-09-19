use serde::{Serialize, Serializer};

/// 统一错误类型：IPC 边界上序列化为字符串（前端按 Error 抛出后取 message）。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// 业务错误：直接透出给前端展示
    #[error("{0}")]
    Msg(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Db(#[from] sled::Error),
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    #[error(transparent)]
    Anyhow(#[from] anyhow::Error),
}

impl AppError {
    pub fn msg(m: impl Into<String>) -> Self {
        AppError::Msg(m.into())
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

/// 便捷宏：`bail_msg!("...")`
#[macro_export]
macro_rules! bail_msg {
    ($($arg:tt)*) => {
        return Err($crate::error::AppError::Msg(format!($($arg)*)))
    };
}
