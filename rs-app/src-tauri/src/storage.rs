//! 敏感字段落盘加密 + 持久化存储。
//!
//! - 加密：AES-256-GCM。密钥持久化在 `app_data/key.bin`。加解密透明，密文带 `enc:` 前缀，
//!   与 Electron `safeStorage` 的对外语义一致（列表中脱敏、仅内部解密）。
//! - 存储：sled（嵌入式 KV），各实体以独立 K/V 键保存 JSON。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use rand::RngCore;
use serde::de::DeserializeOwned;

use crate::error::AppResult;
use crate::models::*;

pub const ENC_PREFIX: &str = "enc:";

#[derive(Clone)]
pub struct Storage {
    db: sled::Db,
    cipher: Arc<Aes256Gcm>,
    /// 进程内偏好缓存：偏好读取频繁，读写都走这里，save 时即时落盘
    prefs: Arc<RwLock<Preferences>>,
    /// 窗口边界缓存（创建窗口前读取）
    window_bounds: Arc<RwLock<serde_json::Value>>,
}

impl Storage {
    pub fn open(app_data_dir: PathBuf) -> AppResult<Self> {
        let db_path = app_data_dir.join("store");
        let db = sled::open(db_path)?;
        let cipher = Arc::new(load_or_create_key(&app_data_dir)?);

        let prefs: Preferences = db_get(&db, "preferences");
        let window_bounds: serde_json::Value = db_get(&db, "windowBounds");

        Ok(Self {
            db,
            cipher,
            prefs: Arc::new(RwLock::new(prefs)),
            window_bounds: Arc::new(RwLock::new(window_bounds)),
        })
    }

    // ---------------- 加密 ----------------
    fn encrypt(&self, secret: Option<String>) -> Option<String> {
        let secret = secret?;
        if secret.is_empty() {
            return None;
        }
        let mut nonce_bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ct = match self.cipher.encrypt(nonce, secret.as_bytes()) {
            Ok(v) => v,
            // 加密失败时保守回退明文，避免把配置写成空值
            Err(_) => return Some(secret),
        };
        let mut out = nonce_bytes.to_vec();
        out.extend_from_slice(&ct);
        Some(format!("{ENC_PREFIX}{}", base64::engine::general_purpose::STANDARD.encode(out)))
    }

    fn decrypt(&self, stored: Option<&str>) -> Option<String> {
        let stored = stored?;
        if !stored.starts_with(ENC_PREFIX) {
            return Some(stored.to_string());
        }
        let raw = base64::engine::general_purpose::STANDARD
            .decode(&stored[ENC_PREFIX.len()..])
            .ok()?;
        if raw.len() < 13 {
            return None;
        }
        let (nonce, ct) = raw.split_at(12);
        let pt = self
            .cipher
            .decrypt(Nonce::from_slice(nonce), ct)
            .ok()?;
        String::from_utf8(pt).ok()
    }

    // ---------------- 偏好 ----------------
    pub fn get_preferences(&self) -> Preferences {
        self.prefs.read().unwrap().clone()
    }

    pub fn save_preferences(&self, patch: PreferencesPatch) -> Preferences {
        let mut prefs = self.get_preferences();
        prefs.apply(patch);
        *self.prefs.write().unwrap() = prefs.clone();
        let _ = self.db.insert("preferences", serde_json::to_vec(&prefs).unwrap());
        let _ = self.db.flush();
        prefs
    }

    // ---------------- 窗口 ---------------
    pub fn get_window_bounds(&self) -> serde_json::Value {
        self.window_bounds.read().unwrap().clone()
    }

    pub fn set_window_bounds(&self, v: serde_json::Value) {
        *self.window_bounds.write().unwrap() = v.clone();
        let _ = self.db.insert("windowBounds", serde_json::to_vec(&v).unwrap());
        let _ = self.db.flush();
    }

