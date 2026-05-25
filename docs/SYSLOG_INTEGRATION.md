# SIEM / Syslog Integration Guide

OpenGuardrails can forward detection events to your SIEM system via syslog in real time. This document describes the configuration, field mapping, and message format.

## Overview

OpenGuardrails generates a detection event for every request processed by the guardrail engine. When syslog forwarding is enabled, each event is sent to your syslog collector in **CEF (Common Event Format)** over UDP, TCP, or TLS — in addition to the local JSONL log files (which are always written regardless of syslog configuration).

```
User Request
    |
    v
Guardrail Detection
    |
    +---> JSONL file  (always, detection_YYYYMMDD.jsonl)
    +---> Syslog       (when SYSLOG_HOST is configured, CEF or JSON format)
    +---> Database     (when store_detection_results=true)
```

## Prerequisites

To enable syslog forwarding, your security team needs to provide:

| Item | Description | Example |
|------|-------------|---------|
| **Syslog server address** | Hostname or IP of the syslog collector | `siem.corp.example.com` |
| **Syslog server port** | Listening port | `514` (UDP), `6514` (TLS) |
| **Transport protocol** | UDP, TCP, or TLS | `UDP` |
| **TLS certificate** (if TLS) | CA certificate for TLS verification | `/etc/ssl/certs/siem-ca.pem` |
| **Facility** (optional) | Syslog facility code | `LOCAL0` (default) |

## Configuration

Set the following environment variables (or add to your `.env` file):

```bash
# Required - enables syslog forwarding
SYSLOG_HOST=siem.corp.example.com
SYSLOG_PORT=514

# Optional
SYSLOG_PROTOCOL=UDP          # UDP (default) | TCP | TLS
SYSLOG_FACILITY=LOCAL0        # Syslog facility (default: LOCAL0)
SYSLOG_CA_CERT=               # Path to CA cert file (required for TLS)
SYSLOG_FORMAT=cef             # cef (default) | json
```

When `SYSLOG_HOST` is not set, syslog forwarding is completely disabled and the system behaves exactly as before.

## CEF Message Format

Each detection event is sent as a CEF-formatted syslog message:

```
CEF:0|OpenGuardrails|AI-Safety-Platform|{version}|detection|AI Content Detection|{severity}|{extensions}
```

### CEF Header Fields

| CEF Field | Value | Description |
|-----------|-------|-------------|
| Version | `0` | CEF format version |
| Device Vendor | `OpenGuardrails` | Fixed |
| Device Product | `AI-Safety-Platform` | Fixed |
| Device Version | `{app_version}` | OpenGuardrails version (e.g., `5.2.0`) |
| Signature ID | `detection` | Event type |
| Name | `AI Content Detection` | Event name |
| Severity | `0-10` | Mapped from risk level (see below) |

### Severity Mapping

| OpenGuardrails Risk Level | CEF Severity | Description |
|---------------------------|--------------|-------------|
| `no_risk` | `0` | No risk detected |
| `low` | `3` | Low risk |
| `medium` | `6` | Medium risk |
| `high` | `9` | High risk |
| `error` | `5` | Detection error |

The overall severity is the highest severity across security, compliance, and data risk dimensions.

### CEF Extension Fields

| CEF Key | Type | OpenGuardrails Field | Description |
|---------|------|----------------------|-------------|
| `externalId` | string | `request_id` | Unique request identifier |
| `rt` | timestamp | `created_at` | Event timestamp (epoch ms) |
| `src` | string | `ip_address` | Source IP address |
| `duid` | string | `tenant_id` | Tenant identifier (API key owner) |
| `cs1` | string | `application_id` | Application identifier |
| `cs1Label` | string | — | `"ApplicationId"` |
| `cs17` | string | `workspace_id` | Workspace identifier (configuration container) |
| `cs17Label` | string | — | `"WorkspaceId"` |
| `suid` | string | `user_id` | End user identifier (passed by caller, for ban policy) |
| `act` | string | `suggest_action` | Action taken: `pass`, `reject`, `replace`, `anonymize`, `switch_private_model` |
| `requestClientApplication` | string | `user_agent` | Client user agent |
| `cs2` | string | `security_risk_level` | Security risk level |
| `cs2Label` | string | — | `"SecurityRiskLevel"` |
| `cs3` | string | `security_categories` | Security risk categories (comma-separated) |
| `cs3Label` | string | — | `"SecurityCategories"` |
| `cs4` | string | `compliance_risk_level` | Compliance risk level |
| `cs4Label` | string | — | `"ComplianceRiskLevel"` |
| `cs5` | string | `compliance_categories` | Compliance risk categories (comma-separated) |
| `cs5Label` | string | — | `"ComplianceCategories"` |
| `cs6` | string | `data_risk_level` | Data leakage risk level |
| `cs6Label` | string | — | `"DataRiskLevel"` |
| `cs7` | string | `data_categories` | Data leakage categories (comma-separated) |
| `cs7Label` | string | — | `"DataCategories"` |
| `cn1` | float | `sensitivity_score` | Sensitivity score (0.0-1.0) |
| `cn1Label` | string | — | `"SensitivityScore"` |
| `cs8` | string | `matched_scanner_tags` | Matched scanner tags (comma-separated) |
| `cs8Label` | string | — | `"MatchedScannerTags"` |
| `cs9` | string | `hit_keywords` | Hit keywords (comma-separated) |
| `cs9Label` | string | — | `"HitKeywords"` |
| `msg` | string | `content` | Detected content (truncated to 1024 chars, sensitive entities masked) |
| `cn2` | int | `image_count` | Number of images in request |
| `cn2Label` | string | — | `"ImageCount"` |
| `cs10` | string | `source` | Detection source: `guardrail_api`, `proxy`, `gateway`, `direct_model`, `content_scan` |
| `cs10Label` | string | — | `"DetectionSource"` |
| `cs11` | string | `doublecheck_result` | Doublecheck result: `confirmed_unsafe`, `overturned_safe`, or empty |
| `cs11Label` | string | — | `"DoublecheckResult"` |
| `cs12` | string | `doublecheck_categories` | Doublecheck categories (comma-separated) |
| `cs12Label` | string | — | `"DoublecheckCategories"` |
| `cs13` | string | `model_response` | Model raw response (truncated to 512 chars) |
| `cs13Label` | string | — | `"ModelResponse"` |
| `cs14` | string | `suggest_answer` | Suggested answer text (truncated to 512 chars) |
| `cs14Label` | string | — | `"SuggestAnswer"` |
| `cn3` | int | `has_image` | Whether request contains images (0/1) |
| `cn3Label` | string | — | `"HasImage"` |

