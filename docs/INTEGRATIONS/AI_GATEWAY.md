# AI Gateway Integration

> Use OpenGuardrails as a security layer in your AI gateway architecture

## Overview

OpenGuardrails can function as a **security gateway** or integrate with existing AI gateways to provide runtime policy enforcement and safety protection.

## Integration Patterns

### Pattern 1: OpenGuardrails AS the Gateway

Use OpenGuardrails' built-in proxy service as your AI gateway.

**Architecture**:
```
Client Apps
    ↓
OpenGuardrails Proxy (:5002)
    ├─ Input Guardrails
    ├─ Output Guardrails
    └─ Multi-Provider Routing
        ↓
Upstream Models (OpenAI, Claude, local)
```

**Benefits**:
- ✅ Zero-code integration (OpenAI-compatible)
- ✅ Automatic input/output protection
- ✅ Multi-provider support
- ✅ Built-in policy enforcement

### Pattern 2: OpenGuardrails + Existing Gateway

Integrate OpenGuardrails detection into your existing gateway.

**Architecture**:
```
Client Apps
    ↓
Your AI Gateway (Kong, Tyk, etc.)
    ├─ Authentication
    ├─ Rate Limiting
    └─ Safety Check → OpenGuardrails Detection API
        ↓
Upstream Models
```

**Benefits**:
- ✅ Keep existing infrastructure
- ✅ Add safety layer
- ✅ Flexible integration points
- ✅ Gradual rollout

### Pattern 3: Sidecar Pattern

Deploy OpenGuardrails as a sidecar to your gateway.

**Architecture**:
```
┌─────────────────────────────┐
│   Gateway Pod/Container     │
│  ┌──────────┐  ┌──────────┐│
│  │ Gateway  │←→│OpenGuard││
│  │          │  │rails     ││
│  └──────────┘  └──────────┘│
└─────────────────────────────┘
```

**Benefits**:
- ✅ Low latency (local calls)
- ✅ Isolated scaling
- ✅ Kubernetes-friendly
- ✅ Failure isolation

---

## Pattern 1: OpenGuardrails AS Gateway

### Setup

**1. Deploy OpenGuardrails**:
```bash
docker compose up -d
```

**2. Configure Upstream Models**:

Via Web UI (`/platform/proxy/models`):
- Add OpenAI, Claude, or local models
- Configure API keys and endpoints

Via API:
```bash
curl -X POST http://localhost:5000/api/v1/proxy/models \
  -H "Authorization: Bearer your-jwt-token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "gpt-4-proxy",
    "upstream_url": "https://api.openai.com/v1",
    "upstream_model": "gpt-4",
    "upstream_api_key": "sk-your-openai-key",
    "enabled": true
  }'
```

**3. Generate Proxy API Key**:

Via Web UI (`/platform/proxy/keys`):
- Click "Create Proxy Key"
- Select upstream model
- Configure guardrails settings

Via API:
```bash
curl -X POST http://localhost:5000/api/v1/proxy/keys \
  -H "Authorization: Bearer your-jwt-token" \
  -H "Content-Type: application/json" \
  -d '{
    "proxy_model_id": "model_xxx",
    "enable_input_guardrails": true,
    "enable_output_guardrails": true
  }'
```

**4. Use Proxy**:

```python
from openai import OpenAI

# Point to OpenGuardrails proxy
client = OpenAI(
    base_url="http://localhost:5002/v1",
    api_key="sk-xxai-your-proxy-key"
)

# Use normally - automatic safety protection!
response = client.chat.completions.create(
    model="gpt-4",  # Automatically routes to configured upstream
    messages=[{"role": "user", "content": "Hello"}]
)
```

### Features

**Multi-Provider Support**:
```python
# Configure multiple upstream models
proxies = [
    {"name": "gpt-4-proxy", "upstream": "openai"},
    {"name": "claude-proxy", "upstream": "anthropic"},
    {"name": "local-llm-proxy", "upstream": "localhost:11434"}
]
```

**Load Balancing**:
```python
# Round-robin across providers
{
    "load_balancing": "round_robin",
    "upstream_models": ["gpt-4-proxy", "claude-proxy"]
}
```

**Streaming Support**:
```python
# Streaming works automatically
stream = client.chat.completions.create(
    model="gpt-4",
    messages=[...],
    stream=True
)

for chunk in stream:
    print(chunk.choices[0].delta.content)
```

---

## Pattern 2: Integrate with Existing Gateway

### Kong Gateway Integration

**1. Add OpenGuardrails as Upstream Service**:

```bash
# Add OpenGuardrails detection service
curl -X POST http://localhost:8001/services \
  -d name=openguardrails \
  -d url='http://openguardrails-detection:5001'
```

**2. Create Custom Plugin**:

```lua
-- kong/plugins/openguardrails/handler.lua
local http = require "resty.http"
local cjson = require "cjson"

local OpenGuardrailsHandler = {
  PRIORITY = 1000,
  VERSION = "1.0.0",
}

function OpenGuardrailsHandler:access(conf)
  -- Get request body
  local body = kong.request.get_raw_body()

  -- Call OpenGuardrails
  local httpc = http.new()
  local res, err = httpc:request_uri(conf.guardrails_url, {
    method = "POST",
    body = body,
    headers = {
      ["Authorization"] = "Bearer " .. conf.api_key,
      ["Content-Type"] = "application/json",
    },
  })

  -- Check result
  local result = cjson.decode(res.body)
  if result.suggest_action == "reject" then
    return kong.response.exit(403, {
      message = result.suggest_answer
    })
  end
end

return OpenGuardrailsHandler
```

**3. Enable Plugin**:

```bash
curl -X POST http://localhost:8001/plugins \
  -d name=openguardrails \
  -d config.guardrails_url=http://openguardrails-detection:5001/v1/guardrails \
  -d config.api_key=sk-xxai-your-key
```

### Tyk Gateway Integration

**1. Create Custom Middleware**:

```python
# middleware/openguardrails.py
from tyk.decorators import *
from gateway import TykGateway as tyk

@Hook
def OpenGuardrailsCheck(request, session, metadata, spec):
    import requests

    # Extract request body
    body = request.object.body

    # Call OpenGuardrails
    response = requests.post(
        'http://openguardrails-detection:5001/v1/guardrails',
        headers={'Authorization': 'Bearer sk-xxai-your-key'},
        json=body
    )

    result = response.json()

    # Block if flagged
    if result['suggest_action'] == 'reject':
        request.object.return_overrides.response_code = 403
        request.object.return_overrides.response_error = result['suggest_answer']

    return request, session
```

**2. Add to API Definition**:

```json
{
  "custom_middleware": {
    "pre": [
      {
        "name": "OpenGuardrailsCheck",
        "path": "middleware/openguardrails.py"
      }
    ]
  }
}
```

### API Gateway (AWS) Integration

**1. Create Lambda Function**:

```python
import json
import boto3
import requests

def lambda_handler(event, context):
    # Extract request
    body = json.loads(event['body'])

    # Call OpenGuardrails
    response = requests.post(
        'https://api.openguardrails.com/v1/guardrails',
        headers={'Authorization': 'Bearer sk-xxai-your-key'},
        json={
            'model': 'OpenGuardrails-Text',
            'messages': body['messages']
        }
    )

    result = response.json()

    # Check result
    if result['suggest_action'] == 'reject':
        return {
            'statusCode': 403,
            'body': json.dumps({
                'error': result['suggest_answer']
            })
        }

    # Allow request
    return {
        'statusCode': 200,
        'body': json.dumps({'allowed': True})
    }
```

**2. Configure API Gateway**:
- Add Lambda authorizer
- Attach to AI endpoints
- Configure request/response mapping

---

## Pattern 3: Sidecar Deployment

### Kubernetes Sidecar

**Deployment manifest**:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ai-gateway
spec:
  replicas: 3
  template:
    spec:
      containers:
      # Main gateway container
      - name: gateway
        image: your-gateway:latest
        ports:
        - containerPort: 8000
        env:
        - name: OPENGUARDRAILS_URL
          value: "http://localhost:5001"

      # OpenGuardrails sidecar
      - name: openguardrails
        image: openguardrails/openguardrails-platform:latest
        ports:
        - containerPort: 5001
        env:
        - name: GUARDRAILS_MODEL_API_URL
          value: "http://model-service:58002/v1"
```

**Gateway calls sidecar**:

```python
# In your gateway code
import requests

def check_safety(content):
    # Call local sidecar (low latency)
    response = requests.post(
        'http://localhost:5001/v1/guardrails',
        headers={'Authorization': 'Bearer sk-xxai-your-key'},
        json={'messages': [{'role': 'user', 'content': content}]}
    )
    return response.json()
```

---

## Advanced Features

### 1. Custom Policy Enforcement

**Business rules in gateway**:

```python
# Check input
input_result = openguardrails.check_prompt(user_message)

# Apply custom business logic
if input_result.matched_scanner_tags and 'S100' in input_result.matched_scanner_tags:
    # S100 = Custom business policy
    log_policy_violation(user_id, 'S100')
    return custom_business_response()

# Check output
output_result = openguardrails.check_response(llm_response)

# Apply different actions per risk level
if output_result.overall_risk_level == 'high_risk':
    return safe_fallback_response()
elif output_result.overall_risk_level == 'medium_risk':
    return output_result.suggest_answer  # Knowledge base answer
else:
    return llm_response
```

### 2. Per-Route Configuration

**Different policies per endpoint**:

```python
routes = {
    '/api/v1/chat/support': {
        'scanners': ['S9', 'S100'],  # Prompt injection + scope control
        'risk_level': 'medium'
    },
    '/api/v1/chat/internal': {
        'scanners': ['S9', 'S11', 'S102'],  # + data leak + internal info
        'risk_level': 'high'
    }
}
```

### 3. Conditional Guardrails

**Skip guardrails for trusted users**:

```python
def should_check_guardrails(user):
    if user.is_admin:
        return False
    if user.trust_score > 0.95:
        return False
    if user.is_whitelisted:
        return False
    return True
```

### 4. Async Processing

**Non-blocking guardrails**:

```python
import asyncio