    // ---------------- SSH 配置 ----------------
    pub fn list_ssh_profiles(&self) -> Vec<SshProfile> {
        self.list_ssh_profiles_raw()
            .into_iter()
            .map(|mut p| {
                if p.kind.is_empty() {
                    p.kind = "ssh".into();
                }
                p.has_password = Some(p.password.as_deref().map_or(false, |s| !s.is_empty()));
                p.has_private_key = Some(
                    p.private_key.as_deref().map_or(false, |s| !s.is_empty()),
                );
                p.has_passphrase = Some(
                    p.passphrase.as_deref().map_or(false, |s| !s.is_empty()),
                );
                p.password = None;
                p.private_key = None;
                p.passphrase = None;
                p
            })
            .collect()
    }

    fn list_ssh_profiles_raw(&self) -> Vec<SshProfile> {
        db_get(&self.db, "sshProfiles")
    }

    /// 内部用：解密敏感字段（绝不直接发给渲染端）
    pub fn get_ssh_profile(&self, id: &str) -> Option<SshProfile> {
        let mut p = self
            .list_ssh_profiles_raw()
            .into_iter()
            .find(|p| p.id == id)?;
        p.kind = if p.kind.is_empty() { "ssh".into() } else { p.kind };
        p.password = self.decrypt(p.password.as_deref());
        p.passphrase = self.decrypt(p.passphrase.as_deref());
        Some(p)
    }

    pub fn save_ssh_profile(&self, input: SshProfile) -> Vec<SshProfile> {
        let mut profiles = self.list_ssh_profiles_raw();
        let now = now_ms();
        let prev_idx = profiles.iter().position(|p| !p.id.is_empty() && p.id == input.id);
        let prev = prev_idx.map(|i| &profiles[i]).cloned();

        let mut profile = input;
        if profile.id.is_empty() {
            profile.id = uuid::Uuid::new_v4().to_string();
        }
        if profile.kind.is_empty() {
            profile.kind = "ssh".into();
        }
        profile.password = if profile.password.is_some() {
            self.encrypt(profile.password)
        } else {
            prev.as_ref().and_then(|p| p.password.clone())
        };
        profile.private_key = if profile.private_key.is_some() {
            profile.private_key
        } else {
            prev.as_ref().and_then(|p| p.private_key.clone())
        };
        profile.passphrase = if profile.passphrase.is_some() {
            self.encrypt(profile.passphrase)
        } else {
            prev.as_ref().and_then(|p| p.passphrase.clone())
        };
        profile.created_at = prev.as_ref().map(|p| p.created_at).unwrap_or(now);
        profile.updated_at = now;

        match prev_idx {
            Some(i) => profiles[i] = profile,
            None => profiles.push(profile),
        }
        let _ = self
            .db
            .insert("sshProfiles", serde_json::to_vec(&profiles).unwrap());
        let _ = self.db.flush();
        self.list_ssh_profiles()
    }

    pub fn delete_ssh_profile(&self, id: &str) -> Vec<SshProfile> {
        let profiles: Vec<SshProfile> = self
            .list_ssh_profiles_raw()
            .into_iter()
            .filter(|p| p.id != id)
            .collect();
        let _ = self.db.insert("sshProfiles", serde_json::to_vec(&profiles).unwrap());
        let _ = self.db.flush();
        self.list_ssh_profiles()
    }

    pub fn arrange_ssh(&self, payload: ArrangePayload) -> ArrangeResult {
        let groups = self.list_ssh_groups_raw();
        let by_id: HashMap<&str, &SshGroup> =
            groups.iter().map(|g| (g.id.as_str(), g)).collect();
        let mut ordered: Vec<SshGroup> = Vec::new();
        for id in &payload.group_ids {
            if let Some(g) = by_id.get(id.as_str()) {
                ordered.push((*g).clone());
            }
        }
        for g in &groups {
            if !payload.group_ids.contains(&g.id) {
                ordered.push(g.clone());
            }
        }
        let _ = self.db.insert("sshGroups", serde_json::to_vec(&ordered).unwrap());

        let profiles = self.list_ssh_profiles_raw();
        let p_by_id: HashMap<&str, &SshProfile> =
            profiles.iter().map(|p| (p.id.as_str(), p)).collect();
        let mut next: Vec<SshProfile> = Vec::new();
        for item in &payload.profiles {
            let Some(p) = p_by_id.get(item.id.as_str()) else {
                continue;
            };
            if p.group_id != item.group_id {
                let mut np = (*p).clone();
                np.group_id = item.group_id.clone();
                np.updated_at = now_ms();
                next.push(np);
            } else {
                next.push((*p).clone());
            }
        }
        for p in &profiles {
            if !next.iter().any(|x| x.id == p.id) {
                next.push(p.clone());
            }
        }
        let _ = self.db.insert("sshProfiles", serde_json::to_vec(&next).unwrap());
        let _ = self.db.flush();

        ArrangeResult {
            groups: self.list_ssh_groups(),
            profiles: self.list_ssh_profiles(),
        }
    }

