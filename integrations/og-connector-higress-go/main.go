// OpenGuardrails Connector Plugin for Higress (Go version)
// Integrates OG security capabilities with anonymization, restoration, and streaming support.
package main

import (
	"net/http"

	"github.com/alibaba/higress/plugins/wasm-go/pkg/wrapper"
	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm"
	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm/types"
	"github.com/tidwall/gjson"
)

func main() {}

func init() {
	wrapper.SetCtx(
		"og-connector",
		wrapper.ParseConfig(parseConfig),
		wrapper.ProcessRequestHeaders(onHttpRequestHeaders),
		wrapper.ProcessRequestBody(onHttpRequestBody),
		wrapper.ProcessResponseHeaders(onHttpResponseHeaders),
		wrapper.ProcessResponseBody(onHttpResponseBody),
		wrapper.ProcessStreamingResponseBody(onStreamingResponseBody),
	)
}

// --- Configuration ---

type PluginConfig struct {
	client                wrapper.HttpClient
	ogCluster             string
	ogBaseURL             string
	ogAPIKey              string
	applicationID         string
	timeoutMs             uint32
	enableInputDetection  bool
	enableOutputDetection bool

	// Traffic mirroring: fire-and-forget copy of detection requests to a test OG instance
	enableMirror  bool
	mirrorClient  wrapper.HttpClient
	mirrorCluster string
	mirrorBaseURL string
	mirrorAPIKey  string
}

func parseConfig(json gjson.Result, config *PluginConfig) error {
	config.ogCluster = json.Get("og_cluster").String()
	config.ogBaseURL = json.Get("og_base_url").String()
	config.ogAPIKey = json.Get("og_api_key").String()
	config.applicationID = json.Get("application_id").String()

	config.timeoutMs = 5000
	if v := json.Get("timeout_ms"); v.Exists() {
		config.timeoutMs = uint32(v.Uint())
	}

	config.enableInputDetection = true
	if v := json.Get("enable_input_detection"); v.Exists() {
		config.enableInputDetection = v.Bool()
	}

	config.enableOutputDetection = true
	if v := json.Get("enable_output_detection"); v.Exists() {
		config.enableOutputDetection = v.Bool()
	}

	// Build HTTP client from cluster config
	host := config.ogBaseURL
	// Strip protocol prefix for host header
	for _, prefix := range []string{"https://", "http://"} {
		if len(host) > len(prefix) && host[:len(prefix)] == prefix {
			host = host[len(prefix):]
			break
		}
	}
	config.client = wrapper.NewClusterClient(wrapper.TargetCluster{
		Cluster: config.ogCluster,
		Host:    host,
	})

	// Mirror configuration (optional)
	config.enableMirror = json.Get("enable_mirror").Bool()
	if config.enableMirror {
		config.mirrorCluster = json.Get("mirror_cluster").String()
		config.mirrorBaseURL = json.Get("mirror_base_url").String()
		config.mirrorAPIKey = json.Get("mirror_api_key").String()

		mirrorHost := config.mirrorBaseURL
		for _, prefix := range []string{"https://", "http://"} {
			if len(mirrorHost) > len(prefix) && mirrorHost[:len(prefix)] == prefix {
				mirrorHost = mirrorHost[len(prefix):]
				break
			}
		}
		config.mirrorClient = wrapper.NewClusterClient(wrapper.TargetCluster{
			Cluster: config.mirrorCluster,
			Host:    mirrorHost,
		})

		proxywasm.LogWarnf("[OG-CONFIG] Mirror enabled: cluster=%s, base_url=%s", config.mirrorCluster, config.mirrorBaseURL)
	}

	proxywasm.LogWarnf("[OG-CONFIG] Loaded: cluster=%s, base_url=%s, app_id=%s, timeout=%d, input=%v, output=%v, mirror=%v",
		config.ogCluster, config.ogBaseURL, config.applicationID, config.timeoutMs,
		config.enableInputDetection, config.enableOutputDetection, config.enableMirror)

	return nil
}

// --- Context Keys ---

