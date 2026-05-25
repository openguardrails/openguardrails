REGISTRY ?= docker.io/openguardrails
IMAGE_TAG ?= latest

.PHONY: build clean push

build:
	GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o plugin.wasm .

push: build
	tar czf plugin.tar.gz plugin.wasm
	oras push $(REGISTRY)/og-connector-higress-go:$(IMAGE_TAG) \
		plugin.tar.gz:application/vnd.oci.image.layer.v1.tar+gzip
	oras push $(REGISTRY)/og-connector-higress-go:latest \
		plugin.tar.gz:application/vnd.oci.image.layer.v1.tar+gzip
	rm -f plugin.tar.gz

clean:
	rm -f plugin.wasm plugin.tar.gz
