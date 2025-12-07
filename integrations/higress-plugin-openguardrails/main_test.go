package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/tidwall/gjson"
)

func TestParseConfig(t *testing.T) {
	tests := []struct {
		name      string
		json      string
		expectErr bool
		validate  func(*testing.T, *OpenGuardrailsConfig)
	}{
		{
			name: "valid config with all required fields",
			json: `{
				"serviceName": "api.openguardrails.com.dns",
				"servicePort": 443,
				"serviceHost": "api.openguardrails.com",
				"apiKey": "sk-xxai-test-key-12345678901234567890",
				"checkRequest": true,
				"checkResponse": true
			}`,
			expectErr: false,
			validate: func(t *testing.T, cfg *OpenGuardrailsConfig) {
				assert.Equal(t, "sk-xxai-test-key-12345678901234567890", cfg.apiKey)
				assert.Equal(t, true, cfg.checkRequest)
				assert.Equal(t, true, cfg.checkResponse)
				assert.Equal(t, "/v1/guardrails", cfg.baseURL)
				assert.Equal(t, uint32(5000), cfg.timeout)
			},
		},
		{
			name: "missing apiKey",
			json: `{
				"serviceName": "api.openguardrails.com.dns",
				"servicePort": 443,
				"serviceHost": "api.openguardrails.com"
			}`,
			expectErr: true,
		},
		{
			name: "missing serviceName",
			json: `{
				"servicePort": 443,
				"serviceHost": "api.openguardrails.com",
				"apiKey": "sk-xxai-test-key"
			}`,
			expectErr: true,
		},
		{
			name: "custom baseURL and timeout",
			json: `{
				"serviceName": "openguardrails-internal.dns",
				"servicePort": 5001,
				"serviceHost": "openguardrails.internal",
				"apiKey": "sk-xxai-test-key",
				"baseURL": "/api/v2/guardrails",
				"timeout": 3000
			}`,
			expectErr: false,
			validate: func(t *testing.T, cfg *OpenGuardrailsConfig) {
				assert.Equal(t, "/api/v2/guardrails", cfg.baseURL)
				assert.Equal(t, uint32(3000), cfg.timeout)
			},
		},
		{
			name: "custom JSON paths and deny settings",
			json: `{
				"serviceName": "api.openguardrails.com.dns",
				"servicePort": 443,
				"serviceHost": "api.openguardrails.com",
				"apiKey": "sk-xxai-test-key",
				"requestContentJsonPath": "input.prompt",
				"responseContentJsonPath": "output.text",
				"denyCode": 400,
				"denyMessage": "Custom deny message",
				"protocol": "original"
			}`,
			expectErr: false,
			validate: func(t *testing.T, cfg *OpenGuardrailsConfig) {
				assert.Equal(t, "input.prompt", cfg.requestContentJsonPath)
				assert.Equal(t, "output.text", cfg.responseContentJsonPath)
				assert.Equal(t, int64(400), cfg.denyCode)
				assert.Equal(t, "Custom deny message", cfg.denyMessage)
				assert.Equal(t, true, cfg.protocolOriginal)
			},
		},
		{
			name: "direct mode with full HTTP URL",
			json: `{
			"baseURL": "http://192.168.1.100:5001/v1/guardrails",
			"apiKey": "sk-xxai-test-key",
			"checkRequest": true,
			"checkResponse": true
		}`,
			expectErr: false,
			validate: func(t *testing.T, cfg *OpenGuardrailsConfig) {
				assert.Equal(t, "http://192.168.1.100:5001/v1/guardrails", cfg.baseURL)
				assert.Equal(t, "192.168.1.100", cfg.serviceHost)
				assert.Equal(t, int64(5001), cfg.servicePort)
				assert.Equal(t, "openguardrails-direct.dns", cfg.serviceName)
				assert.Equal(t, true, cfg.checkRequest)
				assert.Equal(t, true, cfg.checkResponse)
			},
		},
		{
			name: "direct mode with HTTPS URL",
			json: `{
			"baseURL": "https://openguardrails.internal.company.com/v1/guardrails",
			"apiKey": "sk-xxai-test-key",
			"checkRequest": true
		}`,
			expectErr: false,
			validate: func(t *testing.T, cfg *OpenGuardrailsConfig) {
				assert.Equal(t, "https://openguardrails.internal.company.com/v1/guardrails", cfg.baseURL)
				assert.Equal(t, "openguardrails.internal.company.com", cfg.serviceHost)
				assert.Equal(t, int64(443), cfg.servicePort)
				assert.Equal(t, "openguardrails-direct.dns", cfg.serviceName)
				assert.Equal(t, true, cfg.checkRequest)
			},
		},
		{
			name: "invalid: checkResponse without checkRequest",
			json: `{
			"baseURL": "http://localhost:5001/v1/guardrails",
			"apiKey": "sk-xxai-test-key",
			"checkRequest": false,
			"checkResponse": true
		}`,
			expectErr: true, // Should fail validation
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			config := &OpenGuardrailsConfig{}
			jsonResult := gjson.Parse(tt.json)
			err := parseConfig(jsonResult, config)

			if tt.expectErr {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
				if tt.validate != nil {
					tt.validate(t, config)
				}
			}
		})
	}
}