const (
	ctxKeyBypassed       = "og_bypassed"
	ctxKeyConsumerID     = "og_consumer_id"
	ctxKeyConsumerGroup  = "og_consumer_group"
	ctxKeyIsStreaming     = "og_is_streaming"
	ctxKeyRequestBody    = "og_request_body"
	ctxKeyResponseBody   = "og_response_body"
	ctxKeySessionID      = "og_session_id"
	ctxKeyRestoreMapping = "og_restore_mapping"
	ctxKeyInputMessages  = "og_input_messages"
	ctxKeyResponseSent   = "og_response_sent"
	ctxKeyStreamBuffer   = "og_stream_buffer"
	ctxKeyPendingProxy   = "og_pending_proxy"
)

// --- Request Headers Handler ---

func onHttpRequestHeaders(ctx wrapper.HttpContext, config PluginConfig) types.Action {
	// Check for bypass token
	bypassToken, _ := proxywasm.GetHttpRequestHeader("X-OG-Bypass-Token")
	if bypassToken != "" {
		proxywasm.LogWarnf("[OG-REQ-HDR] BYPASS: detected bypass token, skipping detection")
		ctx.SetContext(ctxKeyBypassed, true)
		_ = proxywasm.RemoveHttpRequestHeader("X-OG-Bypass-Token")
		ctx.DontReadRequestBody()
		ctx.DontReadResponseBody()
		return types.ActionContinue
	}

	// Auto-discovery: x-mse-consumer → application, x-mse-consumer-group → workspace
	// OG platform will auto-create application/workspace and assign app to workspace
	consumerID, _ := proxywasm.GetHttpRequestHeader("x-mse-consumer")
	if consumerID != "" {
		ctx.SetContext(ctxKeyConsumerID, consumerID)
		proxywasm.LogInfof("[OG-REQ-HDR] Consumer ID: %s", consumerID)
	}

	consumerGroup, _ := proxywasm.GetHttpRequestHeader("x-mse-consumer-group")
	if consumerGroup != "" {
		ctx.SetContext(ctxKeyConsumerGroup, consumerGroup)
		proxywasm.LogInfof("[OG-REQ-HDR] Consumer Group: %s", consumerGroup)
	}

	// Remove Content-Length as we may modify the body
	_ = proxywasm.RemoveHttpRequestHeader("content-length")
	// Remove Accept-Encoding to prevent compressed responses
	_ = proxywasm.RemoveHttpRequestHeader("accept-encoding")

	if !config.enableInputDetection {
		ctx.DontReadRequestBody()
		return types.ActionContinue
	}

	return types.HeaderStopIteration
}

// --- Request Body Handler ---

func onHttpRequestBody(ctx wrapper.HttpContext, config PluginConfig, body []byte) types.Action {
	if ctx.GetBoolContext(ctxKeyBypassed, false) {
		return types.ActionContinue
	}

	if len(body) == 0 {
		proxywasm.LogWarnf("[OG-REQ-BODY] Empty body, passing through")
		return types.ActionContinue
	}

	// Store request body for later use
	ctx.SetContext(ctxKeyRequestBody, body)

	// Parse messages
	bodyJSON := gjson.ParseBytes(body)
	messages := bodyJSON.Get("messages")
	if !messages.Exists() || !messages.IsArray() {
		proxywasm.LogWarnf("[OG-REQ-BODY] No messages found, passing through")
		return types.ActionContinue
	}

	// Check if streaming
	isStreaming := bodyJSON.Get("stream").Bool()
	ctx.SetContext(ctxKeyIsStreaming, isStreaming)

	// Store input messages JSON string for output detection context
	ctx.SetContext(ctxKeyInputMessages, messages.Raw)

	proxywasm.LogWarnf("[OG-REQ-BODY] Parsed %d messages, streaming=%v", len(messages.Array()), isStreaming)

	// Build OG input request
	inputReq := buildInputRequest(messages.Raw, config.applicationID, ctx)

	// Mirror to test OG (fire-and-forget, before production call)
	mirrorToTestOG(ctx, config, "/v1/gateway/process-input", []byte(inputReq))

	callOGAPI(ctx, config, "/v1/gateway/process-input", []byte(inputReq), func(statusCode int, responseBody []byte) {
		handleInputResponse(ctx, config, statusCode, responseBody)
	})

	return types.ActionPause
}

