# n8n Integration Guide

> Automate AI safety workflows with OpenGuardrails + n8n integration

## Overview

n8n is an open-source workflow automation platform. By integrating OpenGuardrails, you can:

- ✅ **Content moderation bots** with automatic safety checks
- ✅ **AI chatbots** with input/output protection
- ✅ **Automated content screening** pipelines
- ✅ **Custom safety workflows** tailored to your needs

---

## Integration Methods

### Method 1: n8n Community Node (Recommended)

**Official OpenGuardrails node for n8n**

**Installation**:
```bash
# In n8n web UI:
# Settings → Community Nodes → Install
n8n-nodes-openguardrails
```

**Features**:
- ✅ Pre-built OpenGuardrails operations
- ✅ Easy configuration UI
- ✅ Context-aware multi-turn detection
- ✅ Configurable risk thresholds

### Method 2: HTTP Request Node

**Use n8n's built-in HTTP Request node**

**When to use**:
- Custom API configurations
- Advanced use cases
- Learning purposes

---

## Method 1: Community Node Setup

### Step 1: Install Community Node

1. Open n8n web interface
2. Click **Settings** → **Community Nodes**
3. Click **Install**
4. Enter: `n8n-nodes-openguardrails`
5. Click **Install**
6. Restart n8n

### Step 2: Get API Key

**Option A: Cloud (Free)**:
1. Visit https://www.openguardrails.com/platform/
2. Register for free account
3. Copy API key from Account page

**Option B: Self-Hosted**:
```bash
# Deploy OpenGuardrails locally
docker compose up -d

# Get API key from platform UI
# Or use environment variable
```

### Step 3: Create Workflow

1. **Create New Workflow**

2. **Add Webhook Node** (trigger):
   ```
   HTTP Method: POST
   Path: /chatbot
   ```

3. **Add OpenGuardrails Node**:
   - **Operation**: Check Prompt
   - **API Key**: Your OpenGuardrails API key
   - **Content**: `{{ $json.message }}`
   - **Enable Security**: ✅
   - **Enable Compliance**: ✅
   - **Enable Data Security**: ✅

4. **Add IF Node** (check result):
   ```javascript
   Condition: {{ $json.suggest_action === 'pass' }}
   ```

5. **True Branch**: Continue to LLM
6. **False Branch**: Return safe response

---

## Method 2: HTTP Request Node Setup

### Basic Workflow Example

```json
{
  "nodes": [
    {
      "name": "Webhook",
      "type": "n8n-nodes-base.webhook",
      "parameters": {
        "httpMethod": "POST",
        "path": "chatbot"
      }
    },
    {
      "name": "OpenGuardrails Check",
      "type": "n8n-nodes-base.httpRequest",
      "parameters": {
        "method": "POST",
        "url": "https://api.openguardrails.com/v1/guardrails",
        "authentication": "headerAuth",
        "headerAuth": {
          "name": "Authorization",
          "value": "Bearer sk-xxai-your-api-key"
        },
        "options": {
          "bodyContentType": "json"
        },
        "body": {
          "model": "OpenGuardrails-Text",
          "messages": [
            {
              "role": "user",
              "content": "={{ $json.message }}"
            }
          ]
        }
      }
    },
    {
      "name": "Check Risk",
      "type": "n8n-nodes-base.if",
      "parameters": {
        "conditions": {
          "string": [
            {
              "value1": "={{ $json.suggest_action }}",
              "operation": "equals",
              "value2": "pass"
            }
          ]
        }
      }
    }
  ]
}
```

---

## Workflow Templates

### Template 1: Basic Content Moderation

**Use case**: Simple content safety check

```
1. Webhook (receive content)
   ↓
2. OpenGuardrails (check content)
   ↓
3. IF (is_safe?)
   ├─ YES → Return "Content approved"
   └─ NO → Return "Content blocked"
```

**Import JSON**: See `n8n-integrations/http-request-examples/basic-content-check.json`

### Template 2: Protected AI Chatbot

**Use case**: Full input/output protection

```
1. Webhook (receive user message)
   ↓
2. OpenGuardrails - Input Check
   ↓
3. IF (input safe?)
   ├─ NO → Return safe response
   └─ YES → Continue
          ↓
4. OpenAI / Claude / LLM
   ↓
5. OpenGuardrails - Output Check
   ↓
6. IF (output safe?)
   ├─ NO → Return safe response
   └─ YES → Return LLM response
```

**Import JSON**: See `n8n-integrations/http-request-examples/chatbot-with-moderation.json`

### Template 3: Batch Content Screening

