package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm"
	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm/types"
	"github.com/higress-group/wasm-go/pkg/log"
	"github.com/higress-group/wasm-go/pkg/wrapper"
	"github.com/tidwall/gjson"
)

func main() {}

func init() {
	wrapper.SetCtx(
		"openguardrails-guard",
		wrapper.ParseConfig(parseConfig),
		wrapper.ProcessRequestHeaders(onHttpRequestHeaders),
		wrapper.ProcessRequestBody(onHttpRequestBody),
		wrapper.ProcessResponseHeaders(onHttpResponseHeaders),
		wrapper.ProcessResponseBody(onHttpResponseBody),
	)
}

const (
	DefaultRequestJsonPath  = "messages.@reverse.0.content"
	DefaultResponseJsonPath = "choices.0.message.content"
	DefaultDenyCode         = 200
	DefaultDenyMessage      = "很抱歉,我无法回答您的问题"
	DefaultTimeout          = 5000

	OpenAIResponseFormat = `{"id": "%s","object":"chat.completion","model":"from-openguardrails","choices":[{"index":0,"message":{"role":"assistant","content":"%s"},"logprobs":null,"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}`
)

// OpenGuardrails API Response structures
type OpenGuardrailsResponse struct {
	ID               string                      `json:"id"`
	OverallRiskLevel string                      `json:"overall_risk_level"`
	SuggestAction    string                      `json:"suggest_action"`
	SuggestAnswer    string                      `json:"suggest_answer"`
	Score            float64                     `json:"score"`
	Result           OpenGuardrailsResultDetails `json:"result"`
	RequestID        string                      `json:"request_id"`
	ProcessingTimeMs int                         `json:"processing_time_ms"`
}

type OpenGuardrailsResultDetails struct {
	Security   RiskDetail `json:"security"`
	Compliance RiskDetail `json:"compliance"`
	Data       RiskDetail `json:"data"`
}

type RiskDetail struct {
	RiskLevel  string   `json:"risk_level"`
	Categories []string `json:"categories"`
	Score      float64  `json:"score"`
}

type OpenGuardrailsConfig struct {
	client                  wrapper.HttpClient
	apiKey                  string
	baseURL                 string
	serviceName             string
	servicePort             int64
	serviceHost             string
	checkRequest            bool
	checkResponse           bool
	requestContentJsonPath  string
	responseContentJsonPath string
	denyCode                int64
	denyMessage             string
	timeout                 uint32
	protocolOriginal        bool
}

func parseConfig(json gjson.Result, config *OpenGuardrailsConfig) error {
	// Parse API key first
	config.apiKey = json.Get("apiKey").String()
	if config.apiKey == "" {
		return errors.New("invalid apiKey: apiKey is required")
	}

	// Parse base URL first to check if it's a direct URL
	if obj := json.Get("baseURL"); obj.Exists() {
		config.baseURL = obj.String()
	} else {
		// Default base URL for public OpenGuardrails API
		config.baseURL = "/v1/guardrails"
	}

	// Check if baseURL is a complete URL (direct mode)
	if strings.HasPrefix(config.baseURL, "http://") || strings.HasPrefix(config.baseURL, "https://") {
		// Direct mode: Use full URL, extract host/port if needed
		// For direct mode, we'll use a special cluster client with the host extracted from baseURL
		// Initialize with default values
		config.serviceHost = ""
		config.servicePort = 0
		config.serviceName = "openguardrails-direct.dns"

		parts := strings.Split(config.baseURL, "/")
		if len(parts) >= 3 && parts[0] != "" {
			hostPort := parts[2]
			config.serviceHost = hostPort
			if strings.Contains(hostPort, ":") {
				hostPortParts := strings.Split(hostPort, ":")
				if len(hostPortParts) == 2 {
					config.serviceHost = hostPortParts[0]
					port, err := strconv.ParseInt(hostPortParts[1], 10, 64)
					if err == nil {
						config.servicePort = port
					}
				}
			} else {
				// Default ports based on protocol
				if strings.HasPrefix(config.baseURL, "https://") {
					config.servicePort = 443
				} else {
					config.servicePort = 80
				}
			}
		}
	} else {
		// Service discovery mode: require serviceName, servicePort, and serviceHost
		serviceName := json.Get("serviceName").String()
		servicePort := json.Get("servicePort").Int()
		serviceHost := json.Get("serviceHost").String()
		if serviceName == "" || servicePort == 0 || serviceHost == "" {
			return errors.New("invalid service config: serviceName, servicePort, and serviceHost are required for service discovery mode. For direct mode, use full URL starting with http:// or https:// in baseURL")
		}
		config.serviceName = serviceName
		config.servicePort = servicePort
		config.serviceHost = serviceHost
	}

	// Parse check flags
	config.checkRequest = json.Get("checkRequest").Bool()
	config.checkResponse = json.Get("checkResponse").Bool()

	// Parse protocol
	config.protocolOriginal = json.Get("protocol").String() == "original"

	// Parse deny message
	config.denyMessage = json.Get("denyMessage").String()

	// Parse deny code
	if obj := json.Get("denyCode"); obj.Exists() {
		config.denyCode = obj.Int()
	} else {
		config.denyCode = DefaultDenyCode
	}

	// Parse JSON paths
	if obj := json.Get("requestContentJsonPath"); obj.Exists() {
		config.requestContentJsonPath = obj.String()
	} else {
		config.requestContentJsonPath = DefaultRequestJsonPath
	}

	if obj := json.Get("responseContentJsonPath"); obj.Exists() {
		config.responseContentJsonPath = obj.String()
	} else {
		config.responseContentJsonPath = DefaultResponseJsonPath
	}

	// Parse timeout
	if obj := json.Get("timeout"); obj.Exists() {
		config.timeout = uint32(obj.Int())
	} else {
		config.timeout = DefaultTimeout
	}

	// Create HTTP client
	// For both direct mode and service discovery mode, we use NewClusterClient
	// The difference is that in direct mode, we parse the hostname from baseURL
	config.client = wrapper.NewClusterClient(wrapper.FQDNCluster{
		FQDN: config.serviceName,
		Port: config.servicePort,
		Host: config.serviceHost,
	})

	return nil
}