// --- Response Headers Handler ---

func onHttpResponseHeaders(ctx wrapper.HttpContext, config PluginConfig) types.Action {
	if ctx.GetBoolContext(ctxKeyResponseSent, false) {
		return types.ActionContinue
	}
	if ctx.GetBoolContext(ctxKeyBypassed, false) {
		ctx.DontReadResponseBody()
		return types.ActionContinue
	}

	// Remove Content-Length as we may modify the response
	_ = proxywasm.RemoveHttpResponseHeader("content-length")

	// Check if this is a streaming response
	contentType, _ := proxywasm.GetHttpResponseHeader("content-type")
	isSSE := containsStr(contentType, "text/event-stream")

	if isSSE {
		// Streaming: let chunks flow through onStreamingResponseBody
		// Placeholder restoration is handled per-SSE-event with smart buffering
		return types.ActionContinue
	}

	// Non-streaming: need to check if we should process the response body
	needOutput := config.enableOutputDetection
	restoreMapping := ctx.GetContext(ctxKeyRestoreMapping)
	sessionID := ctx.GetStringContext(ctxKeySessionID, "")

	if !needOutput && restoreMapping == nil && sessionID == "" {
		ctx.DontReadResponseBody()
		return types.ActionContinue
	}

	// Buffer the full response for non-streaming output processing
	ctx.BufferResponseBody()
	return types.HeaderStopIteration
}

// --- Response Body Handler (Non-Streaming) ---

func onHttpResponseBody(ctx wrapper.HttpContext, config PluginConfig, body []byte) types.Action {
	if ctx.GetBoolContext(ctxKeyResponseSent, false) {
		return types.ActionContinue
	}
	if ctx.GetBoolContext(ctxKeyBypassed, false) {
		return types.ActionContinue
	}

	// Non-streaming response: extract content for output detection
	bodyJSON := gjson.ParseBytes(body)
	content := bodyJSON.Get("choices.0.message.content").String()
	if content == "" {
		proxywasm.LogWarnf("[OG-RSP-BODY] No content in response, passing through")
		return types.ActionContinue
	}

	// Store response body for rebuild
	ctx.SetContext(ctxKeyResponseBody, body)

	outputReq := buildOutputRequest(content, ctx, config.applicationID)

	// Mirror to test OG (fire-and-forget)
	mirrorToTestOG(ctx, config, "/v1/gateway/process-output", []byte(outputReq))

	callOGAPI(ctx, config, "/v1/gateway/process-output", []byte(outputReq), func(statusCode int, responseBody []byte) {
		handleOutputResponse(ctx, config, statusCode, responseBody, false)
	})

	return types.ActionPause
}

// --- Streaming Response Body Handler ---

func onStreamingResponseBody(ctx wrapper.HttpContext, config PluginConfig, chunk []byte, isLastChunk bool) []byte {
	if ctx.GetBoolContext(ctxKeyBypassed, false) {
		return chunk
	}

	// Get restore mapping - if none, pass through
	mappingRaw := ctx.GetContext(ctxKeyRestoreMapping)
	if mappingRaw == nil {
		return chunk
	}

	mapping, ok := mappingRaw.(map[string]string)
	if !ok || len(mapping) == 0 {
		return chunk
	}

	// Get or create stream restorer
	restorerRaw := ctx.GetContext(ctxKeyStreamBuffer)
	var restorer *StreamRestorer
	if restorerRaw != nil {
		restorer = restorerRaw.(*StreamRestorer)
	} else {
		restorer = NewStreamRestorer(mapping)
		ctx.SetContext(ctxKeyStreamBuffer, restorer)
	}

	return restorer.ProcessChunk(chunk, isLastChunk)
}

// --- OG API Client ---

