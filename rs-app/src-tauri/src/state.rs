//! 应用全局状态：在 `setup` 中构建并交给 Tauri 托管。

use crate::services::sessions::manager::SessionManager;
use crate::storage::Storage;

pub struct AppState {
    pub storage: Storage,
    pub sessions: SessionManager,
}

impl AppState {
    pub fn new(storage: Storage) -> Self {
        Self {
            storage,
            sessions: SessionManager::new(),
        }
    }
}
