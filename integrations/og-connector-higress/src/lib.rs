// OpenGuardrails Connector Plugin for Higress
// Integrates OG security capabilities with anonymization and restoration

use lazy_static::lazy_static;
use proxy_wasm::traits::{Context, HttpContext, RootContext};
use proxy_wasm::types::{Action, ContextType, DataAction, HeaderAction, LogLevel};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

proxy_wasm::main! {{
    proxy_wasm::set_log_level(LogLevel::Warn);
    proxy_wasm::set_root_context(|_| -> Box<dyn RootContext> {
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
    // Private model routing configuration (for switch_private_model action)
    #[serde(default)]
    private_model_cluster: String,  // Higress cluster for private model (e.g., "outbound|8000||llm-4090.internal.dns")
    #[serde(default)]
    private_model_name: String,     // Model name to use with private model (e.g., "qwen2.5-72b")
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
    detection_result: serde_json::Value,
    #[serde(default)]
    block_response: Option<BlockResponse>,
    #[serde(default)]
    replace_response: Option<ReplaceResponse>,
    #[serde(default)]
    anonymized_messages: Option<Vec<serde_json::Value>>,
    // private_model field removed - we use plugin config's private_model_cluster instead
}

// PrivateModelInfo - no longer used since we use plugin config's private_model_cluster

#[derive(Debug, Serialize)]
struct OGOutputRequest {
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    application_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OGOutputResponse {
    action: String,
    #[serde(default)]
    block_response: Option<BlockResponse>,
    #[serde(default)]
    restored_content: Option<String>,
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
    fn on_configure(&mut self, _plugin_configuration_size: usize) -> bool {
        if let Some(config_bytes) = self.get_plugin_configuration() {
            // Try to parse as Higress format with _rules_
            match serde_json::from_slice::<HigressConfig>(&config_bytes) {
                Ok(higress_config) => {
                    // Get first rule's config (if any)
                    if let Some(rule) = higress_config.rules.first() {
                        log::info!("{} configured from rules: og_cluster={}, private_model_cluster={}, private_model_name={}",
                            PLUGIN_NAME, rule.config.og_cluster,
                            rule.config.private_model_cluster, rule.config.private_model_name);
                        self.config = Some(rule.config.clone());
                    } else {
                        log::warn!("{} no rules in config", PLUGIN_NAME);
                    }
                    true
                }
                Err(e) => {
                    // Try direct config format as fallback
                    match serde_json::from_slice::<OGConnectorConfig>(&config_bytes) {
                        Ok(config) => {
                            log::info!("{} configured directly: og_cluster={}, private_model_cluster={}, private_model_name={}",
                                PLUGIN_NAME, config.og_cluster,
                                config.private_model_cluster, config.private_model_name);
                            self.config = Some(config);
                            true
                        }
                        Err(e2) => {
                            log::error!("{} config parse error: {} / {}", PLUGIN_NAME, e, e2);
                            true
                        }
                    }
                }
            }
        } else {
            log::warn!("{} no configuration provided", PLUGIN_NAME);
            true
        }
    }

    fn create_http_context(&self, _context_id: u32) -> Option<Box<dyn HttpContext>> {
        Some(Box::new(OGConnector {
            config: self.config.clone(),
            state: ConnectorState::Initial,
            request_body: Vec::new(),
            response_body: Vec::new(),
            session_id: None,
            is_streaming: false,
        }))
    }

    fn get_type(&self) -> Option<ContextType> {
        Some(ContextType::HttpContext)
    }
}

// ============= HTTP Context =============

struct OGConnector {
    config: Option<OGConnectorConfig>,
    state: ConnectorState,
    request_body: Vec<u8>,
    response_body: Vec<u8>,
    session_id: Option<String>,
    is_streaming: bool,
}

impl OGConnector {
    fn call_og_api(&self, path: &str, body: &[u8]) -> Result<u32, proxy_wasm::types::Status> {
        let config = self.config.as_ref().unwrap();
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

        log::warn!("OG call_og_api: cluster={}, host={}, path={}, api_key={}, body_len={}",
            cluster, host, path, api_key_masked, body.len());

        self.dispatch_http_call(
            &cluster,
            vec![
                (":method", "POST"),
                (":path", path),
                (":authority", host),
                ("content-type", "application/json"),
                ("authorization", &format!("Bearer {}", config.og_api_key)),
            ],
            Some(body),
            vec![],
            Duration::from_millis(config.timeout_ms),
        )
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
            application_id: if config.application_id.is_empty() {
                None
            } else {
                Some(config.application_id.clone())
            },
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

    fn rebuild_request_with_model(&self, model_name: &str) -> Vec<u8> {
        if let Ok(mut json) = serde_json::from_slice::<serde_json::Value>(&self.request_body) {
            // Update the model field in the request
            json["model"] = serde_json::Value::String(model_name.to_string());
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

    fn handle_input_response(&mut self, body: &[u8]) -> Action {
        let response: OGInputResponse = match serde_json::from_slice(body) {
            Ok(r) => r,
            Err(e) => {
                log::error!("OG Failed to parse input response: {}", e);
                self.resume_http_request();
                return Action::Continue;
            }
        };

        log::warn!("OG handle_input_response: action={}, request_id={}",
            response.action, response.request_id);

        // Save session_id for response restoration
        self.session_id = response.session_id;

        match response.action.as_str() {
            "block" => {
                log::warn!("OG action=block");
                self.state = ConnectorState::Done;  // Terminal state - no response processing
                if let Some(block_resp) = response.block_response {
                    self.send_http_response(
                        block_resp.code as u32,
                        vec![("content-type", block_resp.content_type.as_str())],
                        Some(block_resp.body.as_bytes()),
                    );
                }
                Action::Pause
            }
            "replace" => {
                log::warn!("OG action=replace");
                self.state = ConnectorState::Done;  // Terminal state - no response processing
                if let Some(replace_resp) = response.replace_response {
                    self.send_http_response(
                        replace_resp.code as u32,
                        vec![("content-type", replace_resp.content_type.as_str())],
                        Some(replace_resp.body.as_bytes()),
                    );
                }
                Action::Pause
            }
            "anonymize" => {
                log::warn!("OG action=anonymize, session_id={:?}", self.session_id);
                // Keep state as Initial to allow response processing for restoration
                self.state = ConnectorState::Initial;

                if let Some(messages) = response.anonymized_messages {
                    let new_body = self.rebuild_request_body(&messages);
                    log::warn!("OG anonymize: replacing body, old_len={}, new_len={}",
                        self.request_body.len(), new_body.len());

                    // Use i32::MAX to replace entire body (like higress_wasm_rust framework)
                    self.set_http_request_body(0, i32::MAX as usize, &new_body);
                }
                self.resume_http_request();
                Action::Continue
            }
            "switch_private_model" => {
                log::warn!("OG action=switch_private_model");
                self.state = ConnectorState::Initial;

                let config = self.config.as_ref().unwrap();

                // Use plugin config's private model cluster (not OG backend's)
                if !config.private_model_cluster.is_empty() {
                    log::warn!("OG switching to private model: cluster={}, model={}",
                        config.private_model_cluster, config.private_model_name);

                    // Modify request body to use private model's model name (if configured)
                    if !config.private_model_name.is_empty() {
                        let new_body = self.rebuild_request_with_model(&config.private_model_name);
                        self.set_http_request_body(0, i32::MAX as usize, &new_body);
                    }

                    // Set x-higress-cluster header for cluster routing
                    self.set_http_request_header("x-higress-cluster", Some(&config.private_model_cluster));

                    log::warn!("OG private model routing set, cluster={}", config.private_model_cluster);
                } else {
                    log::warn!("OG no private_model_cluster configured in plugin, passing through");
                }

                self.resume_http_request();
                Action::Continue
            }
            _ => {
                // "pass" action - just resume
                log::warn!("OG action=pass, resuming request");
                // Keep state as Initial to allow response processing
                self.state = ConnectorState::Initial;
                self.resume_http_request();
                Action::Continue
            }
        }
    }

    fn handle_output_response(&mut self, body: &[u8]) -> Action {
        let response: OGOutputResponse = match serde_json::from_slice(body) {
            Ok(r) => r,
            Err(e) => {
                log::error!("OG Failed to parse output response: {}", e);
                self.resume_http_response();
                return Action::Continue;
            }
        };

        log::warn!("OG handle_output_response: action={}", response.action);

        match response.action.as_str() {
            "block" => {
                if let Some(block_resp) = response.block_response {
                    self.set_http_response_body(0, i32::MAX as usize, block_resp.body.as_bytes());
                }
            }
            "restore" => {
                if let Some(restored) = response.restored_content {
                    log::warn!("OG restoring content, len={}", restored.len());
                    let new_body = self.rebuild_response_body(&restored);
                    self.set_http_response_body(0, i32::MAX as usize, &new_body);
                }
            }
            _ => {
                // "pass" action - no modification needed
            }
        }

        self.resume_http_response();
        Action::Continue
    }
}

impl Context for OGConnector {
    fn on_http_call_response(
        &mut self,
        _token_id: u32,
        _num_headers: usize,
        body_size: usize,
        _num_trailers: usize,
    ) {
        let body = self.get_http_call_response_body(0, body_size).unwrap_or_default();

        log::warn!("OG on_http_call_response: state={:?}, body_size={}", self.state, body_size);

        match self.state {
            ConnectorState::WaitingInputResponse => {
                // Don't set to Done yet - handle_input_response will set appropriate state
                self.handle_input_response(&body);
            }
            ConnectorState::WaitingOutputResponse => {
                self.state = ConnectorState::Done;
                self.handle_output_response(&body);
            }
            _ => {
                log::warn!("OG unexpected state in on_http_call_response: {:?}", self.state);
            }
        }
    }
}

impl HttpContext for OGConnector {
    fn on_http_request_headers(&mut self, _num_headers: usize, end_of_stream: bool) -> HeaderAction {
        if self.config.is_none() {
            return HeaderAction::Continue;
        }

        let path = self.get_http_request_header(":path").unwrap_or_default();
        log::warn!("OG on_http_request_headers: path={}, end_of_stream={}", path, end_of_stream);

        // Remove Content-Length header as we may modify the body
        self.set_http_request_header("content-length", None);

        HeaderAction::StopIteration
    }

    fn on_http_request_body(&mut self, body_size: usize, end_of_stream: bool) -> DataAction {
        log::warn!("OG on_http_request_body: body_size={}, end_of_stream={}", body_size, end_of_stream);

        // Buffer until we receive end_of_stream
        if !end_of_stream {
            return DataAction::StopIterationAndBuffer;
        }

        // Get the complete buffered body
        if let Some(body) = self.get_http_request_body(0, body_size) {
            self.request_body = body;
            log::warn!("OG request_body received: {} bytes", self.request_body.len());
        }

        if self.config.is_none() || self.request_body.is_empty() {
            return DataAction::Continue;
        }

        let config = self.config.as_ref().unwrap();
        if !config.enable_input_detection {
            return DataAction::Continue;
        }

        let messages = match self.parse_messages(&self.request_body) {
            Some(m) => m,
            None => {
                log::warn!("OG No messages found in request, passing through");
                return DataAction::Continue;
            }
        };

        self.is_streaming = self.check_streaming(&self.request_body);
        log::warn!("OG parsed {} messages, streaming={}", messages.len(), self.is_streaming);

        let request_body = self.build_input_request(messages);

        match self.call_og_api("/v1/gateway/process-input", &request_body) {
            Ok(_) => {
                log::warn!("OG process-input API call dispatched successfully");
                self.state = ConnectorState::WaitingInputResponse;
                // Use StopIterationAndBuffer to keep body in Envoy's buffer
                DataAction::StopIterationAndBuffer
            }
            Err(e) => {
                log::error!("OG Failed to call process-input API: {:?}", e);
                DataAction::Continue
            }
        }
    }

    fn on_http_response_headers(&mut self, _num_headers: usize, _end_of_stream: bool) -> HeaderAction {
        // Remove Content-Length as we may modify the response
        self.set_http_response_header("content-length", None);
        HeaderAction::Continue
    }

    fn on_http_response_body(&mut self, body_size: usize, end_of_stream: bool) -> DataAction {
        log::warn!("OG on_http_response_body: body_size={}, end_of_stream={}, state={:?}",
            body_size, end_of_stream, self.state);

        // If we already sent a block/replace response, don't process further
        if self.state == ConnectorState::Done {
            return DataAction::Continue;
        }

        // Buffer until we receive end_of_stream
        if !end_of_stream {
            return DataAction::StopIterationAndBuffer;
        }

        // Get the complete buffered body
        if let Some(body) = self.get_http_response_body(0, body_size) {
            self.response_body = body;
        }

        let config = match &self.config {
            Some(c) => c,
            None => return DataAction::Continue,
        };

        // Skip output detection if disabled and no session (no anonymization was done)
        if !config.enable_output_detection && self.session_id.is_none() {
            log::warn!("OG output detection disabled and no session, skipping");
            return DataAction::Continue;
        }

        let content = match self.extract_response_content() {
            Some(c) => c,
            None => {
                log::warn!("OG No content found in response, passing through");
                return DataAction::Continue;
            }
        };

        log::warn!("OG calling process-output for content len={}, session_id={:?}",
            content.len(), self.session_id);
        let request_body = self.build_output_request(&content);

        match self.call_og_api("/v1/gateway/process-output", &request_body) {
            Ok(_) => {
                log::warn!("OG process-output API call dispatched successfully");
                self.state = ConnectorState::WaitingOutputResponse;
                DataAction::StopIterationAndBuffer
            }
            Err(e) => {
                log::error!("OG Failed to call process-output API: {:?}", e);
                DataAction::Continue
            }
        }
    }
}