    // ---------------- SSH 分组 ----------------
    fn list_ssh_groups_raw(&self) -> Vec<SshGroup> {
        db_get(&self.db, "sshGroups")
    }

    pub fn list_ssh_groups(&self) -> Vec<SshGroup> {
        self.list_ssh_groups_raw()
    }

    pub fn save_ssh_group(&self, input: SshGroupInput) -> Vec<SshGroup> {
        let mut groups = self.list_ssh_groups_raw();
        let prev_idx = input
            .id
            .as_ref()
            .and_then(|id| groups.iter().position(|g| &g.id == id));
        let prev = prev_idx.map(|i| groups[i].clone());
        let now = now_ms();
        let group = SshGroup {
            id: input
                .id
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            name: input.name.trim().to_string(),
            color: match input.color {
                Some(Some(c)) => Some(c),
                Some(None) => None,
                None => prev.as_ref().and_then(|g| g.color.clone()),
            },
            created_at: prev.as_ref().map(|g| g.created_at).unwrap_or(now),
        };
        match prev_idx {
            Some(i) => groups[i] = group,
            None => groups.push(group),
        }
        let _ = self.db.insert("sshGroups", serde_json::to_vec(&groups).unwrap());
        let _ = self.db.flush();
        self.list_ssh_groups()
    }

    pub fn delete_ssh_group(&self, id: &str, delete_profiles: bool) -> Vec<SshGroup> {
        let groups: Vec<SshGroup> = self
            .list_ssh_groups_raw()
            .into_iter()
            .filter(|g| g.id != id)
            .collect();
        let _ = self.db.insert("sshGroups", serde_json::to_vec(&groups).unwrap());

        let profiles: Vec<SshProfile> = self
            .list_ssh_profiles_raw()
            .into_iter()
            .filter(|p| !(delete_profiles && p.group_id.as_deref() == Some(id)))
            .map(|mut p| {
                if p.group_id.as_deref() == Some(id) {
                    p.group_id = None;
                }
                p
            })
            .collect();
        let _ = self
            .db
            .insert("sshProfiles", serde_json::to_vec(&profiles).unwrap());
        let _ = self.db.flush();
        self.list_ssh_groups()
    }

    // ---------------- 脚本 ----------------
    pub fn list_scripts(&self) -> Vec<ScriptEntry> {
        db_get(&self.db, "scripts")
    }

    pub fn save_script(&self, input: ScriptEntry) -> Vec<ScriptEntry> {
        let mut list = self.list_scripts();
        let now = now_ms();
        let prev_idx = list.iter().position(|s| !s.id.is_empty() && s.id == input.id);
        let prev = prev_idx.map(|i| list[i].clone());
        let entry = ScriptEntry {
            id: if input.id.is_empty() {
                uuid::Uuid::new_v4().to_string()
            } else {
                input.id
            },
            name: input.name,
            content: input.content,
            description: input.description,
            created_at: prev.as_ref().map(|s| s.created_at).unwrap_or(now),
            updated_at: now,
        };
        match prev_idx {
            Some(i) => list[i] = entry,
            None => list.push(entry),
        }
        let _ = self.db.insert("scripts", serde_json::to_vec(&list).unwrap());
        let _ = self.db.flush();
        list
    }

    pub fn delete_script(&self, id: &str) -> Vec<ScriptEntry> {
        let list: Vec<ScriptEntry> = self
            .list_scripts()
            .into_iter()
            .filter(|s| s.id != id)
            .collect();
        let _ = self.db.insert("scripts", serde_json::to_vec(&list).unwrap());
        let _ = self.db.flush();
        list
    }

