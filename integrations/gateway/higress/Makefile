REGISTRY ?= docker.io/openguardrails
IMAGE_TAG ?= $(shell tr -d '[:space:]' < VERSION)

.PHONY: build test clean push

build:
	GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o plugin.wasm .

# The scanner, the event derivation and the redaction round trip are ordinary Go
# and MUST stay testable without a gateway. `go test` builds the package for the
# host, which is why nothing here may depend on being inside a Wasm VM.
test:
	go test ./...

# Releases go through CI (.github/workflows/publish-higress.yml, tag
# `higress-v<VERSION>`) so the artifact a gateway pulls is traceable to a commit.
# This target is the manual escape hatch — it needs `oras login` first.
push: build
	tar czf plugin.tar.gz plugin.wasm
	oras push $(REGISTRY)/higress:$(IMAGE_TAG),latest \
		plugin.tar.gz:application/vnd.oci.image.layer.v1.tar+gzip
	rm -f plugin.tar.gz

clean:
	rm -f plugin.wasm plugin.tar.gz