func callOGAPI(ctx wrapper.HttpContext, config PluginConfig, path string, body []byte, callback func(statusCode int, responseBody []byte)) {
	headers := [][2]string{
		{"Content-Type", "application/json"},
		{"Authorization", "Bearer " + config.ogAPIKey},
	}

	consumerID := ctx.GetStringContext(ctxKeyConsumerID, "")
	if consumerID != "" {
		headers = append(headers, [2]string{"X-OG-Application-ID", consumerID})
	}

	consumerGroup := ctx.GetStringContext(ctxKeyConsumerGroup, "")
	if consumerGroup != "" {
		headers = append(headers, [2]string{"X-OG-Workspace-ID", consumerGroup})
	}

	proxywasm.LogWarnf("[OG-API] Calling %s, body_len=%d", path, len(body))

	err := config.client.Post(path, headers, body, func(statusCode int, responseHeaders http.Header, responseBody []byte) {
		proxywasm.LogWarnf("[OG-API] Response from %s: status=%d, body_len=%d", path, statusCode, len(responseBody))
		callback(statusCode, responseBody)
	}, config.timeoutMs)

	if err != nil {
		proxywasm.LogErrorf("[OG-API] Failed to call %s: %v", path, err)
		proxywasm.ResumeHttpRequest()
	}
}

// --- Traffic Mirror (fire-and-forget) ---

func mirrorToTestOG(ctx wrapper.HttpContext, config PluginConfig, path string, body []byte) {
	if !config.enableMirror {
		return
	}

	headers := [][2]string{
		{"Content-Type", "application/json"},
		{"Authorization", "Bearer " + config.mirrorAPIKey},
	}

	consumerID := ctx.GetStringContext(ctxKeyConsumerID, "")
	if consumerID != "" {
		headers = append(headers, [2]string{"X-OG-Application-ID", consumerID})
	}
	consumerGroup := ctx.GetStringContext(ctxKeyConsumerGroup, "")
	if consumerGroup != "" {
		headers = append(headers, [2]string{"X-OG-Workspace-ID", consumerGroup})
	}

	proxywasm.LogInfof("[OG-MIRROR] Sending to %s, body_len=%d", path, len(body))

	err := config.mirrorClient.Post(path, headers, body, func(statusCode int, responseHeaders http.Header, responseBody []byte) {
		proxywasm.LogInfof("[OG-MIRROR] Response from %s: status=%d", path, statusCode)
	}, config.timeoutMs)

	if err != nil {
		proxywasm.LogWarnf("[OG-MIRROR] Failed to call %s: %v (non-blocking)", path, err)
	}
}

// --- Input Response Handler ---