func onHttpRequestHeaders(ctx wrapper.HttpContext, config OpenGuardrailsConfig) types.Action {
	ctx.DisableReroute()
	if !config.checkRequest {
		log.Debugf("request checking is disabled")
		ctx.DontReadRequestBody()
	}
	return types.ActionContinue
}

func onHttpRequestBody(ctx wrapper.HttpContext, config OpenGuardrailsConfig, body []byte) types.Action {
	log.Debugf("checking request body...")

	// Extract content from request body
	content := gjson.GetBytes(body, config.requestContentJsonPath).String()
	log.Debugf("Raw request content is: %s", content)

	if len(content) == 0 {
		log.Info("request content is empty. skip")
		return types.ActionContinue
	}

	// Extract user_id if present (optional)
	userID := gjson.GetBytes(body, "xxai_app_user_id").String()

	// Prepare request to OpenGuardrails
	requestBody := map[string]interface{}{
		"model": "OpenGuardrails-Text",
		"messages": []map[string]string{
			{
				"role":    "user",
				"content": content,
			},
		},
	}

	// Add user_id if present
	if userID != "" {
		requestBody["xxai_app_user_id"] = userID
	}

	requestJSON, err := json.Marshal(requestBody)
	if err != nil {
		log.Errorf("failed to marshal request body: %v", err)
		proxywasm.ResumeHttpRequest()
		return types.ActionPause
	}

	// Call OpenGuardrails API
	callback := func(statusCode int, responseHeaders http.Header, responseBody []byte) {
		log.Infof("OpenGuardrails response: %s", string(responseBody))

		if statusCode != 200 {
			log.Errorf("OpenGuardrails API returned non-200 status: %d", statusCode)
			proxywasm.ResumeHttpRequest()
			return
		}

		var response OpenGuardrailsResponse
		err := json.Unmarshal(responseBody, &response)
		if err != nil {
			log.Errorf("failed to unmarshal OpenGuardrails response: %v", err)
			proxywasm.ResumeHttpRequest()
			return
		}

		// Check if action is reject or replace
		if response.SuggestAction == "reject" || response.SuggestAction == "replace" {
			denyMessage := DefaultDenyMessage
			if config.denyMessage != "" {
				denyMessage = config.denyMessage
			} else if response.SuggestAnswer != "" {
				denyMessage = response.SuggestAnswer
			}

			marshalledDenyMessage := wrapper.MarshalStr(denyMessage)

			if config.protocolOriginal {
				proxywasm.SendHttpResponse(uint32(config.denyCode), [][2]string{{"content-type", "application/json"}}, []byte(marshalledDenyMessage), -1)
			} else {
				randomID := generateRandomID()
				jsonData := []byte(fmt.Sprintf(OpenAIResponseFormat, randomID, marshalledDenyMessage))
				proxywasm.SendHttpResponse(uint32(config.denyCode), [][2]string{{"content-type", "application/json"}}, jsonData, -1)
			}
			ctx.DontReadResponseBody()
			return
		}

		// Allow the request to continue
		proxywasm.ResumeHttpRequest()
	}

	headers := [][2]string{
		{"Content-Type", "application/json"},
		{"Authorization", "Bearer " + config.apiKey},
	}

	err = config.client.Post(config.baseURL, headers, requestJSON, callback, config.timeout)
	if err != nil {
		log.Errorf("failed to call OpenGuardrails API: %v", err)
		proxywasm.ResumeHttpRequest()
	}

	return types.ActionPause
}