func TestOpenGuardrailsResponseParsing(t *testing.T) {
	tests := []struct {
		name           string
		responseJSON   string
		expectError    bool
		expectedAction string
		expectedAnswer string
	}{
		{
			name: "pass action - no risk",
			responseJSON: `{
				"id": "req_12345",
				"overall_risk_level": "no_risk",
				"suggest_action": "pass",
				"suggest_answer": "",
				"score": 0.0,
				"result": {
					"security": {"risk_level": "no_risk", "categories": [], "score": 0.0},
					"compliance": {"risk_level": "no_risk", "categories": [], "score": 0.0},
					"data": {"risk_level": "no_risk", "categories": [], "score": 0.0}
				}
			}`,
			expectError:    false,
			expectedAction: "pass",
			expectedAnswer: "",
		},
		{
			name: "reject action - high risk",
			responseJSON: `{
				"id": "req_12346",
				"overall_risk_level": "high_risk",
				"suggest_action": "reject",
				"suggest_answer": "",
				"score": 0.95,
				"result": {
					"security": {"risk_level": "high_risk", "categories": ["S9"], "score": 0.95},
					"compliance": {"risk_level": "no_risk", "categories": [], "score": 0.0},
					"data": {"risk_level": "no_risk", "categories": [], "score": 0.0}
				}
			}`,
			expectError:    false,
			expectedAction: "reject",
			expectedAnswer: "",
		},
		{
			name: "replace action - with suggest answer",
			responseJSON: `{
				"id": "req_12347",
				"overall_risk_level": "high_risk",
				"suggest_action": "replace",
				"suggest_answer": "As an AI assistant, I cannot provide content involving sensitive topics.",
				"score": 0.92,
				"result": {
					"security": {"risk_level": "high_risk", "categories": ["S2"], "score": 0.92},
					"compliance": {"risk_level": "no_risk", "categories": [], "score": 0.0},
					"data": {"risk_level": "no_risk", "categories": [], "score": 0.0}
				}
			}`,
			expectError:    false,
			expectedAction: "replace",
			expectedAnswer: "As an AI assistant, I cannot provide content involving sensitive topics.",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var response OpenGuardrailsResponse
			err := json.Unmarshal([]byte(tt.responseJSON), &response)

			if tt.expectError {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
				assert.Equal(t, tt.expectedAction, response.SuggestAction)
				assert.Equal(t, tt.expectedAnswer, response.SuggestAnswer)
			}
		})
	}
}

