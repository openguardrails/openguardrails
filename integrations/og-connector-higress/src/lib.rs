// OpenGuardrails Connector Plugin for Higress
// Integrates OG security capabilities with anonymization and restoration

use proxy_wasm::traits::{Context, HttpContext, RootContext};
use proxy_wasm::types::{Action, ContextType, DataAction, HeaderAction, LogLevel};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

/// Safely truncate a string at character boundary (not byte boundary)
/// This prevents panic when slicing UTF-8 strings with multi-byte characters
fn safe_truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_chars).collect();
        format!("{}...", truncated)
    }
}

proxy_wasm::main! {{
    // Set to Debug level for detailed K8s troubleshooting
    proxy_wasm::set_log_level(LogLevel::Debug);
    proxy_wasm::set_root_context(|context_id| -> Box<dyn RootContext> {
        log::warn!("[OG-INIT] Creating RootContext, context_id={}", context_id);
        Box::new(OGConnectorRoot::new())
    });
}}

const PLUGIN_NAME: &str = "og-connector";

// ============= Configuration =============

// Higress wraps config in _rules_ array
#[derive(Debug, Clone, Deserialize, Default)]
struct HigressConfig {
    #[serde(default, rename = "_rules_")]
    rules: Vec<RuleConfig>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct RuleConfig {
    #[serde(default, rename = "_match_route_")]
    match_route: Vec<String>,
    #[serde(flatten)]
    config: OGConnectorConfig,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct OGConnectorConfig {
    #[serde(default)]
    og_cluster: String,
    #[serde(default)]
    og_base_url: String,
    #[serde(default)]
    og_api_key: String,
    #[serde(default)]
    application_id: String,
    #[serde(default = "default_timeout")]
    timeout_ms: u64,
    #[serde(default = "default_true")]
    enable_input_detection: bool,
    #[serde(default = "default_true")]
    enable_output_detection: bool,
}

fn default_timeout() -> u64 { 5000 }
fn default_true() -> bool { true }

// ============= OG API Types =============

#[derive(Debug, Serialize)]
struct OGInputRequest {
    messages: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    application_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OGInputResponse {
    action: String,
    request_id: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    restore_mapping: Option<HashMap<String, String>>,  // Mapping for restoration (preferred over session_id)
    #[serde(default)]
    detection_result: serde_json::Value,
    #[serde(default)]
    block_response: Option<BlockResponse>,
    #[serde(default)]
    replace_response: Option<ReplaceResponse>,
    #[serde(default)]
    anonymized_messages: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    proxy_response: Option<ProxyResponse>,  // Response from private model (proxy_response action)
    #[serde(default)]
    private_model: Option<PrivateModelInfo>,  // Private model info for switch_private_model action
    #[serde(default)]
    bypass_token: Option<String>,  // Bypass token to skip detection on private model
    #[serde(default)]
    bypass_header: Option<String>,  // Header name for bypass token (default: X-OG-Bypass-Token)
}

#[derive(Debug, Deserialize)]
struct ProxyResponse {
    code: u16,
    content_type: String,
    body: String,
}

#[derive(Debug, Deserialize)]
struct PrivateModelInfo {
    api_base_url: String,
    api_key: Option<String>,
    model_name: String,
    provider: Option<String>,
    higress_cluster: Option<String>,  // Higress cluster for routing
}

#[derive(Debug, Serialize)]
struct OGOutputRequest {
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    restore_mapping: Option<HashMap<String, String>>,  // Mapping for restoration (preferred over session_id)
    #[serde(skip_serializing_if = "Option::is_none")]
    application_id: Option<String>,
    /// Input messages as context for output detection
    #[serde(skip_serializing_if = "Option::is_none")]
    messages: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
struct OGOutputResponse {
    action: String,
    #[serde(default)]
    block_response: Option<BlockResponse>,
    #[serde(default)]
    restored_content: Option<String>,
    #[serde(default)]
    anonymized_content: Option<String>,  // For output anonymization
}

#[derive(Debug, Deserialize)]
struct BlockResponse {
    code: u16,
    content_type: String,
    body: String,
}

#[derive(Debug, Deserialize)]
struct ReplaceResponse {
    code: u16,
    content_type: String,
    body: String,
}

// ============= Plugin State =============

#[derive(Debug, Clone, PartialEq)]
enum ConnectorState {
    Initial,
    WaitingInputResponse,
    WaitingOutputResponse,
    Done,
}

// ============= Root Context =============

struct OGConnectorRoot {
    config: Option<OGConnectorConfig>,
}

impl OGConnectorRoot {
    fn new() -> Self {
        OGConnectorRoot { config: None }
    }
}

impl Context for OGConnectorRoot {}

impl RootContext for OGConnectorRoot {
    fn on_configure(&mut self, plugin_configuration_size: usize) -> bool {
        log::error!("[OG-CONFIG] ========== ON_CONFIGURE START ==========");
        log::error!("[OG-CONFIG] on_configure called, plugin_configuration_size={}", plugin_configuration_size);

        // Step 1: Check if we can get plugin configuration
        let config_bytes = self.get_plugin_configuration();
        log::error!("[OG-CONFIG] Step 1: get_plugin_configuration() returned: has_data={}", config_bytes.is_some());

        if config_bytes.is_none() {
            log::error!("[OG-CONFIG] FATAL: get_plugin_configuration() returned None!");
            log::error!("[OG-CONFIG] This means Higress did not pass any configuration to the plugin.");
            log::error!("[OG-CONFIG] Please check your WasmPlugin CRD has 'defaultConfig' or 'pluginConfig' section.");
            log::error!("[OG-CONFIG] ========== ON_CONFIGURE END (NO CONFIG) ==========");
            return true;
        }

        let config_bytes = config_bytes.unwrap();
        log::error!("[OG-CONFIG] Step 2: Config bytes received, length={}", config_bytes.len());

        // Step 2: Check if config is empty
        if config_bytes.is_empty() {
            log::error!("[OG-CONFIG] FATAL: Config bytes is empty (length=0)!");
            log::error!("[OG-CONFIG] ========== ON_CONFIGURE END (EMPTY CONFIG) ==========");
            return true;
        }

        // Step 3: Convert to string and log FULL content (for debugging)
        let config_str = String::from_utf8_lossy(&config_bytes);
        log::error!("[OG-CONFIG] Step 3: Raw config string (FULL, length={}):", config_str.len());

        // Log in chunks to avoid log truncation
        let chunk_size = 500;
        for (i, chunk) in config_str.as_bytes().chunks(chunk_size).enumerate() {
            let chunk_str = String::from_utf8_lossy(chunk);
            log::error!("[OG-CONFIG] Raw config chunk[{}]: {}", i, chunk_str);
        }

        // Step 4: Try to parse as generic JSON first to see structure
        log::error!("[OG-CONFIG] Step 4: Attempting to parse as generic JSON...");
        match serde_json::from_slice::<serde_json::Value>(&config_bytes) {
            Ok(json_value) => {
                log::error!("[OG-CONFIG] Step 4a: Valid JSON! Type: {}",
                    if json_value.is_object() { "object" }
                    else if json_value.is_array() { "array" }
                    else if json_value.is_string() { "string" }
                    else if json_value.is_null() { "null" }
                    else { "other" }
                );

                if let Some(obj) = json_value.as_object() {
                    log::error!("[OG-CONFIG] Step 4b: JSON object keys: {:?}", obj.keys().collect::<Vec<_>>());

                    // Check for _rules_ key
                    if obj.contains_key("_rules_") {
                        log::error!("[OG-CONFIG] Step 4c: Found '_rules_' key - this is Higress format");
                        if let Some(rules) = obj.get("_rules_").and_then(|v| v.as_array()) {
                            log::error!("[OG-CONFIG] Step 4d: _rules_ array length={}", rules.len());
                            for (i, rule) in rules.iter().enumerate() {
                                log::error!("[OG-CONFIG] Step 4e: Rule[{}] = {}", i, rule);
                            }
                        }
                    } else {
                        log::error!("[OG-CONFIG] Step 4c: No '_rules_' key - trying direct format");
                        // Log each top-level key
                        for (key, value) in obj.iter() {
                            log::error!("[OG-CONFIG] Step 4d: Config key '{}' = {}", key, value);
                        }
                    }
                }
            }
            Err(e) => {
                log::error!("[OG-CONFIG] Step 4: FAILED to parse as JSON! Error: {}", e);
                log::error!("[OG-CONFIG] This is not valid JSON. Raw bytes (hex): {:?}",
                    config_bytes.iter().take(100).map(|b| format!("{:02x}", b)).collect::<Vec<_>>());
            }
        }

        // Step 5: Try to parse as Higress format with _rules_
        log::error!("[OG-CONFIG] Step 5: Attempting to parse as HigressConfig (with _rules_)...");
        match serde_json::from_slice::<HigressConfig>(&config_bytes) {
            Ok(higress_config) => {
                log::error!("[OG-CONFIG] Step 5a: SUCCESS parsing as HigressConfig!");
                log::error!("[OG-CONFIG] Step 5b: rules_count={}", higress_config.rules.len());

                if higress_config.rules.is_empty() {
                    log::error!("[OG-CONFIG] Step 5c: WARNING - _rules_ array is empty!");
                    log::error!("[OG-CONFIG] Trying to parse as direct config format instead...");
                } else {
                    // Get first rule's config
                    let rule = &higress_config.rules[0];
                    log::error!("[OG-CONFIG] Step 5c: First rule match_route={:?}", rule.match_route);
                    log::error!("[OG-CONFIG] Step 5d: First rule config:");
                    log::error!("[OG-CONFIG]   og_cluster={}", rule.config.og_cluster);
                    log::error!("[OG-CONFIG]   og_base_url={}", rule.config.og_base_url);
                    log::error!("[OG-CONFIG]   og_api_key={} (length={})",
                        if rule.config.og_api_key.len() > 10 {
                            format!("{}...{}", &rule.config.og_api_key[..6], &rule.config.og_api_key[rule.config.og_api_key.len()-4..])
                        } else {
                            "***".to_string()
                        },
                        rule.config.og_api_key.len());
                    log::error!("[OG-CONFIG]   application_id={}", rule.config.application_id);
                    log::error!("[OG-CONFIG]   timeout_ms={}", rule.config.timeout_ms);
                    log::error!("[OG-CONFIG]   enable_input_detection={}", rule.config.enable_input_detection);
                    log::error!("[OG-CONFIG]   enable_output_detection={}", rule.config.enable_output_detection);

                    self.config = Some(rule.config.clone());
                    log::error!("[OG-CONFIG] Step 5e: Config stored successfully!");
                    log::error!("[OG-CONFIG] ========== ON_CONFIGURE END (SUCCESS - HIGRESS FORMAT) ==========");
                    return true;
                }
            }
            Err(e) => {
                log::error!("[OG-CONFIG] Step 5: Failed to parse as HigressConfig: {}", e);
            }
        }

        // Step 6: Try direct config format as fallback
        log::error!("[OG-CONFIG] Step 6: Attempting to parse as direct OGConnectorConfig...");
        match serde_json::from_slice::<OGConnectorConfig>(&config_bytes) {
            Ok(config) => {
                log::error!("[OG-CONFIG] Step 6a: SUCCESS parsing as direct config!");
                log::error!("[OG-CONFIG] Step 6b: Config values:");
                log::error!("[OG-CONFIG]   og_cluster={}", config.og_cluster);
                log::error!("[OG-CONFIG]   og_base_url={}", config.og_base_url);
                log::error!("[OG-CONFIG]   og_api_key={} (length={})",
                    if config.og_api_key.len() > 10 {
                        format!("{}...{}", &config.og_api_key[..6], &config.og_api_key[config.og_api_key.len()-4..])
                    } else {
                        "***".to_string()
                    },
                    config.og_api_key.len());
                log::error!("[OG-CONFIG]   application_id={}", config.application_id);
                log::error!("[OG-CONFIG]   timeout_ms={}", config.timeout_ms);
                log::error!("[OG-CONFIG]   enable_input_detection={}", config.enable_input_detection);
                log::error!("[OG-CONFIG]   enable_output_detection={}", config.enable_output_detection);

                self.config = Some(config);
                log::error!("[OG-CONFIG] Step 6c: Config stored successfully!");
                log::error!("[OG-CONFIG] ========== ON_CONFIGURE END (SUCCESS - DIRECT FORMAT) ==========");
                return true;
            }
            Err(e) => {
                log::error!("[OG-CONFIG] Step 6: Failed to parse as direct config: {}", e);
            }
        }

        // Step 7: All parsing attempts failed
        log::error!("[OG-CONFIG] FATAL: All parsing attempts failed!");
        log::error!("[OG-CONFIG] Expected format 1 (Higress): {{\"_rules_\": [{{\"og_cluster\": \"...\", \"og_base_url\": \"...\", ...}}]}}");
        log::error!("[OG-CONFIG] Expected format 2 (Direct): {{\"og_cluster\": \"...\", \"og_base_url\": \"...\", ...}}");
        log::error!("[OG-CONFIG] ========== ON_CONFIGURE END (PARSE FAILED) ==========");
        true
    }

    fn create_http_context(&self, context_id: u32) -> Option<Box<dyn HttpContext>> {
        let has_config = self.config.is_some();
        log::warn!("[OG-CTX] create_http_context: context_id={}, has_config={}", context_id, has_config);

        if !has_config {
            log::error!("[OG-CTX] WARNING: No config available for context_id={}", context_id);
        }

        Some(Box::new(OGConnector {
            context_id,
            config: self.config.clone(),
            state: ConnectorState::Initial,
            request_body: Vec::new(),
            response_body: Vec::new(),
            session_id: None,
            restore_mapping: None,
            is_streaming: false,
            input_messages: None,
            bypassed: false,
            pending_proxy_response: None,
            response_sent: false,
            consumer_id: None,
        }))
    }

    fn get_type(&self) -> Option<ContextType> {
        Some(ContextType::HttpContext)
    }
}

// ============= HTTP Context =============

struct OGConnector {
    context_id: u32,
    config: Option<OGConnectorConfig>,
    state: ConnectorState,
    request_body: Vec<u8>,
    response_body: Vec<u8>,
    session_id: Option<String>,
    restore_mapping: Option<HashMap<String, String>>,  // Mapping for restoration
    is_streaming: bool,
    /// Store original input messages for output detection context
    input_messages: Option<Vec<serde_json::Value>>,
    /// Whether this request has bypass token (skip detection for private model)
    bypassed: bool,
    /// Pending proxy response waiting for output detection
    pending_proxy_response: Option<ProxyResponse>,
    /// Whether we've already sent a response (to prevent duplicate responses)
    response_sent: bool,
    /// Consumer ID from gateway (e.g., x-mse-consumer from Higress)
    consumer_id: Option<String>,
}

impl OGConnector {
    /// Send a local HTTP response and terminate the request processing.
    /// This method ensures proper cleanup and prevents the request from continuing to upstream.
    fn send_local_response(&mut self, status_code: u32, content_type: &str, body: &[u8]) {
        log::warn!("[OG-LOCAL-RSP] Sending local response: ctx={}, status={}, body_len={}",
            self.context_id, status_code, body.len());

        // Set flag to indicate we've sent a response
        self.response_sent = true;
        self.state = ConnectorState::Done;

        // Clear the request body buffer to prevent it from being forwarded to upstream
        // This is critical: even after send_http_response, Envoy might try to forward the buffered body
        self.set_http_request_body(0, i32::MAX as usize, &[]);

        // Send the local response to the downstream client
        self.send_http_response(
            status_code,
            vec![("content-type", content_type)],
            Some(body),
        );

        log::warn!("[OG-LOCAL-RSP] Local response sent, request terminated: ctx={}", self.context_id);
    }

    fn call_og_api(&self, path: &str, body: &[u8]) -> Result<u32, proxy_wasm::types::Status> {
        log::warn!("[OG-API] call_og_api START: ctx={}, path={}", self.context_id, path);

        let config = match self.config.as_ref() {
            Some(c) => c,
            None => {
                log::error!("[OG-API] FATAL: No config available in call_og_api, ctx={}", self.context_id);
                return Err(proxy_wasm::types::Status::InternalFailure);
            }
        };

        // og_cluster already contains full cluster name like "outbound|5002||openguardrails-local.dns"
        let cluster = &config.og_cluster;

        // Extract host from og_base_url (remove http:// or https://)
        let host = config.og_base_url
            .trim_start_matches("http://")
            .trim_start_matches("https://");

        // Mask API key for logging (show first 10 and last 4 chars)
        let api_key_masked = if config.og_api_key.len() > 14 {
            format!("{}...{}", &config.og_api_key[..10], &config.og_api_key[config.og_api_key.len()-4..])
        } else {
            "***".to_string()
        };

        log::warn!("[OG-API] dispatch_http_call PARAMS: ctx={}, cluster='{}', host='{}', path='{}', api_key={}, body_len={}, timeout_ms={}, consumer_id={:?}",
            self.context_id, cluster, host, path, api_key_masked, body.len(), config.timeout_ms, self.consumer_id);

        // Log body preview (first 200 chars) for debugging
        let body_preview = String::from_utf8_lossy(body);
        log::warn!("[OG-API] Request body preview: {}", safe_truncate(&body_preview, 200));

        // Build headers - include consumer ID if present for auto-discovery
        let auth_header = format!("Bearer {}", config.og_api_key);
        let mut headers = vec![
            (":method", "POST"),
            (":path", path),
            (":authority", host),
            ("content-type", "application/json"),
            ("authorization", auth_header.as_str()),
        ];

        // Add application ID header for automatic application discovery in OG
        let consumer_id_owned = self.consumer_id.clone();
        if let Some(ref consumer) = consumer_id_owned {
            headers.push(("X-OG-Application-ID", consumer.as_str()));
            log::info!("[OG-API] Adding X-OG-Application-ID header: ctx={}, app_id={}", self.context_id, consumer);
        }

        let result = self.dispatch_http_call(
            &cluster,
            headers,
            Some(body),
            vec![],
            Duration::from_millis(config.timeout_ms),
        );

        match &result {
            Ok(token_id) => {
                log::warn!("[OG-API] dispatch_http_call SUCCESS: ctx={}, token_id={}", self.context_id, token_id);
            }
            Err(status) => {
                log::error!("[OG-API] dispatch_http_call FAILED: ctx={}, status={:?}", self.context_id, status);
                log::error!("[OG-API] Check if cluster '{}' exists in Envoy config. Run: curl localhost:15000/clusters | grep '{}'",
                    cluster, cluster.split("||").last().unwrap_or(cluster));
            }
        }

        result
    }

    fn parse_messages(&self, body: &[u8]) -> Option<Vec<serde_json::Value>> {
        let json: serde_json::Value = serde_json::from_slice(body).ok()?;
        json.get("messages")?.as_array().cloned()
    }

    fn check_streaming(&self, body: &[u8]) -> bool {
        if let Ok(json) = serde_json::from_slice::<serde_json::Value>(body) {
            json.get("stream").and_then(|v| v.as_bool()).unwrap_or(false)
        } else {
            false
        }
    }

    fn build_input_request(&self, messages: Vec<serde_json::Value>) -> Vec<u8> {
        let config = self.config.as_ref().unwrap();
        let request = OGInputRequest {
            messages,
            application_id: if config.application_id.is_empty() {
                None
            } else {
                Some(config.application_id.clone())
            },
        };
        serde_json::to_vec(&request).unwrap_or_default()
    }

    fn build_output_request(&self, content: &str) -> Vec<u8> {
        let config = self.config.as_ref().unwrap();
        let request = OGOutputRequest {
            content: content.to_string(),
            session_id: self.session_id.clone(),
            restore_mapping: self.restore_mapping.clone(),  // Include mapping for restoration
            application_id: if config.application_id.is_empty() {
                None
            } else {
                Some(config.application_id.clone())
            },
            // Include input messages as context for output detection
            messages: self.input_messages.clone(),
        };
        serde_json::to_vec(&request).unwrap_or_default()
    }

    fn rebuild_request_body(&self, messages: &[serde_json::Value]) -> Vec<u8> {
        if let Ok(mut json) = serde_json::from_slice::<serde_json::Value>(&self.request_body) {
            json["messages"] = serde_json::Value::Array(messages.to_vec());
            serde_json::to_vec(&json).unwrap_or_else(|_| self.request_body.clone())
        } else {
            self.request_body.clone()
        }
    }

    fn rebuild_response_body(&self, new_content: &str) -> Vec<u8> {
        if let Ok(mut json) = serde_json::from_slice::<serde_json::Value>(&self.response_body) {
            // Update content in choices[0].message.content
            if let Some(choices) = json.get_mut("choices").and_then(|c| c.as_array_mut()) {
                if let Some(first_choice) = choices.get_mut(0) {
                    if let Some(message) = first_choice.get_mut("message") {
                        message["content"] = serde_json::Value::String(new_content.to_string());
                    }
                }
            }
            serde_json::to_vec(&json).unwrap_or_else(|_| self.response_body.clone())
        } else {
            self.response_body.clone()
        }
    }

    fn extract_response_content(&self) -> Option<String> {
        let json: serde_json::Value = serde_json::from_slice(&self.response_body).ok()?;
        json.get("choices")?
            .get(0)?
            .get("message")?
            .get("content")?
            .as_str()
            .map(|s| s.to_string())
    }

    /// Extract content from a proxy response body (OpenAI format)
    fn extract_content_from_body(body: &str) -> Option<String> {
        let json: serde_json::Value = serde_json::from_str(body).ok()?;
        json.get("choices")?
            .get(0)?
            .get("message")?
            .get("content")?
            .as_str()
            .map(|s| s.to_string())
    }

    /// Rebuild proxy response body with new content
    fn rebuild_proxy_response_body(original_body: &str, new_content: &str) -> String {
        if let Ok(mut json) = serde_json::from_str::<serde_json::Value>(original_body) {
            if let Some(choices) = json.get_mut("choices").and_then(|c| c.as_array_mut()) {
                if let Some(first_choice) = choices.get_mut(0) {
                    if let Some(message) = first_choice.get_mut("message") {
                        message["content"] = serde_json::Value::String(new_content.to_string());
                    }
                }
            }
            serde_json::to_string(&json).unwrap_or_else(|_| original_body.to_string())
        } else {
            original_body.to_string()
        }
    }

    fn handle_input_response(&mut self, body: &[u8]) -> Action {
        log::warn!("[OG-INPUT-RSP] handle_input_response: ctx={}, body_len={}", self.context_id, body.len());

        let response: OGInputResponse = match serde_json::from_slice(body) {
            Ok(r) => r,
            Err(e) => {
                log::error!("[OG-INPUT-RSP] Failed to parse response: ctx={}, error={}", self.context_id, e);
                // Log raw body for debugging
                let raw = String::from_utf8_lossy(body);
                log::error!("[OG-INPUT-RSP] Raw body: {}", raw);
                self.resume_http_request();
                return Action::Continue;
            }
        };

        log::warn!("[OG-INPUT-RSP] Parsed response: ctx={}, action={}, request_id={}, session_id={:?}, restore_mapping_count={:?}",
            self.context_id, response.action, response.request_id, response.session_id,
            response.restore_mapping.as_ref().map(|m| m.len()));

        // Save session_id and restore_mapping for response restoration
        self.session_id = response.session_id;
        self.restore_mapping = response.restore_mapping;

        match response.action.as_str() {
            "block" => {
                log::warn!("[OG-INPUT-RSP] Action=BLOCK: ctx={}", self.context_id);
                if let Some(block_resp) = response.block_response {
                    log::warn!("[OG-INPUT-RSP] Sending block response: ctx={}, code={}, body_len={}",
                        self.context_id, block_resp.code, block_resp.body.len());
                    self.send_local_response(
                        block_resp.code as u32,
                        &block_resp.content_type,
                        block_resp.body.as_bytes(),
                    );
                } else {
                    log::error!("[OG-INPUT-RSP] Block action but no block_response: ctx={}", self.context_id);
                    self.state = ConnectorState::Done;
                }
                Action::Pause
            }
            "replace" => {
                log::warn!("[OG-INPUT-RSP] Action=REPLACE: ctx={}", self.context_id);
                if let Some(replace_resp) = response.replace_response {
                    log::warn!("[OG-INPUT-RSP] Sending replace response: ctx={}, code={}, body_len={}",
                        self.context_id, replace_resp.code, replace_resp.body.len());
                    self.send_local_response(
                        replace_resp.code as u32,
                        &replace_resp.content_type,
                        replace_resp.body.as_bytes(),
                    );
                } else {
                    log::error!("[OG-INPUT-RSP] Replace action but no replace_response: ctx={}", self.context_id);
                    self.state = ConnectorState::Done;
                }
                Action::Pause
            }
            "anonymize" => {
                log::warn!("[OG-INPUT-RSP] Action=ANONYMIZE: ctx={}, session_id={:?}, restore_mapping_count={:?}",
                    self.context_id, self.session_id, self.restore_mapping.as_ref().map(|m| m.len()));
                // Keep state as Initial to allow response processing for restoration
                self.state = ConnectorState::Initial;

                if let Some(messages) = response.anonymized_messages {
                    let new_body = self.rebuild_request_body(&messages);
                    log::warn!("[OG-INPUT-RSP] Replacing body: ctx={}, old_len={}, new_len={}",
                        self.context_id, self.request_body.len(), new_body.len());

                    // Use i32::MAX to replace entire body (like higress_wasm_rust framework)
                    self.set_http_request_body(0, i32::MAX as usize, &new_body);
                } else {
                    log::warn!("[OG-INPUT-RSP] Anonymize action but no anonymized_messages: ctx={}", self.context_id);
                }
                log::warn!("[OG-INPUT-RSP] Resuming request: ctx={}", self.context_id);
                self.resume_http_request();
                Action::Continue
            }
            "proxy_response" => {
                // OG backend has proxied the request to private model and returned the response
                log::warn!("[OG-INPUT-RSP] Action=PROXY_RESPONSE: ctx={}", self.context_id);

                if let Some(proxy_resp) = response.proxy_response {
                    log::warn!("[OG-INPUT-RSP] Private model response: ctx={}, code={}, body_len={}",
                        self.context_id, proxy_resp.code, proxy_resp.body.len());

                    // Check if output detection is enabled
                    let config = self.config.as_ref().unwrap();
                    if config.enable_output_detection {
                        // Extract content from proxy response for output detection
                        if let Some(content) = Self::extract_content_from_body(&proxy_resp.body) {
                            log::warn!("[OG-INPUT-RSP] Output detection enabled, calling process-output: ctx={}, content_len={}",
                                self.context_id, content.len());

                            // Store proxy response for later use after output detection
                            self.pending_proxy_response = Some(proxy_resp);

                            // Build and send output detection request
                            let request_body = self.build_output_request(&content);
                            match self.call_og_api("/v1/gateway/process-output", &request_body) {
                                Ok(token_id) => {
                                    log::warn!("[OG-INPUT-RSP] Output detection dispatched: ctx={}, token_id={}",
                                        self.context_id, token_id);
                                    self.state = ConnectorState::WaitingOutputResponse;
                                    return Action::Pause;
                                }
                                Err(e) => {
                                    log::error!("[OG-INPUT-RSP] Output detection call failed: ctx={}, error={:?}, returning proxy response directly",
                                        self.context_id, e);
                                    // Fall through to return proxy response directly
                                    let pending = self.pending_proxy_response.take().unwrap();
                                    self.send_local_response(
                                        pending.code as u32,
                                        &pending.content_type,
                                        pending.body.as_bytes(),
                                    );
                                    return Action::Pause;
                                }
                            }
                        } else {
                            log::warn!("[OG-INPUT-RSP] Could not extract content from proxy response, returning directly: ctx={}",
                                self.context_id);
                        }
                    }

                    // Output detection disabled or could not extract content - return proxy response directly
                    log::warn!("[OG-INPUT-RSP] Returning private model response directly: ctx={}", self.context_id);
                    self.send_local_response(
                        proxy_resp.code as u32,
                        &proxy_resp.content_type,
                        proxy_resp.body.as_bytes(),
                    );
                } else {
                    log::error!("[OG-INPUT-RSP] proxy_response action but no proxy_response: ctx={}", self.context_id);
                    self.state = ConnectorState::Done;
                }
                Action::Pause
            }
            "switch_private_model" => {
                // Switch to private model - plugin handles the request, supports streaming
                log::warn!("[OG-INPUT-RSP] Action=SWITCH_PRIVATE_MODEL: ctx={}", self.context_id);

                // Add bypass token header to skip detection on private model request
                if let Some(bypass_token) = &response.bypass_token {
                    let header_name = response.bypass_header.as_deref().unwrap_or("X-OG-Bypass-Token");
                    log::warn!("[OG-INPUT-RSP] Adding bypass header: ctx={}, header={}", self.context_id, header_name);
                    self.set_http_request_header(header_name, Some(bypass_token));
                }

                // Switch to private model
                if let Some(private_model) = &response.private_model {
                    log::warn!("[OG-INPUT-RSP] Switching to private model: ctx={}, model={}, provider={:?}, cluster={:?}",
                        self.context_id, private_model.model_name, private_model.provider, private_model.higress_cluster);

                    // 1. Replace Authorization header with private model's API key
                    if let Some(api_key) = &private_model.api_key {
                        let auth_value = format!("Bearer {}", api_key);
                        log::warn!("[OG-INPUT-RSP] Replacing Authorization header: ctx={}, key_len={}",
                            self.context_id, api_key.len());
                        self.set_http_request_header("authorization", Some(&auth_value));
                    }

                    // 2. Set provider header for Higress AI routing (if provider is specified)
                    if let Some(provider) = &private_model.provider {
                        log::warn!("[OG-INPUT-RSP] Setting provider header: ctx={}, provider={}", self.context_id, provider);
                        self.set_http_request_header("x-higress-llm-provider", Some(provider));
                    }

                    // 3. Set model header for Higress AI routing
                    log::warn!("[OG-INPUT-RSP] Setting model header: ctx={}, model={}", self.context_id, private_model.model_name);
                    self.set_http_request_header("x-higress-llm-model", Some(&private_model.model_name));

                    // 4. Switch to private model cluster if specified (fallback routing)
                    if let Some(cluster) = &private_model.higress_cluster {
                        log::warn!("[OG-INPUT-RSP] Setting cluster property: ctx={}, cluster={}", self.context_id, cluster);
                        self.set_property(vec!["cluster_name"], Some(cluster.as_bytes()));
                    }

                    // 5. Update model name in request body
                    if !self.request_body.is_empty() {
                        if let Ok(mut body_json) = serde_json::from_slice::<serde_json::Value>(&self.request_body) {
                            body_json["model"] = serde_json::Value::String(private_model.model_name.clone());
                            if let Ok(new_body) = serde_json::to_vec(&body_json) {
                                log::warn!("[OG-INPUT-RSP] Updated request body with new model: ctx={}, model={}",
                                    self.context_id, private_model.model_name);
                                self.set_http_request_body(0, i32::MAX as usize, &new_body);
                            }
                        }
                    }
                } else {
                    log::error!("[OG-INPUT-RSP] switch_private_model action but no private_model info: ctx={}", self.context_id);
                }

                // Resume request - it will be routed to private model, with streaming support
                self.state = ConnectorState::Initial;
                self.resume_http_request();
                Action::Continue
            }
            _ => {
                // "pass" action - just resume
                log::warn!("[OG-INPUT-RSP] Action=PASS: ctx={}, resuming request", self.context_id);
                // Keep state as Initial to allow response processing
                self.state = ConnectorState::Initial;
                self.resume_http_request();
                Action::Continue
            }
        }
    }

    fn handle_output_response(&mut self, body: &[u8]) -> Action {
        log::warn!("[OG-OUTPUT-RSP] handle_output_response: ctx={}, body_len={}, has_pending_proxy={}",
            self.context_id, body.len(), self.pending_proxy_response.is_some());

        let response: OGOutputResponse = match serde_json::from_slice(body) {
            Ok(r) => r,
            Err(e) => {
                log::error!("[OG-OUTPUT-RSP] Failed to parse response: ctx={}, error={}", self.context_id, e);
                let raw = String::from_utf8_lossy(body);
                log::error!("[OG-OUTPUT-RSP] Raw body: {}", raw);

                // If we have a pending proxy response, return it directly on parse error
                if let Some(proxy_resp) = self.pending_proxy_response.take() {
                    log::warn!("[OG-OUTPUT-RSP] Returning pending proxy response on parse error: ctx={}", self.context_id);
                    self.send_local_response(
                        proxy_resp.code as u32,
                        &proxy_resp.content_type,
                        proxy_resp.body.as_bytes(),
                    );
                    return Action::Pause;
                }

                self.resume_http_response();
                return Action::Continue;
            }
        };

        log::warn!("[OG-OUTPUT-RSP] Parsed response: ctx={}, action={}", self.context_id, response.action);

        // Check if this is output detection for a proxy response (private model)
        if let Some(proxy_resp) = self.pending_proxy_response.take() {
            // Handle output detection result for proxy response
            match response.action.as_str() {
                "block" => {
                    log::warn!("[OG-OUTPUT-RSP] Action=BLOCK for proxy response: ctx={}", self.context_id);
                    if let Some(block_resp) = response.block_response {
                        log::warn!("[OG-OUTPUT-RSP] Sending block response: ctx={}, body_len={}",
                            self.context_id, block_resp.body.len());
                        self.send_local_response(
                            block_resp.code as u32,
                            &block_resp.content_type,
                            block_resp.body.as_bytes(),
                        );
                    } else {
                        log::error!("[OG-OUTPUT-RSP] Block action but no block_response, returning original: ctx={}", self.context_id);
                        self.send_local_response(
                            proxy_resp.code as u32,
                            &proxy_resp.content_type,
                            proxy_resp.body.as_bytes(),
                        );
                    }
                }
                "restore" => {
                    log::warn!("[OG-OUTPUT-RSP] Action=RESTORE for proxy response: ctx={}", self.context_id);
                    if let Some(restored) = response.restored_content {
                        log::warn!("[OG-OUTPUT-RSP] Restoring content in proxy response: ctx={}, content_len={}",
                            self.context_id, restored.len());
                        let new_body = Self::rebuild_proxy_response_body(&proxy_resp.body, &restored);
                        log::warn!("[OG-OUTPUT-RSP] Sending restored proxy response: ctx={}, new_len={}",
                            self.context_id, new_body.len());
                        self.send_local_response(
                            proxy_resp.code as u32,
                            &proxy_resp.content_type,
                            new_body.as_bytes(),
                        );
                    } else {
                        log::warn!("[OG-OUTPUT-RSP] Restore action but no restored_content, returning original: ctx={}", self.context_id);
                        self.send_local_response(
                            proxy_resp.code as u32,
                            &proxy_resp.content_type,
                            proxy_resp.body.as_bytes(),
                        );
                    }
                }
                _ => {
                    // "pass" action - return proxy response as-is
                    log::warn!("[OG-OUTPUT-RSP] Action=PASS for proxy response: ctx={}", self.context_id);
                    self.send_local_response(
                        proxy_resp.code as u32,
                        &proxy_resp.content_type,
                        proxy_resp.body.as_bytes(),
                    );
                }
            }
            return Action::Pause;
        }

        // Normal upstream response handling
        match response.action.as_str() {
            "block" => {
                log::warn!("[OG-OUTPUT-RSP] Action=BLOCK: ctx={}", self.context_id);
                if let Some(block_resp) = response.block_response {
                    log::warn!("[OG-OUTPUT-RSP] Replacing response with block: ctx={}, body_len={}",
                        self.context_id, block_resp.body.len());
                    self.set_http_response_body(0, i32::MAX as usize, block_resp.body.as_bytes());
                } else {
                    log::error!("[OG-OUTPUT-RSP] Block action but no block_response: ctx={}", self.context_id);
                }
            }
            "anonymize" => {
                log::warn!("[OG-OUTPUT-RSP] Action=ANONYMIZE: ctx={}", self.context_id);
                if let Some(anonymized) = response.anonymized_content {
                    log::warn!("[OG-OUTPUT-RSP] Anonymizing content: ctx={}, content_len={}", self.context_id, anonymized.len());
                    let new_body = self.rebuild_response_body(&anonymized);
                    log::warn!("[OG-OUTPUT-RSP] New response body with anonymized content: ctx={}, new_len={}", self.context_id, new_body.len());
                    self.set_http_response_body(0, i32::MAX as usize, &new_body);
                } else {
                    log::error!("[OG-OUTPUT-RSP] Anonymize action but no anonymized_content: ctx={}", self.context_id);
                }
            }
            "restore" => {
                log::warn!("[OG-OUTPUT-RSP] Action=RESTORE: ctx={}", self.context_id);
                if let Some(restored) = response.restored_content {
                    log::warn!("[OG-OUTPUT-RSP] Restoring content: ctx={}, content_len={}", self.context_id, restored.len());
                    let new_body = self.rebuild_response_body(&restored);
                    log::warn!("[OG-OUTPUT-RSP] New response body: ctx={}, new_len={}", self.context_id, new_body.len());
                    self.set_http_response_body(0, i32::MAX as usize, &new_body);
                } else {
                    log::warn!("[OG-OUTPUT-RSP] Restore action but no restored_content: ctx={}", self.context_id);
                }
            }
            _ => {
                // "pass" action - no modification needed
                log::warn!("[OG-OUTPUT-RSP] Action=PASS: ctx={}, no modification", self.context_id);
            }
        }

        log::warn!("[OG-OUTPUT-RSP] Resuming response: ctx={}", self.context_id);
        self.resume_http_response();
        Action::Continue
    }
}

impl Context for OGConnector {
    fn on_http_call_response(
        &mut self,
        token_id: u32,
        num_headers: usize,
        body_size: usize,
        num_trailers: usize,
    ) {
        log::warn!("[OG-CALLBACK] on_http_call_response: ctx={}, token_id={}, num_headers={}, body_size={}, num_trailers={}, state={:?}",
            self.context_id, token_id, num_headers, body_size, num_trailers, self.state);

        // Check for HTTP status code first
        let status_ok = if let Some(status) = self.get_http_call_response_header(":status") {
            log::warn!("[OG-CALLBACK] HTTP response status: ctx={}, status={}", self.context_id, status);
            if status != "200" {
                log::error!("[OG-CALLBACK] Non-200 response from OG: ctx={}, status={}", self.context_id, status);
                // On timeout or error, resume original request/response without modification
                match self.state {
                    ConnectorState::WaitingInputResponse => {
                        log::warn!("[OG-CALLBACK] OG API error, resuming original request: ctx={}", self.context_id);
                        self.state = ConnectorState::Initial;
                        self.resume_http_request();
                    }
                    ConnectorState::WaitingOutputResponse => {
                        // If we have a pending proxy response, return it directly
                        if let Some(proxy_resp) = self.pending_proxy_response.take() {
                            log::warn!("[OG-CALLBACK] OG API error, returning pending proxy response: ctx={}", self.context_id);
                            self.send_local_response(
                                proxy_resp.code as u32,
                                &proxy_resp.content_type,
                                proxy_resp.body.as_bytes(),
                            );
                        } else {
                            log::warn!("[OG-CALLBACK] OG API error, resuming original response: ctx={}", self.context_id);
                            self.state = ConnectorState::Done;
                            self.resume_http_response();
                        }
                    }
                    _ => {}
                }
                return;
            }
            true
        } else {
            log::error!("[OG-CALLBACK] No status header in response: ctx={}", self.context_id);
            false
        };

        if !status_ok {
            return;
        }

        let body = match self.get_http_call_response_body(0, body_size) {
            Some(b) => {
                log::warn!("[OG-CALLBACK] Got response body: ctx={}, len={}", self.context_id, b.len());
                b
            }
            None => {
                log::error!("[OG-CALLBACK] Failed to get response body: ctx={}, body_size={}", self.context_id, body_size);
                vec![]
            }
        };

        // Log body preview for debugging
        let body_preview = String::from_utf8_lossy(&body);
        log::warn!("[OG-CALLBACK] Response body preview: ctx={}, body={}", self.context_id, safe_truncate(&body_preview, 300));

        match self.state {
            ConnectorState::WaitingInputResponse => {
                log::warn!("[OG-CALLBACK] Processing input response: ctx={}", self.context_id);
                // Don't set to Done yet - handle_input_response will set appropriate state
                self.handle_input_response(&body);
            }
            ConnectorState::WaitingOutputResponse => {
                log::warn!("[OG-CALLBACK] Processing output response: ctx={}", self.context_id);
                self.state = ConnectorState::Done;
                self.handle_output_response(&body);
            }
            _ => {
                log::error!("[OG-CALLBACK] Unexpected state: ctx={}, state={:?}", self.context_id, self.state);
            }
        }
    }
}

impl HttpContext for OGConnector {
    fn on_http_request_headers(&mut self, num_headers: usize, end_of_stream: bool) -> HeaderAction {
        log::warn!("[OG-REQ-HDR] on_http_request_headers: ctx={}, num_headers={}, end_of_stream={}, has_config={}",
            self.context_id, num_headers, end_of_stream, self.config.is_some());

        if self.config.is_none() {
            log::warn!("[OG-REQ-HDR] No config, passing through: ctx={}", self.context_id);
            return HeaderAction::Continue;
        }

        // Check for bypass token - skip detection for private model requests from OG
        if let Some(bypass_token) = self.get_http_request_header("X-OG-Bypass-Token") {
            log::warn!("[OG-REQ-HDR] BYPASS: Detected bypass token, skipping detection: ctx={}, token_len={}",
                self.context_id, bypass_token.len());
            self.bypassed = true;
            // Remove the bypass token header before forwarding to upstream
            self.set_http_request_header("X-OG-Bypass-Token", None);
            // Continue without detection - pass through directly
            return HeaderAction::Continue;
        }

        // Extract consumer ID from gateway (e.g., x-mse-consumer from Higress key-auth plugin)
        // This is used for automatic application discovery in OG
        // Try both lowercase and mixed-case header names for compatibility
        self.consumer_id = self.get_http_request_header("x-mse-consumer")
            .or_else(|| self.get_http_request_header("X-Mse-Consumer"));
        if let Some(ref consumer) = self.consumer_id {
            log::info!("[OG-REQ-HDR] Consumer ID from x-mse-consumer: ctx={}, consumer={}",
                self.context_id, consumer);
        }

        let path = self.get_http_request_header(":path").unwrap_or_default();
        let method = self.get_http_request_header(":method").unwrap_or_default();
        let authority = self.get_http_request_header(":authority").unwrap_or_default();

        log::warn!("[OG-REQ-HDR] Request: ctx={}, method={}, path={}, authority={}",
            self.context_id, method, path, authority);

        // Remove Content-Length header as we may modify the body
        self.set_http_request_header("content-length", None);

        log::warn!("[OG-REQ-HDR] Returning StopIteration to wait for body: ctx={}", self.context_id);
        HeaderAction::StopIteration
    }

    fn on_http_request_body(&mut self, body_size: usize, end_of_stream: bool) -> DataAction {
        log::warn!("[OG-REQ-BODY] on_http_request_body: ctx={}, body_size={}, end_of_stream={}, state={:?}, bypassed={}",
            self.context_id, body_size, end_of_stream, self.state, self.bypassed);

        // Skip input detection if this request was bypassed (private model from OG)
        if self.bypassed {
            log::warn!("[OG-REQ-BODY] BYPASS: Skipping input detection for bypassed request: ctx={}", self.context_id);
            return DataAction::Continue;
        }

        // Buffer until we receive end_of_stream
        if !end_of_stream {
            log::warn!("[OG-REQ-BODY] Buffering, not end of stream: ctx={}", self.context_id);
            return DataAction::StopIterationAndBuffer;
        }

        // Get the complete buffered body
        if let Some(body) = self.get_http_request_body(0, body_size) {
            self.request_body = body;
            log::warn!("[OG-REQ-BODY] Got complete body: ctx={}, len={}", self.context_id, self.request_body.len());
        } else {
            log::error!("[OG-REQ-BODY] Failed to get request body: ctx={}, body_size={}", self.context_id, body_size);
        }

        if self.config.is_none() {
            log::warn!("[OG-REQ-BODY] No config, passing through: ctx={}", self.context_id);
            return DataAction::Continue;
        }

        if self.request_body.is_empty() {
            log::warn!("[OG-REQ-BODY] Empty body, passing through: ctx={}", self.context_id);
            return DataAction::Continue;
        }

        let config = self.config.as_ref().unwrap();
        if !config.enable_input_detection {
            log::warn!("[OG-REQ-BODY] Input detection disabled, passing through: ctx={}", self.context_id);
            return DataAction::Continue;
        }

        let messages = match self.parse_messages(&self.request_body) {
            Some(m) => m,
            None => {
                log::warn!("[OG-REQ-BODY] No messages found in request, passing through: ctx={}", self.context_id);
                // Log body preview for debugging
                let preview = String::from_utf8_lossy(&self.request_body);
                log::warn!("[OG-REQ-BODY] Body preview: {}", safe_truncate(&preview, 200));
                return DataAction::Continue;
            }
        };

        // Store input messages for output detection context
        self.input_messages = Some(messages.clone());

        self.is_streaming = self.check_streaming(&self.request_body);
        log::warn!("[OG-REQ-BODY] Parsed {} messages, streaming={}: ctx={}", messages.len(), self.is_streaming, self.context_id);

        let request_body = self.build_input_request(messages);
        log::warn!("[OG-REQ-BODY] Built input request, calling OG API: ctx={}", self.context_id);

        match self.call_og_api("/v1/gateway/process-input", &request_body) {
            Ok(token_id) => {
                log::warn!("[OG-REQ-BODY] API call dispatched: ctx={}, token_id={}, state -> WaitingInputResponse",
                    self.context_id, token_id);
                self.state = ConnectorState::WaitingInputResponse;
                // Use StopIterationAndBuffer to keep body in Envoy's buffer
                DataAction::StopIterationAndBuffer
            }
            Err(e) => {
                log::error!("[OG-REQ-BODY] API call FAILED: ctx={}, error={:?}, passing through", self.context_id, e);
                DataAction::Continue
            }
        }
    }

    fn on_http_response_headers(&mut self, num_headers: usize, end_of_stream: bool) -> HeaderAction {
        log::warn!("[OG-RSP-HDR] on_http_response_headers: ctx={}, num_headers={}, end_of_stream={}, state={:?}, response_sent={}",
            self.context_id, num_headers, end_of_stream, self.state, self.response_sent);

        // If we already sent a local response, skip processing
        if self.response_sent {
            log::warn!("[OG-RSP-HDR] Response already sent, skipping: ctx={}", self.context_id);
            return HeaderAction::Continue;
        }

        // Remove Content-Length as we may modify the response
        self.set_http_response_header("content-length", None);
        HeaderAction::Continue
    }

    fn on_http_response_body(&mut self, body_size: usize, end_of_stream: bool) -> DataAction {
        log::warn!("[OG-RSP-BODY] on_http_response_body: ctx={}, body_size={}, end_of_stream={}, state={:?}, bypassed={}, response_sent={}",
            self.context_id, body_size, end_of_stream, self.state, self.bypassed, self.response_sent);

        // If we already sent a local response, skip processing
        if self.response_sent {
            log::warn!("[OG-RSP-BODY] Response already sent, skipping: ctx={}", self.context_id);
            return DataAction::Continue;
        }

        // If we already sent a block/replace response, don't process further
        if self.state == ConnectorState::Done {
            log::warn!("[OG-RSP-BODY] State is Done, passing through: ctx={}", self.context_id);
            return DataAction::Continue;
        }

        // Skip output detection if this request was bypassed (private model from OG)
        if self.bypassed {
            log::warn!("[OG-RSP-BODY] BYPASS: Skipping output detection for bypassed request: ctx={}", self.context_id);
            return DataAction::Continue;
        }

        // Buffer until we receive end_of_stream
        if !end_of_stream {
            log::warn!("[OG-RSP-BODY] Buffering, not end of stream: ctx={}", self.context_id);
            return DataAction::StopIterationAndBuffer;
        }

        // Get the complete buffered body
        if let Some(body) = self.get_http_response_body(0, body_size) {
            self.response_body = body;
            log::warn!("[OG-RSP-BODY] Got complete response body: ctx={}, len={}", self.context_id, self.response_body.len());
        } else {
            log::error!("[OG-RSP-BODY] Failed to get response body: ctx={}, body_size={}", self.context_id, body_size);
        }

        let config = match &self.config {
            Some(c) => c,
            None => {
                log::warn!("[OG-RSP-BODY] No config, passing through: ctx={}", self.context_id);
                return DataAction::Continue;
            }
        };

        // Skip output detection if disabled and no session (no anonymization was done)
        if !config.enable_output_detection && self.session_id.is_none() && self.restore_mapping.is_none() {
            log::warn!("[OG-RSP-BODY] Output detection disabled and no session/mapping, skipping: ctx={}", self.context_id);
            return DataAction::Continue;
        }

        let content = match self.extract_response_content() {
            Some(c) => c,
            None => {
                log::warn!("[OG-RSP-BODY] No content in response, passing through: ctx={}", self.context_id);
                // Log body preview for debugging
                let preview = String::from_utf8_lossy(&self.response_body);
                log::warn!("[OG-RSP-BODY] Response body preview: {}", safe_truncate(&preview, 200));
                return DataAction::Continue;
            }
        };

        log::warn!("[OG-RSP-BODY] Calling process-output: ctx={}, content_len={}, session_id={:?}, restore_mapping_count={:?}",
            self.context_id, content.len(), self.session_id, self.restore_mapping.as_ref().map(|m| m.len()));
        let request_body = self.build_output_request(&content);

        match self.call_og_api("/v1/gateway/process-output", &request_body) {
            Ok(token_id) => {
                log::warn!("[OG-RSP-BODY] API call dispatched: ctx={}, token_id={}, state -> WaitingOutputResponse",
                    self.context_id, token_id);
                self.state = ConnectorState::WaitingOutputResponse;
                DataAction::StopIterationAndBuffer
            }
            Err(e) => {
                log::error!("[OG-RSP-BODY] API call FAILED: ctx={}, error={:?}, passing through", self.context_id, e);
                DataAction::Continue
            }
        }
    }
}