func handleInputResponse(ctx wrapper.HttpContext, config PluginConfig, statusCode int, body []byte) {
	if statusCode != 200 {
		proxywasm.LogErrorf("[OG-INPUT-RSP] Non-200 response: status=%d", statusCode)
		proxywasm.ResumeHttpRequest()
		return
	}

	resp := gjson.ParseBytes(body)
	action := resp.Get("action").String()

	proxywasm.LogWarnf("[OG-INPUT-RSP] action=%s, request_id=%s", action, resp.Get("request_id").String())

	// Save session_id and restore_mapping
	if v := resp.Get("session_id"); v.Exists() {
		ctx.SetContext(ctxKeySessionID, v.String())
	}
	if v := resp.Get("restore_mapping"); v.Exists() && v.IsObject() {
		mapping := make(map[string]string)
		v.ForEach(func(key, value gjson.Result) bool {
			mapping[key.String()] = value.String()
			return true
		})
		if len(mapping) > 0 {
			ctx.SetContext(ctxKeyRestoreMapping, mapping)
			proxywasm.LogWarnf("[OG-INPUT-RSP] Stored restore_mapping with %d entries", len(mapping))
		}
	}

	switch action {
	case "block":
		sendActionResponse(ctx, resp, "block_response")

	case "replace":
		sendActionResponse(ctx, resp, "replace_response")

	case "anonymize":
		anonymizedMessages := resp.Get("anonymized_messages")
		if anonymizedMessages.Exists() {
			reqBody := ctx.GetContext(ctxKeyRequestBody)
			if reqBody != nil {
				origBody := reqBody.([]byte)
				newBody, _ := sjsonSetRaw(string(origBody), "messages", anonymizedMessages.Raw)
				proxywasm.LogWarnf("[OG-INPUT-RSP] ANONYMIZE: replacing body, old_len=%d, new_len=%d", len(origBody), len(newBody))
				_ = proxywasm.ReplaceHttpRequestBody([]byte(newBody))
			}
		}
		proxywasm.ResumeHttpRequest()

	case "proxy_response":
		proxyResp := resp.Get("proxy_response")
		if !proxyResp.Exists() {
			proxywasm.LogErrorf("[OG-INPUT-RSP] proxy_response action but no proxy_response data")
			proxywasm.ResumeHttpRequest()
			return
		}

		if config.enableOutputDetection {
			// Extract content for output detection
			proxyBody := proxyResp.Get("body").String()
			proxyContent := gjson.Get(proxyBody, "choices.0.message.content").String()
			if proxyContent != "" {
				// Store proxy response for later
				ctx.SetContext(ctxKeyPendingProxy, proxyResp.Raw)
				outputReq := buildOutputRequest(proxyContent, ctx, config.applicationID)
				callOGAPI(ctx, config, "/v1/gateway/process-output", []byte(outputReq), func(sc int, rb []byte) {
					handleOutputResponse(ctx, config, sc, rb, true)
				})
				return
			}
		}

		// Return proxy response directly
		sendProxyResponse(ctx, proxyResp)

	case "switch_private_model":
		// Add bypass token
		if bypassToken := resp.Get("bypass_token"); bypassToken.Exists() {
			headerName := resp.Get("bypass_header").String()
			if headerName == "" {
				headerName = "X-OG-Bypass-Token"
			}
			_ = proxywasm.AddHttpRequestHeader(headerName, bypassToken.String())
		}

		// Switch to private model
		if pm := resp.Get("private_model"); pm.Exists() {
			modelName := pm.Get("model_name").String()

			if apiKey := pm.Get("api_key"); apiKey.Exists() {
				_ = proxywasm.ReplaceHttpRequestHeader("authorization", "Bearer "+apiKey.String())
			}
			if provider := pm.Get("provider"); provider.Exists() {
				_ = proxywasm.ReplaceHttpRequestHeader("x-higress-llm-provider", provider.String())
			}
			_ = proxywasm.ReplaceHttpRequestHeader("x-higress-llm-model", modelName)

			if cluster := pm.Get("higress_cluster"); cluster.Exists() {
				_ = proxywasm.SetProperty([]string{"cluster_name"}, []byte(cluster.String()))
			}

			// Update model in request body
			reqBody := ctx.GetContext(ctxKeyRequestBody)
			if reqBody != nil {
				origBody := string(reqBody.([]byte))
				newBody, _ := sjsonSet(origBody, "model", modelName)
				_ = proxywasm.ReplaceHttpRequestBody([]byte(newBody))
			}

			proxywasm.LogWarnf("[OG-INPUT-RSP] SWITCH_PRIVATE_MODEL: model=%s", modelName)
		}
		proxywasm.ResumeHttpRequest()

	default: // "pass"
		proxywasm.LogWarnf("[OG-INPUT-RSP] PASS: resuming request")
		proxywasm.ResumeHttpRequest()
	}
}

// --- Output Response Handler ---

func handleOutputResponse(ctx wrapper.HttpContext, config PluginConfig, statusCode int, body []byte, isProxyResponse bool) {
	if statusCode != 200 {
		proxywasm.LogErrorf("[OG-OUTPUT-RSP] Non-200 response: status=%d", statusCode)
		if isProxyResponse {
			returnPendingProxyResponse(ctx)
		} else {
			proxywasm.ResumeHttpResponse()
		}
		return
	}

	resp := gjson.ParseBytes(body)
	action := resp.Get("action").String()

	proxywasm.LogWarnf("[OG-OUTPUT-RSP] action=%s, is_proxy=%v", action, isProxyResponse)

	if isProxyResponse {
		handleProxyOutputResponse(ctx, resp, action)
		return
	}

	// Normal upstream response handling
	switch action {
	case "block":
		if blockResp := resp.Get("block_response"); blockResp.Exists() {
			_ = proxywasm.ReplaceHttpResponseBody([]byte(blockResp.Get("body").String()))
		}

	case "anonymize":
		if anonymized := resp.Get("anonymized_content"); anonymized.Exists() {
			rebuildAndReplaceResponseBody(ctx, anonymized.String())
		}

	case "restore":
		if restored := resp.Get("restored_content"); restored.Exists() {
			rebuildAndReplaceResponseBody(ctx, restored.String())
		}

	default: // "pass"
		proxywasm.LogWarnf("[OG-OUTPUT-RSP] PASS: no modification")
	}

	proxywasm.ResumeHttpResponse()
}

