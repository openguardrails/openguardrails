/*!
OpenGuardrails API response types and utilities
*/

use serde::{Deserialize, Serialize};

/// Response from /v1/gateway/process-input
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OGInputResponse {
    /// Disposition action: block, anonymize, proxy_response, replace, pass
    pub action: String,

    /// Request ID for tracking
    #[serde(default)]
    pub request_id: String,

    /// Detection results summary
    #[serde(default)]
    pub detection_result: DetectionResult,

    /// Block response (when action = "block")
    #[serde(default)]
    pub block_response: Option<HttpResponse>,

    /// Replace response (when action = "replace")
    #[serde(default)]
    pub replace_response: Option<HttpResponse>,

    /// Anonymized messages (when action = "anonymize")
    #[serde(default)]
    pub anonymized_messages: Option<Vec<serde_json::Value>>,

    /// Session ID for restoration (when action = "anonymize")
    #[serde(default)]
    pub session_id: Option<String>,

    /// Processing time in milliseconds
    #[serde(default)]
    pub processing_time_ms: f64,
}

/// Response from /v1/gateway/process-output
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OGOutputResponse {
    /// Disposition action: block, replace, restore, pass
    pub action: String,

    /// Request ID for tracking
    #[serde(default)]
    pub request_id: String,

    /// Detection results summary
    #[serde(default)]
    pub detection_result: DetectionResult,

    /// Block response (when action = "block")
    #[serde(default)]
    pub block_response: Option<HttpResponse>,

    /// Replace response (when action = "replace")
    #[serde(default)]
    pub replace_response: Option<HttpResponse>,

    /// Restored content (when action = "restore")
    #[serde(default)]
    pub restored_content: Option<String>,

    /// Original content (when action = "pass")
    #[serde(default)]
    pub content: Option<String>,

    /// Buffer pending for streaming
    #[serde(default)]
    pub buffer_pending: Option<String>,

    /// Processing time in milliseconds
    #[serde(default)]
    pub processing_time_ms: f64,
}

/// Detection result summary
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DetectionResult {
    /// Whether blacklist was hit
    #[serde(default)]
    pub blacklist_hit: bool,

    /// Matched blacklist keywords
    #[serde(default)]
    pub blacklist_keywords: Vec<String>,

    /// Whether whitelist was hit
    #[serde(default)]
    pub whitelist_hit: bool,

    /// Data leakage risk
    #[serde(default)]
    pub data_risk: RiskInfo,

    /// Compliance risk
    #[serde(default)]
    pub compliance_risk: RiskInfo,

    /// Security risk
    #[serde(default)]
    pub security_risk: RiskInfo,

    /// Overall risk level
    #[serde(default)]
    pub overall_risk_level: String,

    /// Matched scanners
    #[serde(default)]
    pub matched_scanners: Vec<String>,

    /// Error message if any
    #[serde(default)]
    pub error: Option<String>,
}

/// Risk information for a category
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RiskInfo {
    /// Risk level: high_risk, medium_risk, low_risk, no_risk
    #[serde(default)]
    pub risk_level: String,

    /// Risk categories detected
    #[serde(default)]
    pub categories: Vec<String>,

    /// Entity count (for data_risk)
    #[serde(default)]
    pub entity_count: i32,
}

/// HTTP response structure for block/replace actions
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpResponse {
    /// HTTP status code
    pub code: u16,

    /// Content type header
    pub content_type: String,

    /// Response body
    pub body: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_input_response_block() {
        let json = r#"{
            "action": "block",
            "request_id": "gw-abc123",
            "detection_result": {
                "overall_risk_level": "high_risk",
                "security_risk": {
                    "risk_level": "high_risk",
                    "categories": ["S9"]
                }
            },
            "block_response": {
                "code": 200,
                "content_type": "application/json",
                "body": "{\"id\":\"chatcmpl-blocked-gw-abc123\",\"object\":\"chat.completion\",\"model\":\"openguardrails-security\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"Request blocked due to security policy.\"},\"finish_reason\":\"content_filter\"}],\"usage\":{\"prompt_tokens\":0,\"completion_tokens\":0,\"total_tokens\":0}}"
            }
        }"#;

        let response: OGInputResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.action, "block");
        assert_eq!(response.detection_result.overall_risk_level, "high_risk");
        assert!(response.block_response.is_some());

        // Verify the block response body is valid OpenAI ChatCompletion format
        let block_resp = response.block_response.unwrap();
        let body: serde_json::Value = serde_json::from_str(&block_resp.body).unwrap();
        assert!(body.get("choices").is_some());
        assert!(body.get("id").is_some());
        assert_eq!(body.get("object").and_then(|v| v.as_str()), Some("chat.completion"));
    }

    #[test]
    fn test_parse_input_response_anonymize() {
        let json = r#"{
            "action": "anonymize",
            "request_id": "gw-xyz789",
            "detection_result": {
                "overall_risk_level": "medium_risk",
                "data_risk": {
                    "risk_level": "medium_risk",
                    "categories": ["EMAIL"],
                    "entity_count": 1
                }
            },
            "anonymized_messages": [
                {"role": "user", "content": "My email is __email_1__"}
            ],
            "session_id": "sess_abc123"
        }"#;

        let response: OGInputResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.action, "anonymize");
        assert!(response.anonymized_messages.is_some());
        assert_eq!(response.session_id, Some("sess_abc123".to_string()));
    }

    #[test]
    fn test_parse_output_response_restore() {
        let json = r#"{
            "action": "restore",
            "request_id": "gw-out-123",
            "detection_result": {
                "overall_risk_level": "no_risk"
            },
            "restored_content": "Your email john@example.com was received"
        }"#;

        let response: OGOutputResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.action, "restore");
        assert_eq!(
            response.restored_content,
            Some("Your email john@example.com was received".to_string())
        );
    }
}