    // ---------------- 笔记 ----------------
    pub fn list_notes(&self) -> Vec<NoteEntry> {
        db_get(&self.db, "notes")
    }

    pub fn save_note(&self, input: NoteEntry) -> Vec<NoteEntry> {
        let mut list = self.list_notes();
        let now = now_ms();
        let prev_idx = list.iter().position(|n| !n.id.is_empty() && n.id == input.id);
        let prev = prev_idx.map(|i| list[i].clone());
        let entry = NoteEntry {
            id: if input.id.is_empty() {
                uuid::Uuid::new_v4().to_string()
            } else {
                input.id
            },
            title: input.title,
            content: input.content,
            language: if input.language.is_empty() {
                prev.as_ref().map(|n| n.language.clone()).unwrap_or_else(|| "markdown".into())
            } else {
                input.language
            },
            created_at: prev.as_ref().map(|n| n.created_at).unwrap_or(now),
            updated_at: now,
        };
        match prev_idx {
            Some(i) => list[i] = entry,
            None => list.push(entry),
        }
        let _ = self.db.insert("notes", serde_json::to_vec(&list).unwrap());
        let _ = self.db.flush();
        list
    }

    pub fn delete_note(&self, id: &str) -> Vec<NoteEntry> {
        let list: Vec<NoteEntry> = self
            .list_notes()
            .into_iter()
            .filter(|n| n.id != id)
            .collect();
        let _ = self.db.insert("notes", serde_json::to_vec(&list).unwrap());
        let _ = self.db.flush();
        list
    }

    // ---------------- 快捷键 ----------------
    pub fn get_shortcuts(&self) -> Vec<ShortcutConfig> {
        let stored: Vec<ShortcutConfig> = db_get(&self.db, "shortcuts");
        merge_shortcuts(stored)
    }

    pub fn save_shortcuts(&self, shortcuts: Vec<ShortcutConfig>) -> Vec<ShortcutConfig> {
        let next = merge_shortcuts(shortcuts);
        let _ = self.db.insert("shortcuts", serde_json::to_vec(&next).unwrap());
        let _ = self.db.flush();
        next
    }

    // ---------------- AI 配置 / 设置 ----------------
    pub fn list_ai_configs(&self) -> Vec<AiModelConfig> {
        self.list_ai_configs_raw()
            .into_iter()
            .map(|mut c| {
                c.has_api_key = Some(c.api_key.as_deref().map_or(false, |s| !s.is_empty()));
                c.api_key = None;
                c
            })
            .collect()
    }

    fn list_ai_configs_raw(&self) -> Vec<AiModelConfig> {
        db_get(&self.db, "aiConfigs")
    }

    pub fn get_ai_config(&self, id: &str) -> Option<AiModelConfig> {
        let mut c = self.list_ai_configs_raw().into_iter().find(|c| c.id == id)?;
        c.api_key = self.decrypt(c.api_key.as_deref());
        Some(c)
    }

    pub fn save_ai_config(&self, input: AiModelConfig) -> Vec<AiModelConfig> {
        let mut list = self.list_ai_configs_raw();
        let now = now_ms();
        let prev_idx = list.iter().position(|c| !c.id.is_empty() && c.id == input.id);
        let prev = prev_idx.map(|i| list[i].clone());
        let mut config = input;
        if config.id.is_empty() {
            config.id = uuid::Uuid::new_v4().to_string();
        }
        config.api_key = if config.api_key.is_some() {
            self.encrypt(config.api_key)
        } else {
            prev.as_ref().and_then(|c| c.api_key.clone())
        };
        config.created_at = prev.as_ref().map(|c| c.created_at).unwrap_or(now);
        config.updated_at = now;
        match prev_idx {
            Some(i) => list[i] = config,
            None => list.push(config),
        }
        let _ = self.db.insert("aiConfigs", serde_json::to_vec(&list).unwrap());
        let _ = self.db.flush();
        self.list_ai_configs()
    }