func handleProxyOutputResponse(ctx wrapper.HttpContext, resp gjson.Result, action string) {
	pendingRaw := ctx.GetContext(ctxKeyPendingProxy)
	if pendingRaw == nil {
		proxywasm.LogErrorf("[OG-OUTPUT-RSP] No pending proxy response found")
		proxywasm.ResumeHttpRequest()
		return
	}
	proxyResp := gjson.Parse(pendingRaw.(string))

	switch action {
	case "block":
		if blockResp := resp.Get("block_response"); blockResp.Exists() {
			sendHTTPResponse(ctx, blockResp)
		} else {
			sendProxyResponse(ctx, proxyResp)
		}

	case "restore":
		if restored := resp.Get("restored_content"); restored.Exists() {
			proxyBody := proxyResp.Get("body").String()
			newBody := rebuildContentInJSON(proxyBody, restored.String())
			code := int(proxyResp.Get("code").Int())
			if code == 0 {
				code = 200
			}
			ct := proxyResp.Get("content_type").String()
			if ct == "" {
				ct = "application/json"
			}
			ctx.SetContext(ctxKeyResponseSent, true)
			_ = proxywasm.SendHttpResponseWithDetail(uint32(code), "og-connector.restore", [][2]string{{"content-type", ct}}, []byte(newBody), -1)
		} else {
			sendProxyResponse(ctx, proxyResp)
		}

	default: // "pass"
		sendProxyResponse(ctx, proxyResp)
	}
}

// --- Helper Functions ---

func buildInputRequest(messagesRaw string, applicationID string, ctx wrapper.HttpContext) string {
	var b stringBuilder
	b.WriteString(`{"messages":`)
	b.WriteString(messagesRaw)
	if applicationID != "" {
		b.WriteString(`,"application_id":"`)
		b.WriteString(escapeJSON(applicationID))
		b.WriteString(`"`)
	}
	b.WriteString(`}`)
	return b.String()
}

func buildOutputRequest(content string, ctx wrapper.HttpContext, applicationID string) string {
	var b stringBuilder
	b.WriteString(`{"content":"`)
	b.WriteString(escapeJSON(content))
	b.WriteString(`"`)

	sessionID := ctx.GetStringContext(ctxKeySessionID, "")
	if sessionID != "" {
		b.WriteString(`,"session_id":"`)
		b.WriteString(escapeJSON(sessionID))
		b.WriteString(`"`)
	}

	// Include restore_mapping
	mappingRaw := ctx.GetContext(ctxKeyRestoreMapping)
	if mappingRaw != nil {
		if mapping, ok := mappingRaw.(map[string]string); ok && len(mapping) > 0 {
			b.WriteString(`,"restore_mapping":{`)
			first := true
			for k, v := range mapping {
				if !first {
					b.WriteString(",")
				}
				b.WriteString(`"`)
				b.WriteString(escapeJSON(k))
				b.WriteString(`":"`)
				b.WriteString(escapeJSON(v))
				b.WriteString(`"`)
				first = false
			}
			b.WriteString(`}`)
		}
	}

	if applicationID != "" {
		b.WriteString(`,"application_id":"`)
		b.WriteString(escapeJSON(applicationID))
		b.WriteString(`"`)
	}

	// Include input messages as context
	inputMsgRaw := ctx.GetStringContext(ctxKeyInputMessages, "")
	if inputMsgRaw != "" {
		b.WriteString(`,"messages":`)
		b.WriteString(inputMsgRaw)
	}

	b.WriteString(`}`)
	return b.String()
}

func sendActionResponse(ctx wrapper.HttpContext, resp gjson.Result, field string) {
	actionResp := resp.Get(field)
	if !actionResp.Exists() {
		proxywasm.LogErrorf("[OG-INPUT-RSP] %s action but no %s data", field, field)
		proxywasm.ResumeHttpRequest()
		return
	}
	sendHTTPResponse(ctx, actionResp)
}