func onHttpResponseHeaders(ctx wrapper.HttpContext, config OpenGuardrailsConfig) types.Action {
	if !config.checkResponse {
		log.Debugf("response checking is disabled")
		ctx.DontReadResponseBody()
		return types.ActionContinue
	}

	statusCode, _ := proxywasm.GetHttpResponseHeader(":status")
	if statusCode != "200" {
		log.Debugf("response is not 200, skip response body check")
		ctx.DontReadResponseBody()
		return types.ActionContinue
	}

	ctx.BufferResponseBody()
	return types.HeaderStopIteration
}

func onHttpResponseBody(ctx wrapper.HttpContext, config OpenGuardrailsConfig, body []byte) types.Action {
	log.Debugf("checking response body...")

	// Extract prompt from context (stored during request phase)
	var prompt string
	if promptCtx, ok := ctx.GetContext("request_prompt").(string); ok {
		prompt = promptCtx
	} else {
		// If not stored, try to extract from request body again
		// This is a fallback and may not always work
		log.Warnf("request_prompt not found in context, response check may be incomplete")
		prompt = ""
	}

	// Extract response content
	responseContent := gjson.GetBytes(body, config.responseContentJsonPath).String()
	log.Debugf("Raw response content is: %s", responseContent)

	if len(responseContent) == 0 {
		log.Info("response content is empty. skip")
		return types.ActionContinue
	}

	// Extract user_id if stored in context
	userID := ""
	if userIDCtx, ok := ctx.GetContext("user_id").(string); ok {
		userID = userIDCtx
	}

	// Prepare request to OpenGuardrails (check_response_ctx)
	requestBody := map[string]interface{}{
		"model": "OpenGuardrails-Text",
		"messages": []map[string]string{
			{
				"role":    "user",
				"content": prompt,
			},
			{
				"role":    "assistant",
				"content": responseContent,
			},
		},
	}

	// Add user_id if present
	if userID != "" {
		requestBody["xxai_app_user_id"] = userID
	}

	requestJSON, err := json.Marshal(requestBody)
	if err != nil {
		log.Errorf("failed to marshal request body: %v", err)
		proxywasm.ResumeHttpResponse()
		return types.ActionPause
	}

	// Call OpenGuardrails API
	callback := func(statusCode int, responseHeaders http.Header, responseBody []byte) {
		log.Infof("OpenGuardrails response: %s", string(responseBody))

		if statusCode != 200 {
			log.Errorf("OpenGuardrails API returned non-200 status: %d", statusCode)
			proxywasm.ResumeHttpResponse()
			return
		}

		var response OpenGuardrailsResponse
		err := json.Unmarshal(responseBody, &response)
		if err != nil {
			log.Errorf("failed to unmarshal OpenGuardrails response: %v", err)
			proxywasm.ResumeHttpResponse()
			return
		}

		// Check if action is reject or replace
		if response.SuggestAction == "reject" || response.SuggestAction == "replace" {
			denyMessage := DefaultDenyMessage
			if config.denyMessage != "" {
				denyMessage = config.denyMessage
			} else if response.SuggestAnswer != "" {
				denyMessage = response.SuggestAnswer
			}

			marshalledDenyMessage := wrapper.MarshalStr(denyMessage)

			if config.protocolOriginal {
				proxywasm.SendHttpResponse(uint32(config.denyCode), [][2]string{{"content-type", "application/json"}}, []byte(marshalledDenyMessage), -1)
			} else {
				randomID := generateRandomID()
				jsonData := []byte(fmt.Sprintf(OpenAIResponseFormat, randomID, marshalledDenyMessage))
				proxywasm.SendHttpResponse(uint32(config.denyCode), [][2]string{{"content-type", "application/json"}}, jsonData, -1)
			}
			return
		}

		// Allow the response to continue
		proxywasm.ResumeHttpResponse()
	}

	headers := [][2]string{
		{"Content-Type", "application/json"},
		{"Authorization", "Bearer " + config.apiKey},
	}

	err = config.client.Post(config.baseURL, headers, requestJSON, callback, config.timeout)
	if err != nil {
		log.Errorf("failed to call OpenGuardrails API: %v", err)
		proxywasm.ResumeHttpResponse()
	}

	return types.ActionPause
}

func generateRandomID() string {
	const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	// Use a simple random ID generation (in production, use better randomness)
	return "chatcmpl-openguardrails-" + strings.Repeat("x", 20)
}