### Example CEF Message

```
CEF:0|OpenGuardrails|AI-Safety-Platform|5.4.20|detection|AI Content Detection|9|externalId=req_abc123 rt=1711234567000 src=192.168.1.100 duid=tenant_456 cs1=app_789 cs1Label=ApplicationId act=reject requestClientApplication=python-requests/2.31 cs2=high cs2Label=SecurityRiskLevel cs3=S5 cs3Label=SecurityCategories cs4=no_risk cs4Label=ComplianceRiskLevel cs5= cs5Label=ComplianceCategories cs6=no_risk cs6Label=DataRiskLevel cs7= cs7Label=DataCategories cn1=0.95 cn1Label=SensitivityScore cs8=S5 cs8Label=MatchedScannerTags cs9= cs9Label=HitKeywords msg=User attempted prompt injection... cn2=0 cn2Label=ImageCount cs10=guardrail_api cs10Label=DetectionSource cs11= cs11Label=DoublecheckResult cs12= cs12Label=DoublecheckCategories cs13=S5:prompt_attack cs13Label=ModelResponse cs14=This request has been blocked. cs14Label=SuggestAnswer cn3=0 cn3Label=HasImage
```

## JSON Message Format

When `SYSLOG_FORMAT=json`, each detection event is sent as a JSON object wrapped in a syslog priority header:

```
<132>{"timestamp":"2026-04-02T10:30:00+00:00","version":"5.4.20","event_type":"detection","severity":9,"request_id":"req_abc123","ip_address":"192.168.1.100","tenant_id":"tenant_456","application_id":"app_789","action":"reject","user_agent":"python-requests/2.31","security_risk_level":"high","security_categories":["S5"],"compliance_risk_level":"no_risk","compliance_categories":[],"data_risk_level":"no_risk","data_categories":[],"sensitivity_score":0.95,"matched_scanner_tags":["S5"],"hit_keywords":[],"content":"User attempted prompt injection...","has_image":false,"image_count":0,"source":"guardrail_api","model_response":"S5:prompt_attack","suggest_answer":"This request has been blocked.","doublecheck_result":null,"doublecheck_categories":[],"doublecheck_reasoning":null}
```

### JSON Field Reference

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | string | ISO 8601 event timestamp |
| `version` | string | OpenGuardrails version |
| `event_type` | string | Always `"detection"` |
| `severity` | int | 0-10 (same mapping as CEF) |
| `request_id` | string | Unique request identifier |
| `ip_address` | string | Source IP |
| `tenant_id` | string | Tenant identifier (API key owner) |
| `application_id` | string | Application identifier |
| `workspace_id` | string | Workspace identifier (configuration container, nullable) |
| `user_id` | string | End user identifier (passed by caller, nullable) |
| `action` | string | `pass` / `reject` / `replace` / `anonymize` / `switch_private_model` |
| `user_agent` | string | Client user agent |
| `security_risk_level` | string | `no_risk` / `low` / `medium` / `high` |
| `security_categories` | array | Security risk category tags |
| `compliance_risk_level` | string | Compliance risk level |
| `compliance_categories` | array | Compliance risk category tags |
| `data_risk_level` | string | Data leakage risk level |
| `data_categories` | array | Data leakage category tags |
| `sensitivity_score` | float | 0.0-1.0 (nullable) |
| `matched_scanner_tags` | array | All matched scanner tags |
| `hit_keywords` | array | Hit keywords from blacklist |
| `content` | string | Detected content (truncated to 1024 chars) |
| `has_image` | bool | Whether request contains images |
| `image_count` | int | Number of images in request |
| `source` | string | Detection source |
| `model_response` | string | Model raw response (truncated to 512 chars) |
| `suggest_answer` | string | Suggested answer text (truncated to 512 chars) |
| `doublecheck_result` | string | Doublecheck result (nullable): `confirmed_unsafe` / `overturned_safe` |
| `doublecheck_categories` | array | Doublecheck categories |
| `doublecheck_reasoning` | string | Doublecheck reasoning text (nullable) |

