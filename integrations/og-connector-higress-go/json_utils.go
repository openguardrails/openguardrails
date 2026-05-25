package main

import (
	"github.com/tidwall/sjson"
)

// stringBuilder is a simple string builder for TinyGo compatibility.
type stringBuilder struct {
	data []byte
}

func (b *stringBuilder) WriteString(s string) {
	b.data = append(b.data, s...)
}

func (b *stringBuilder) String() string {
	return string(b.data)
}

// sjsonSet wraps sjson.Set for string values.
func sjsonSet(json, path, value string) (string, error) {
	return sjson.Set(json, path, value)
}

// sjsonSetRaw wraps sjson.SetRaw for raw JSON values.
func sjsonSetRaw(json, path, raw string) (string, error) {
	return sjson.SetRaw(json, path, raw)
}

// escapeJSON escapes a string for safe inclusion in JSON.
func escapeJSON(s string) string {
	result := make([]byte, 0, len(s)+10)
	for i := 0; i < len(s); i++ {
		ch := s[i]
		switch ch {
		case '"':
			result = append(result, '\\', '"')
		case '\\':
			result = append(result, '\\', '\\')
		case '\n':
			result = append(result, '\\', 'n')
		case '\r':
			result = append(result, '\\', 'r')
		case '\t':
			result = append(result, '\\', 't')
		case '\b':
			result = append(result, '\\', 'b')
		case '\f':
			result = append(result, '\\', 'f')
		default:
			if ch < 0x20 {
				// Control character
				result = append(result, '\\', 'u', '0', '0',
					hexChar(ch>>4), hexChar(ch&0x0f))
			} else {
				result = append(result, ch)
			}
		}
	}
	return string(result)
}

func hexChar(b byte) byte {
	if b < 10 {
		return '0' + b
	}
	return 'a' + b - 10
}