**Use case**: Screen multiple items

```
1. Schedule (every hour)
   ↓
2. Database (fetch new content)
   ↓
3. Loop (for each item)
   ├─ OpenGuardrails Check
   └─ Update Database (with result)
   ↓
4. Slack Notification (if violations found)
```

### Template 4: Customer Support Bot

**Use case**: Support with business policy enforcement

```
1. Webhook (user question)
   ↓
2. OpenGuardrails (check input + custom scanners)
   ├─ S100: Support Scope Control
   └─ S9: Prompt Injection
   ↓
3. IF (in scope?)
   ├─ NO → "Sorry, I can only help with product support"
   └─ YES → Continue
          ↓
4. Knowledge Base Search
   ↓
5. IF (found answer?)
   ├─ YES → Return answer
   └─ NO → Call LLM
                ↓
6. OpenGuardrails (check output)
   ├─ S101: Unauthorized Promises
   └─ S10: Profanity
   ↓
7. Return response
```

---

## Configuration Options

### Authentication

**Header Auth Setup**:
```
Name: Authorization
Value: Bearer sk-xxai-your-api-key
```

### Request Body

**Minimal**:
```json
{
  "model": "OpenGuardrails-Text",
  "messages": [
    {
      "role": "user",
      "content": "{{ $json.message }}"
    }
  ]
}
```

**Full Configuration**:
```json
{
  "model": "OpenGuardrails-Text",
  "messages": [
    {
      "role": "user",
      "content": "{{ $json.message }}"
    }
  ],
  "enable_security": true,
  "enable_compliance": true,
  "enable_data_security": true,
  "xxai_app_user_id": "{{ $json.user_id }}"
}
```

### Response Handling

**Access detection results**:
```javascript
// Risk level
{{ $json.overall_risk_level }}  // "no_risk" | "low_risk" | "medium_risk" | "high_risk"

// Suggested action
{{ $json.suggest_action }}  // "pass" | "reject" | "replace"

// Safe response (if blocked)
{{ $json.suggest_answer }}

// Detection categories
{{ $json.result.compliance.categories }}  // ["Violent Crime", ...]

// Individual scores
{{ $json.result.compliance.score }}  // 0.0 - 1.0
{{ $json.result.security.score }}
{{ $json.result.data.score }}
```

---

## Advanced Workflows

### Multi-Turn Conversation Detection

**Workflow**:
```javascript
// Store conversation history
const messages = [
  {
    "role": "user",
    "content": $json.message1
  },
  {
    "role": "assistant",
    "content": $json.response1
  },
  {
    "role": "user",
    "content": $json.message2  // Current message
  }
];

// Send full context to OpenGuardrails
{
  "model": "OpenGuardrails-Text",
  "messages": messages
}
```

**Why multi-turn?**
- Better detection accuracy
- Context-aware safety
- Catch sophisticated attacks

### Custom Scanner Integration

**Create custom scanner** (via API):
```javascript
// HTTP Request to OpenGuardrails Admin API
POST https://api.openguardrails.com/api/v1/custom-scanners
Headers: Authorization: Bearer your-jwt-token

Body:
{
  "scanner_type": "genai",
  "name": "Workflow-Specific Policy",
  "definition": "Detect behavior specific to this n8n workflow...",
  "risk_level": "high_risk",
  "scan_prompt": true,
  "scan_response": true
}
```

**Use in workflow**:
- Custom scanners automatically apply to all detections
- Tag format: S100, S101, S102...
- Application-scoped

### Conditional Actions by Risk Level

```javascript
// Different actions for different risk levels
switch ($json.overall_risk_level) {
  case 'high_risk':
    // Block immediately
    return { blocked: true, message: "Content blocked" };

  case 'medium_risk':
    // Send for human review
    await sendToReviewQueue($json);
    return { queued: true };

  case 'low_risk':
    // Allow but log
    await logWarning($json);
    return { allowed: true };

  default:  // no_risk
    // Allow
    return { allowed: true };
}
```

---

## Example Workflows

### Example 1: Discord Bot with Safety

```
1. Discord Webhook (new message)
   ↓
2. OpenGuardrails Check
   ↓
3. IF (safe?)
   ├─ NO → Delete message + warn user
   └─ YES → Continue
          ↓
4. OpenAI (generate response)
   ↓
5. OpenGuardrails Check (output)
   ↓
6. IF (safe?)
   ├─ NO → Use safe fallback
   └─ YES → Post to Discord
```

### Example 2: Content Approval Pipeline