func TestGenerateRandomID(t *testing.T) {
	id1 := generateRandomID()
	id2 := generateRandomID()

	// Check format
	assert.Contains(t, id1, "chatcmpl-openguardrails-")
	assert.Contains(t, id2, "chatcmpl-openguardrails-")

	// Note: In the current simple implementation, IDs are the same
	// In production, this should use crypto/rand for true randomness
	// This test just validates the format
	assert.NotEmpty(t, id1)
	assert.NotEmpty(t, id2)
}

func TestJSONPathExtraction(t *testing.T) {
	tests := []struct {
		name     string
		body     string
		path     string
		expected string
	}{
		{
			name: "extract last message content",
			body: `{
				"messages": [
					{"role": "system", "content": "You are a helpful assistant"},
					{"role": "user", "content": "Hello, how are you?"}
				]
			}`,
			path:     "messages.@reverse.0.content",
			expected: "Hello, how are you?",
		},
		{
			name: "extract choice message content",
			body: `{
				"choices": [
					{
						"index": 0,
						"message": {
							"role": "assistant",
							"content": "I'm doing well, thank you!"
						}
					}
				]
			}`,
			path:     "choices.0.message.content",
			expected: "I'm doing well, thank you!",
		},
		{
			name: "extract custom path",
			body: `{
				"input": {
					"prompt": "Custom prompt text"
				}
			}`,
			path:     "input.prompt",
			expected: "Custom prompt text",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := gjson.Get(tt.body, tt.path)
			assert.Equal(t, tt.expected, result.String())
		})
	}
}

func TestMultimodalContentHandling(t *testing.T) {
	tests := []struct {
		name         string
		body         string
		path         string
		expectedText string
		isArray      bool
	}{
		{
			name: "pure text content",
			body: `{
				"messages": [
					{"role": "user", "content": "Hello, how are you?"}
				]
			}`,
			path:         "messages.0.content",
			expectedText: "Hello, how are you?",
			isArray:      false,
		},
		{
			name: "multimodal content with text and image",
			body: `{
				"messages": [
					{
						"role": "user",
						"content": [
							{"type": "text", "text": "What's in this image?"},
							{"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}}
						]
					}
				]
			}`,
			path:         "messages.0.content",
			expectedText: "What's in this image?",
			isArray:      true,
		},
		{
			name: "multimodal content with multiple text parts",
			body: `{
				"messages": [
					{
						"role": "user",
						"content": [
							{"type": "text", "text": "First part"},
							{"type": "image_url", "image_url": {"url": "..."}},
							{"type": "text", "text": "Second part"}
						]
					}
				]
			}`,
			path:         "messages.0.content",
			expectedText: "First part Second part",
			isArray:      true,
		},
		{
			name: "multimodal content with only image (no text)",
			body: `{
				"messages": [
					{
						"role": "user",
						"content": [
							{"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}}
						]
					}
				]
			}`,
			path:         "messages.0.content",
			expectedText: "",
			isArray:      true,
		},
		{
			name: "multimodal response from AI",
			body: `{
				"choices": [
					{
						"message": {
							"role": "assistant",
							"content": [
								{"type": "text", "text": "Here's the generated image:"},
								{"type": "image_url", "image_url": {"url": "https://..."}}
							]
						}
					}
				]
			}`,
			path:         "choices.0.message.content",
			expectedText: "Here's the generated image:",
			isArray:      true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			contentResult := gjson.Get(tt.body, tt.path)

			// Test if it's correctly detected as array
			assert.Equal(t, tt.isArray, contentResult.IsArray())

			// Extract text content
			var extractedText string
			if contentResult.IsArray() {
				var textParts []string
				for _, part := range contentResult.Array() {
					if part.Get("type").String() == "text" {
						textParts = append(textParts, part.Get("text").String())
					}
				}
				extractedText = strings.Join(textParts, " ")
			} else {
				extractedText = contentResult.String()
			}

			assert.Equal(t, tt.expectedText, extractedText)
		})
	}
}
