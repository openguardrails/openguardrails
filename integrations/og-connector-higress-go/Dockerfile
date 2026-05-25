# Multi-stage build for og-connector Go WASM plugin
# Stage 1: Build the WASM plugin
FROM golang:1.24 AS builder

WORKDIR /app

# Copy module files first for dependency caching
COPY go.mod go.sum ./

# Copy the Higress SDK (needed for the replace directive)
COPY ../../thirdparty-gateways/higress/plugins/wasm-go /higress-sdk

# Update replace directive for Docker build context
RUN sed -i 's|../../thirdparty-gateways/higress/plugins/wasm-go|/higress-sdk|' go.mod

RUN go mod download

# Copy source files
COPY *.go ./

# Build WASM binary using standard Go compiler (same as Higress official build)
RUN GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o plugin.wasm .

# Stage 2: Minimal image with just the WASM file
FROM scratch

COPY --from=builder /app/plugin.wasm /plugin.wasm