```
1. Google Sheets (new row)
   ↓
2. OpenGuardrails (check content)
   ↓
3. Switch (risk level)
   ├─ high_risk → Slack alert + auto-reject
   ├─ medium_risk → Send to review queue
   └─ no/low_risk → Auto-approve
   ↓
4. Update Sheet (with decision)
```

### Example 3: Email Response Bot

```
1. Email Trigger (new email)
   ↓
2. Extract email body
   ↓
3. OpenGuardrails (check email content)
   ↓
4. IF (appropriate?)
   ├─ NO → Send template response
   └─ YES → Continue
          ↓
5. OpenAI (generate reply)
   ↓
6. OpenGuardrails (check reply)
   ↓
7. Send Email
```

---

## Best Practices

### 1. Use Environment Variables

```bash
# In n8n .env file
OPENGUARDRAILS_API_KEY=sk-xxai-your-key
OPENGUARDRAILS_BASE_URL=https://api.openguardrails.com
```

**In workflows**:
```javascript
{{ $env.OPENGUARDRAILS_API_KEY }}
```

### 2. Error Handling

```javascript
// Add Error Trigger node
{
  "name": "On Error",
  "type": "n8n-nodes-base.errorTrigger",
  "continueOnFail": true
}

// Log errors
{
  "name": "Log Error",
  "type": "n8n-nodes-base.httpRequest",
  "parameters": {
    "url": "{{ $env.ERROR_WEBHOOK_URL }}",
    "body": {
      "error": "={{ $json.error }}",
      "workflow": "{{ $workflow.name }}"
    }
  }
}
```

### 3. Caching Results

For repeated content:
```javascript
// Check cache first
const cacheKey = hash($json.message);
const cached = await redis.get(cacheKey);

if (cached) {
  return cached;
}

// Call OpenGuardrails
const result = await callOpenGuardrails();

// Cache result
await redis.set(cacheKey, result, 'EX', 3600);
```

### 4. Rate Limiting

```javascript
// Add delay between requests
{
  "name": "Wait",
  "type": "n8n-nodes-base.wait",
  "parameters": {
    "amount": 100,  // milliseconds
    "unit": "ms"
  }
}
```

### 5. Monitoring

```javascript
// Log all detection results
{
  "name": "Log to Database",
  "type": "n8n-nodes-base.postgres",
  "parameters": {
    "operation": "insert",
    "table": "detection_logs",
    "columns": [
      "content",
      "risk_level",
      "action",
      "timestamp"
    ],
    "values": [
      "={{ $json.content }}",
      "={{ $json.overall_risk_level }}",
      "={{ $json.suggest_action }}",
      "={{ $now }}"
    ]
  }
}
```

---

## Troubleshooting

### Issue: "401 Unauthorized"

**Solution**:
- Verify API key is correct
- Check header format: `Bearer sk-xxai-...`
- Ensure API key is active

### Issue: "Timeout"

**Solution**:
- Increase timeout in HTTP Request node
- Check OpenGuardrails service health
- Consider self-hosted deployment

### Issue: "False Positives"

**Solution**:
- Review detection results
- Adjust sensitivity thresholds
- Add to whitelist
- Refine custom scanners

---

## Performance Optimization

### 1. Parallel Processing

```javascript
// Use Split In Batches + Merge nodes
1. Split In Batches (10 items)
   ↓
2. OpenGuardrails (parallel)
   ↓
3. Merge (combine results)
```

### 2. Skip Unnecessary Checks

```javascript
// Check cache or whitelist first
IF (cached || whitelisted) {
  return { allowed: true };
}
// Then call OpenGuardrails
```

### 3. Use Self-Hosted

```bash
# Deploy OpenGuardrails locally
docker compose up -d

# Update n8n workflows to use local endpoint
http://your-host:5001/v1/guardrails
```

**Benefits**:
- Lower latency
- No API rate limits
- Full control
- Data privacy

---

## Resources

### Templates

- **Repository**: `n8n-integrations/http-request-examples/`
- **Basic Content Check**: `basic-content-check.json`
- **Chatbot with Moderation**: `chatbot-with-moderation.json`

### Documentation

- **OpenGuardrails API**: [API Reference](../API_REFERENCE.md)
- **n8n Community Node**: [GitHub](https://github.com/openguardrails/n8n-nodes-openguardrails)
- **n8n Docs**: [n8n.io/docs](https://docs.n8n.io)

### Support

- **Email**: thomas@openguardrails.com
- **GitHub Issues**: [OpenGuardrails Issues](https://github.com/openguardrails/openguardrails/issues)

---

**Last Updated**: 2025-01-21
