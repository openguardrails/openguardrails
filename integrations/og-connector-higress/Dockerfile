# Multi-stage build for og-connector WASM plugin
# Stage 1: Build the WASM plugin
FROM rust:1.75 AS builder

WORKDIR /app

# Install WASM target
RUN rustup target add wasm32-wasi

# Copy source files
COPY Cargo.toml ./
COPY src ./src

# Build release
RUN cargo build --target wasm32-wasi --release

# Stage 2: Create minimal image with just the WASM file
# Using scratch for OCI artifact compatibility with Higress
FROM scratch

# Copy the compiled WASM plugin
COPY --from=builder /app/target/wasm32-wasi/release/og_connector.wasm /plugin.wasm

# Higress expects the WASM file at /plugin.wasm