    pub fn delete_ai_config(&self, id: &str) -> Vec<AiModelConfig> {
        let list: Vec<AiModelConfig> = self
            .list_ai_configs_raw()
            .into_iter()
            .filter(|c| c.id != id)
            .collect();
        let _ = self.db.insert("aiConfigs", serde_json::to_vec(&list).unwrap());
        let _ = self.db.flush();
        // 删除的是当前激活模型时，清空激活指向
        if self.get_ai_settings().active_config_id.as_deref() == Some(id) {
            self.save_ai_settings_patch(AiSettingsPatch {
                active_config_id: Some(None),
                ..Default::default()
            });
        }
        self.list_ai_configs()
    }

    pub fn get_ai_settings(&self) -> AiSettings {
        let mut s: AiSettings = db_get(&self.db, "aiSettings");
        s.permission_mode = if s.permission_mode.is_empty() {
            "full".into()
        } else {
            s.permission_mode
        };
        s
    }

    pub fn save_ai_settings_patch(&self, patch: AiSettingsPatch) -> AiSettings {
        let mut s = self.get_ai_settings();
        if let Some(v) = patch.active_config_id {
            s.active_config_id = v;
        }
        if let Some(v) = patch.permission_mode {
            if !v.is_empty() {
                s.permission_mode = v;
            }
        }
        if let Some(v) = patch.system_prompt {
            s.system_prompt = if v.is_empty() { None } else { Some(v) };
        }
        self.save_ai_settings(&s)
    }

    pub fn save_ai_settings(&self, s: &AiSettings) -> AiSettings {
        let _ = self.db.insert("aiSettings", serde_json::to_vec(s).unwrap());
        let _ = self.db.flush();
        s.clone()
    }

    // ---------------- MCP ----------------
    pub fn list_mcp_servers(&self) -> Vec<McpServerConfig> {
        db_get(&self.db, "mcpServers")
    }

    pub fn save_mcp_server(&self, input: McpServerConfig) -> Vec<McpServerConfig> {
        let mut list = self.list_mcp_servers();
        let mut server = input;
        if server.id.is_empty() {
            server.id = uuid::Uuid::new_v4().to_string();
        }
        match list.iter_mut().find(|s| s.id == server.id) {
            Some(s) => *s = server,
            None => list.push(server),
        }
        let _ = self.db.insert("mcpServers", serde_json::to_vec(&list).unwrap());
        let _ = self.db.flush();
        list
    }

    pub fn delete_mcp_server(&self, id: &str) -> Vec<McpServerConfig> {
        let list: Vec<McpServerConfig> = self
            .list_mcp_servers()
            .into_iter()
            .filter(|s| s.id != id)
            .collect();
        let _ = self.db.insert("mcpServers", serde_json::to_vec(&list).unwrap());
        let _ = self.db.flush();
        list
    }
}

/// 从 sled 读 JSON，解析失败或缺树返回默认
fn db_get<T: DeserializeOwned + Default>(db: &sled::Db, key: &str) -> T {
    match db.get(key) {
        Ok(Some(bytes)) => serde_json::from_slice(&bytes).unwrap_or_default(),
        _ => T::default(),
    }
}

/// 生成 / 读取一致的对称加密密钥（不存在则创建并落盘）
fn load_or_create_key(dir: &std::path::Path) -> AppResult<Aes256Gcm> {
    let key_path = dir.join("key.bin");
    let key: [u8; 32] = if key_path.exists() {
        let bytes = std::fs::read(&key_path)?;
        if bytes.len() != 32 {
            return Err(crate::error::AppError::msg("key.bin 长度非法"));
        }
        let mut k = [0u8; 32];
        k.copy_from_slice(&bytes);
        k
    } else {
        let mut k = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut k);
        let _ = std::fs::write(&key_path, k);
        k
    };
    Ok(Aes256Gcm::new_from_slice(&key).unwrap())
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 合并存储的快捷键与缺省清单：确保每个动作都有条目
fn merge_shortcuts(stored: Vec<ShortcutConfig>) -> Vec<ShortcutConfig> {
    let defaults = default_shortcuts();
    let by_action: HashMap<String, String> = stored
        .into_iter()
        .map(|s| (s.action, s.accelerator))
        .collect();
    defaults
        .into_iter()
        .map(|d| ShortcutConfig {
            accelerator: by_action
                .get(&d.action)
                .cloned()
                .unwrap_or(d.accelerator),
            ..d
        })
        .collect()
}