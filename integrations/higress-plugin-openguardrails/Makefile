.PHONY: build test clean help

PLUGIN_NAME = openguardrails-guard
WASM_OUTPUT = $(PLUGIN_NAME).wasm

help:
	@echo "OpenGuardrails Higress Plugin - Build Commands"
	@echo ""
	@echo "Available targets:"
	@echo "  build        - Build the WASM plugin"
	@echo "  test         - Run tests"
	@echo "  clean        - Clean build artifacts"
	@echo "  fmt          - Format Go code"
	@echo "  lint         - Run linter (requires golangci-lint)"
	@echo "  help         - Show this help message"
	@echo ""
	@echo "Prerequisites:"
	@echo "  - TinyGo (for WASM compilation): https://tinygo.org/getting-started/install/"
	@echo "  - Go 1.24+ (for testing)"
	@echo ""

build:
	@echo "Building WASM plugin..."
	tinygo build -o $(WASM_OUTPUT) -scheduler=none -target=wasi main.go
	@echo "Build complete: $(WASM_OUTPUT)"

test:
	@echo "Running tests..."
	go test -v ./...

fmt:
	@echo "Formatting code..."
	go fmt ./...

lint:
	@echo "Running linter..."
	golangci-lint run

clean:
	@echo "Cleaning build artifacts..."
	rm -f $(WASM_OUTPUT)
	@echo "Clean complete"

# Development workflow
dev: fmt test build
	@echo "Development build complete!"