func sendHTTPResponse(ctx wrapper.HttpContext, resp gjson.Result) {
	code := int(resp.Get("code").Int())
	if code == 0 {
		code = 200
	}
	body := resp.Get("body").String()

	// If the original request was streaming, wrap the block response in SSE format
	// so streaming clients (Cherry Studio, etc.) can parse it correctly
	isStreaming := ctx.GetBoolContext(ctxKeyIsStreaming, false)
	if isStreaming {
		sseBody := convertToSSE(body)
		ctx.SetContext(ctxKeyResponseSent, true)
		_ = proxywasm.SendHttpResponseWithDetail(uint32(code), "og-connector.action",
			[][2]string{
				{"content-type", "text/event-stream"},
				{"cache-control", "no-cache"},
				{"x-accel-buffering", "no"},
			}, []byte(sseBody), -1)
		return
	}

	ct := resp.Get("content_type").String()
	if ct == "" {
		ct = "application/json"
	}
	ctx.SetContext(ctxKeyResponseSent, true)
	_ = proxywasm.SendHttpResponseWithDetail(uint32(code), "og-connector.action", [][2]string{{"content-type", ct}}, []byte(body), -1)
}

// convertToSSE wraps a ChatCompletion JSON response into SSE format.
// Converts message.content to a streaming chunk with delta.content.
func convertToSSE(body string) string {
	parsed := gjson.Parse(body)
	content := parsed.Get("choices.0.message.content").String()
	id := parsed.Get("id").String()
	model := parsed.Get("model").String()

	// Build a streaming chunk with the block message as content
	var b stringBuilder
	b.WriteString("data: {\"id\":\"")
	b.WriteString(escapeJSON(id))
	b.WriteString("\",\"object\":\"chat.completion.chunk\",\"model\":\"")
	b.WriteString(escapeJSON(model))
	b.WriteString("\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"")
	b.WriteString(escapeJSON(content))
	b.WriteString("\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	return b.String()
}

func sendProxyResponse(ctx wrapper.HttpContext, proxyResp gjson.Result) {
	code := int(proxyResp.Get("code").Int())
	if code == 0 {
		code = 200
	}
	body := proxyResp.Get("body").String()

	// If the original request was streaming, wrap in SSE format
	isStreaming := ctx.GetBoolContext(ctxKeyIsStreaming, false)
	if isStreaming {
		sseBody := convertToSSE(body)
		ctx.SetContext(ctxKeyResponseSent, true)
		_ = proxywasm.SendHttpResponseWithDetail(uint32(code), "og-connector.proxy",
			[][2]string{
				{"content-type", "text/event-stream"},
				{"cache-control", "no-cache"},
				{"x-accel-buffering", "no"},
			}, []byte(sseBody), -1)
		return
	}

	ct := proxyResp.Get("content_type").String()
	if ct == "" {
		ct = "application/json"
	}
	ctx.SetContext(ctxKeyResponseSent, true)
	_ = proxywasm.SendHttpResponseWithDetail(uint32(code), "og-connector.proxy", [][2]string{{"content-type", ct}}, []byte(body), -1)
}

func returnPendingProxyResponse(ctx wrapper.HttpContext) {
	pendingRaw := ctx.GetContext(ctxKeyPendingProxy)
	if pendingRaw != nil {
		proxyResp := gjson.Parse(pendingRaw.(string))
		sendProxyResponse(ctx, proxyResp)
	} else {
		proxywasm.ResumeHttpResponse()
	}
}

func rebuildAndReplaceResponseBody(ctx wrapper.HttpContext, newContent string) {
	respBody := ctx.GetContext(ctxKeyResponseBody)
	if respBody != nil {
		origBody := string(respBody.([]byte))
		newBody := rebuildContentInJSON(origBody, newContent)
		_ = proxywasm.ReplaceHttpResponseBody([]byte(newBody))
	}
}

func rebuildContentInJSON(jsonBody string, newContent string) string {
	result, err := sjsonSet(jsonBody, "choices.0.message.content", newContent)
	if err != nil {
		return jsonBody
	}
	return result
}

func containsStr(s, substr string) bool {
	if len(substr) > len(s) {
		return false
	}
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