JSON format is recommended when your SIEM supports native JSON ingestion (e.g., Splunk HEC, Elastic with JSON processor, Datadog), as it avoids the need for CEF parsing and preserves array types.

## Alerting

The `act` field (CEF) / `action` field (JSON) reflects the **final action** determined by the application's disposal policy. This is the recommended field for building SIEM alert rules.

### Alert Rules by Action

| SIEM Rule | Meaning |
|-----------|---------|
| `act = reject` | Request blocked (security/compliance risk or DLP block) |
| `act = replace` | Response content replaced with safe alternative |
| `act = anonymize` | Sensitive data anonymized before forwarding |
| `act = switch_private_model` | Request redirected to private/on-premise model |

### Alert Rules by Severity

The `Severity` header field (CEF) / `severity` field (JSON) reflects the **detected risk level**, regardless of the disposal policy action. Use this to detect risks even when the policy is configured to allow them.

| SIEM Rule | Meaning |
|-----------|---------|
| `Severity >= 9` | High risk detected (prompt attack, violent crime, etc.) |
| `Severity >= 6` | Medium risk or above |
| `Severity >= 3` | Low risk or above |

### Correlation Rules

Combining `act` and `Severity` enables more advanced alerting scenarios:

| SIEM Rule | Meaning |
|-----------|---------|
| `Severity >= 9 AND act = pass` | High risk detected but policy allowed it — potential misconfiguration |
| `act = reject` spike (> N/min) | Possible attack in progress |
| Same `src` with multiple `act = reject` in short window | Single IP probing for vulnerabilities |
| `act = switch_private_model` spike | Unusual volume of sensitive data routing |

> **Note:** Alert thresholds (rate limits, time windows, notification channels) are configured on the SIEM side. OpenGuardrails provides the event data; your SIEM handles alerting logic.

## SIEM-Specific Notes

### Splunk
- Use the **Splunk Add-on for CEF** to parse incoming messages
- Set source type to `cef` for automatic field extraction

### Elastic / OpenSearch
- Use **Filebeat CEF module** or configure a syslog input with CEF processor
- Fields map directly to ECS (Elastic Common Schema) via the CEF module

### IBM QRadar
- CEF is natively supported; events auto-map to QRadar properties
- Custom properties can be created for `cs1`-`cs9` fields

### Microsoft Sentinel
- Use the **Common Event Format (CEF) via AMA** data connector
- Detection events appear in the `CommonSecurityLog` table

## Verification

After configuring syslog, verify events are being received:

```bash
# Check OpenGuardrails logs for syslog status
docker logs openguardrails-admin | grep -i syslog

# Send a test detection request
curl -X POST http://localhost:5001/v1/guardrails \
  -H "Authorization: Bearer sk-xxai-YOUR-KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "test message"}]}'

# Verify on your SIEM that the event arrived
```

## Troubleshooting

| Issue | Check |
|-------|-------|
| No events in SIEM | Verify `SYSLOG_HOST` and `SYSLOG_PORT` are set correctly |
| Connection refused | Check firewall rules between OpenGuardrails and syslog server |
| TLS handshake failure | Verify `SYSLOG_CA_CERT` path and certificate validity |
| Missing fields | Ensure your SIEM parser supports CEF format |

## Data Privacy

- The `msg` (content) field is **truncated to 1024 characters** to limit log volume
- Sensitive entities detected by data masking are **automatically masked** before logging (e.g., credit card numbers appear as `[CREDIT_CARD]`)
- If your policy requires no content in logs, contact support to configure content-free syslog events

## Identity Fields for Private Deployments

For private/on-premise deployments with a single tenant managing multiple users, the following identity fields help distinguish requests:

| Field | CEF Key | Description |
|-------|---------|-------------|
| `tenant_id` | `duid` | API key owner (top-level account). In private deployments, this is typically the single master tenant. |
| `workspace_id` | `cs17` | Configuration container for grouping applications (e.g., by department or business line). |
| `application_id` | `cs1` | Specific AI application being used. |
| `user_id` | `suid` | End user identifier passed by the calling application via `xxai_app_user_id`. This identifies the actual person using the AI system. |

### Private Deployment Hierarchy

```
Tenant (Master Account)
  ├── Sub-users (Admin accounts created by master tenant)
  ├── Workspaces (Configuration containers)
  │     └── Applications (AI apps)
  └── End Users (user_id, passed by calling app)
```

### SIEM Filtering Examples

**Filter by workspace:**
```
cs17 = "workspace-uuid-here"
```

**Filter by end user:**
```
suid = "user123"
```

**Detect multiple applications used by same end user:**
```
GROUP BY suid HAVING COUNT(DISTINCT cs1) > 1
```
