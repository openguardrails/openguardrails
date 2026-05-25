package main

import (
	"github.com/tidwall/gjson"
)

const maxPlaceholderLen = 50

// StreamRestorer handles placeholder restoration in SSE streaming responses.
// It buffers only when a potential placeholder (__xxx__) is detected,
// and flushes immediately if no closing __ is found within 50 characters.
type StreamRestorer struct {
	mapping      map[string]string
	contentBuf   string // accumulated text for delta.content
	reasoningBuf string // accumulated text for delta.reasoning_content
	lineBuf      string // incomplete SSE line carried across raw chunks
}

func NewStreamRestorer(mapping map[string]string) *StreamRestorer {
	return &StreamRestorer{mapping: mapping}
}

// ProcessChunk handles a raw byte chunk from Envoy.
// It splits by newlines, buffers incomplete trailing lines,
// and processes each complete SSE event for placeholder restoration.
func (r *StreamRestorer) ProcessChunk(chunk []byte, isLast bool) []byte {
	text := r.lineBuf + string(chunk)
	r.lineBuf = ""

	result := make([]byte, 0, len(chunk)+64)

	// Process line by line
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			line := text[start:i]
			start = i + 1
			processed := r.processLine(line, isLast)
			result = append(result, processed...)
			result = append(result, '\n')
		}
	}

	// Handle trailing content (no final newline)
	if start < len(text) {
		tail := text[start:]
		if isLast {
			// Last chunk: process and flush everything
			processed := r.processLine(tail, true)
			result = append(result, processed...)
		} else {
			// Buffer incomplete line for next chunk
			r.lineBuf = tail
		}
	}

	// On last chunk, flush any remaining buffered text
	if isLast {
		r.contentBuf = ""
		r.reasoningBuf = ""
	}

	return result
}

// processLine handles a single line from the SSE stream.
func (r *StreamRestorer) processLine(line string, isLast bool) string {
	// Only process "data: {json}" lines
	if len(line) < 6 || line[:6] != "data: " {
		return line
	}
	data := line[6:]
	if data == "[DONE]" {
		return line
	}

	parsed := gjson.Parse(data)
	if !parsed.IsObject() {
		return line
	}

	modified := data

	// Process delta.content
	dc := parsed.Get("choices.0.delta.content")
	if dc.Exists() && dc.Type == gjson.String {
		original := dc.String()
		restored := r.processField(&r.contentBuf, original, isLast)
		if restored != original {
			if newData, err := sjsonSet(modified, "choices.0.delta.content", restored); err == nil {
				modified = newData
			}
		}
	}

	// Process delta.reasoning_content
	rc := parsed.Get("choices.0.delta.reasoning_content")
	if rc.Exists() && rc.Type == gjson.String {
		original := rc.String()
		restored := r.processField(&r.reasoningBuf, original, isLast)
		if restored != original {
			if newData, err := sjsonSet(modified, "choices.0.delta.reasoning_content", restored); err == nil {
				modified = newData
			}
			// Also update "reasoning" field if present (some models duplicate it)
			if parsed.Get("choices.0.delta.reasoning").Exists() {
				if newData, err := sjsonSet(modified, "choices.0.delta.reasoning", restored); err == nil {
					modified = newData
				}
			}
		}
	}

	return "data: " + modified
}

// processField accumulates text for a field (content or reasoning_content),
// performs placeholder restoration, and returns text safe to emit.
// Only buffers when inside a potential __placeholder__ pattern.
func (r *StreamRestorer) processField(buf *string, text string, isLast bool) string {
	*buf += text

	if isLast {
		// Flush everything
		result := replaceAllPlaceholders(*buf, r.mapping)
		*buf = ""
		return result
	}

	// Extract safe output and pending buffer
	output, pending := extractSafe(*buf, r.mapping)
	*buf = pending
	return output
}

// extractSafe scans text, replaces complete placeholders, and splits into
// safe-to-emit output and pending text that might be an incomplete placeholder.
func extractSafe(text string, mapping map[string]string) (output string, pending string) {
	n := len(text)
	if n == 0 {
		return "", ""
	}

	result := make([]byte, 0, n)
	i := 0

	for i < n {
		if text[i] == '_' && i+1 < n && text[i+1] == '_' {
			// Potential placeholder start
			// Try to find closing "__"
			found := false
			for j := i + 2; j < n && j < i+maxPlaceholderLen; j++ {
				if text[j] == '_' && j+1 < n && text[j+1] == '_' {
					// Potential closing "__"
					candidate := text[i : j+2]
					if replacement, exists := mapping[candidate]; exists {
						// Match! Replace placeholder
						result = append(result, replacement...)
						i = j + 2
						found = true
						break
					}
					// Not in mapping, but check if j+2 is non-ident (real end of unknown placeholder)
					if j+2 >= n || !isIdentChar(text[j+2]) {
						// Unknown placeholder, output as-is
						result = append(result, candidate...)
						i = j + 2
						found = true
						break
					}
					// Inner underscore (like PHONE_NUM), continue scanning
				} else if !isIdentChar(text[j]) {
					// Non-identifier char breaks the placeholder pattern
					// Output everything from i to j as-is
					result = append(result, text[i:j]...)
					i = j
					found = true
					break
				}
			}
			if !found {
				// Reached end of text or maxPlaceholderLen without closing
				remaining := text[i:]
				if len(remaining) >= maxPlaceholderLen {
					// Too long to be a placeholder, flush it
					result = append(result, remaining...)
					return string(result), ""
				}
				// Could still be an incomplete placeholder, buffer it
				return string(result), remaining
			}
		} else if text[i] == '_' && i == n-1 {
			// Single "_" at end, might be start of "__"
			return string(result), "_"
		} else {
			result = append(result, text[i])
			i++
		}
	}

	return string(result), ""
}

// replaceAllPlaceholders replaces all complete placeholders in text.
func replaceAllPlaceholders(text string, mapping map[string]string) string {
	if len(text) == 0 || len(mapping) == 0 {
		return text
	}
	result := make([]byte, 0, len(text))
	i := 0
	n := len(text)
	for i < n {
		if i+1 < n && text[i] == '_' && text[i+1] == '_' {
			matched := false
			for placeholder, original := range mapping {
				pLen := len(placeholder)
				if i+pLen <= n && text[i:i+pLen] == placeholder {
					result = append(result, original...)
					i += pLen
					matched = true
					break
				}
			}
			if !matched {
				result = append(result, text[i])
				i++
			}
		} else {
			result = append(result, text[i])
			i++
		}
	}
	return string(result)
}

// isIdentChar returns true if the character is valid in a placeholder identifier.
func isIdentChar(ch byte) bool {
	return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_'
}