async def process_request(content):
    # Check input (async)
    input_task = asyncio.create_task(
        openguardrails.check_prompt_async(content)
    )

    # Other processing (parallel)
    user_data_task = asyncio.create_task(fetch_user_data())

    # Wait for both
    input_result, user_data = await asyncio.gather(
        input_task,
        user_data_task
    )

    if input_result.is_blocked:
        return input_result.suggest_answer

    # Continue...
```

---

## Monitoring & Observability

### Metrics to Track

**Gateway-level metrics**:
```python
# Prometheus metrics
openguardrails_requests_total
openguardrails_blocked_total
openguardrails_latency_seconds
openguardrails_errors_total
```

**Dashboard queries**:
```promql
# Block rate
rate(openguardrails_blocked_total[5m]) / rate(openguardrails_requests_total[5m])

# P95 latency
histogram_quantile(0.95, openguardrails_latency_seconds_bucket)

# Error rate
rate(openguardrails_errors_total[5m])
```

### Logging

**Structured logs**:
```json
{
  "timestamp": "2025-01-15T10:30:00Z",
  "gateway": "kong",
  "route": "/api/v1/chat",
  "user_id": "user_xxx",
  "guardrails": {
    "checked": true,
    "risk_level": "no_risk",
    "latency_ms": 145,
    "action": "pass"
  }
}
```

---

## Performance Optimization

### 1. Connection Pooling

```python
from requests_futures.sessions import FuturesSession

# Reuse connections
session = FuturesSession(max_workers=10)

def check_async(content):
    future = session.post(
        'http://localhost:5001/v1/guardrails',
        headers={'Authorization': 'Bearer sk-xxai-your-key'},
        json={'messages': [{'role': 'user', 'content': content}]}
    )
    return future
```

### 2. Caching

```python
import hashlib
import redis

redis_client = redis.Redis()

def check_with_cache(content):
    # Generate cache key
    cache_key = f"guardrails:{hashlib.md5(content.encode()).hexdigest()}"

    # Check cache
    cached = redis_client.get(cache_key)
    if cached:
        return json.loads(cached)

    # Call OpenGuardrails
    result = openguardrails.check_prompt(content)

    # Cache result (1 hour)
    redis_client.setex(cache_key, 3600, json.dumps(result))

    return result
```

### 3. Parallel Checks

```python
async def check_both(input_content, output_content):
    # Check input and output in parallel
    results = await asyncio.gather(
        check_prompt_async(input_content),
        check_response_async(output_content)
    )
    return results
```

---

## Security Considerations

### 1. Authentication

**Gateway → OpenGuardrails**:
- Use API keys (Bearer tokens)
- Rotate keys regularly
- Use separate keys per environment

### 2. Network Security

**Sidecar pattern**:
- OpenGuardrails only accessible via localhost
- No external exposure

**Service mesh**:
- mTLS between gateway and OpenGuardrails
- Network policies for isolation

### 3. Rate Limiting

**Protect OpenGuardrails**:
```python
from ratelimit import limits, sleep_and_retry

@sleep_and_retry
@limits(calls=100, period=60)
def call_openguardrails(content):
    return openguardrails.check_prompt(content)
```

---

## Example Architectures

### Architecture 1: Multi-Tenant SaaS

```
Load Balancer
    ↓
Kong Gateway
    ├─ Authentication (per tenant)
    ├─ Rate Limiting (per tenant)
    └─ OpenGuardrails Check
        ├─ Tenant-specific policies
        └─ Custom scanners per tenant
            ↓
OpenAI / Claude / Local Models
```

### Architecture 2: Enterprise Internal

```
Internal Load Balancer
    ↓
Tyk Gateway (on-prem)
    ├─ LDAP Authentication
    ├─ IP Whitelisting
    └─ OpenGuardrails Sidecar
        ├─ Company policies
        └─ Compliance scanners
            ↓
Internal AI Models (on-prem)
```

### Architecture 3: Hybrid Cloud

```
Cloudflare / CDN
    ↓
API Gateway (AWS)
    ├─ WAF
    ├─ Lambda Authorizer
    └─ OpenGuardrails Lambda
        ↓
OpenAI (cloud) + Local Models (on-prem)
```

---

## Best Practices

1. **Fail Open vs Fail Closed**
   - Production: Fail open (allow on error)
   - High security: Fail closed (block on error)

2. **Timeout Configuration**
   - Set reasonable timeouts (< 500ms)
   - Implement circuit breakers
   - Have fallback responses

3. **Gradual Rollout**
   - Start with monitoring only
   - Enable blocking for pilot users
   - Full rollout after validation

4. **Policy Management**
   - Centralize policy configuration
   - Version control policies
   - A/B test policy changes

5. **Observability**
   - Track all guardrails decisions
   - Monitor latency and errors
   - Alert on anomalies

---

## Resources

- [OpenGuardrails API Reference](../API_REFERENCE.md)
- [Deployment Guide](../DEPLOYMENT.md)
- [Custom Scanners Guide](../CUSTOM_SCANNERS.md)

---

**Last Updated**: 2025-01-21
**Need Help?** Contact thomas@openguardrails.com
