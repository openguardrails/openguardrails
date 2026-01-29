# OpenGuardrails Connector Plugin for Higress

This plugin integrates OpenGuardrails' full security capabilities into Higress gateway as a lightweight connector.

## Features

All detection logic resides in OpenGuardrails - the plugin only handles:
- Request/response interception
- OpenGuardrails API communication
- Action execution (block, anonymize, switch model, etc.)

### Full Security Capabilities

Through OpenGuardrails integration, you get:

| Capability | Description |
|------------|-------------|
| **Blacklist/Whitelist** | Keyword-based filtering |
| **DLP (Data Leakage Prevention)** | Sensitive data detection with anonymization |
| **21 Risk Categories** | S1-S21 security/compliance scanners |
| **Prompt Attack Detection (S9)** | Jailbreak attempt prevention |
| **Private Model Switching** | Auto-redirect to on-premise models |
| **Knowledge Base Responses** | Template-based safe responses |
| **Ban Policy** | IP/user-based blocking |

## Configuration

```yaml
apiVersion: extensions.higress.io/v1alpha1
kind: WasmPlugin
metadata:
  name: og-connector
  namespace: higress-system
spec:
  selector:
    matchLabels:
      higress: higress-system-higress-gateway
  defaultConfig:
    og_base_url: "http://openguardrails:5002"
    og_api_key: "sk-xxai-your-api-key"
    timeout_ms: 5000
    enable_output_detection: true
    og_cluster: "openguardrails"
  url: oci://docker.io/openguardrails/og-connector:latest
```

### Configuration Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `og_base_url` | string | `http://openguardrails:5002` | OpenGuardrails service URL |
| `og_api_key` | string | - | Application API key (the key is associated with a specific application) |
| `timeout_ms` | number | 5000 | API call timeout in milliseconds |
| `enable_output_detection` | boolean | true | Enable response content scanning |
| `og_cluster` | string | `openguardrails` | Upstream cluster name |

## How It Works

### Request Flow

```
User Request
    │
    ▼
┌──────────────────────────────────────┐
│ OG Connector Plugin                  │
│ 1. Parse OpenAI messages             │
│ 2. Call /v1/gateway/process-input    │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│ OpenGuardrails                       │
│ • Blacklist/Whitelist check          │
│ • DLP detection                      │
│ • Security/Compliance scanning       │
│ • Disposition decision               │
└──────────────────┬───────────────────┘
                   │
                   ▼
       ┌───────────┴───────────┐
       │   Action Response     │
       ├───────────────────────┤
       │ block → Return error  │
       │ replace → Return KB   │
       │ anonymize → Mask data │
       │ switch → Use private  │
       │ pass → Continue       │
       └───────────────────────┘
```

### Response Flow

```
LLM Response
    │
    ▼
┌──────────────────────────────────────┐
│ OG Connector Plugin                  │
│ Call /v1/gateway/process-output      │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│ OpenGuardrails                       │
│ • Restore anonymized placeholders    │
│ • Output content detection           │
└──────────────────┬───────────────────┘
                   │
                   ▼
       ┌───────────┴───────────┐
       │   Action Response     │
       ├───────────────────────┤
       │ restore → Restore     │
       │ block → Return error  │
       │ pass → Continue       │
       └───────────────────────┘
```

## Build

```bash
cd plugins/wasm-rust

# Build the plugin
make build PLUGIN_NAME=og-connector

# Build Docker image
make build-image PLUGIN_NAME=og-connector PLUGIN_VERSION=1.0.0
```

## Prerequisites

1. OpenGuardrails platform deployed and accessible from Higress
2. Application created in OpenGuardrails with security policies configured
3. API key generated for the application

### Higress Upstream Configuration

Add OpenGuardrails as an upstream service in Higress:

```yaml
apiVersion: networking.k8s.io/v1
kind: Service
metadata:
  name: openguardrails
  namespace: default
spec:
  type: ExternalName
  externalName: openguardrails.your-domain.com
  ports:
    - port: 5001
```

## Testing

```bash
# Test with curl
curl -X POST http://your-higress-gateway/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-llm-api-key" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "My email is test@example.com"}]
  }'
```

## Troubleshooting

### Common Issues

1. **Connection refused to OpenGuardrails**
   - Check network connectivity between Higress and OpenGuardrails
   - Verify `og_cluster` matches your upstream configuration

2. **Authentication failed**
   - Verify `og_api_key` is correct

3. **Timeout errors**
   - Increase `timeout_ms` if OpenGuardrails is under heavy load
   - Check OpenGuardrails service health

### Debug Logging

Enable debug logs in Higress configuration:

```yaml
spec:
  defaultConfig:
    # ... other config
  logging:
    level: debug
```

## Performance

- Typical latency overhead: 50-200ms per request
- Scales with OpenGuardrails capacity
- Connection pooling recommended for high-traffic scenarios

## License

Apache 2.0 - Same as OpenGuardrails
