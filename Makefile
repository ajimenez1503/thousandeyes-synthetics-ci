GO ?= go
GOFILES := $(shell find cmd internal -name '*.go')

.PHONY: deps fmt fmt-check validate test build ci

deps:
	$(GO) mod download

fmt:
	gofmt -w $(GOFILES)

fmt-check:
	@test -z "$$(gofmt -l $(GOFILES))" || (gofmt -l $(GOFILES); exit 1)

validate: fmt-check
	$(GO) vet ./...

test:
	$(GO) test ./...

build:
	mkdir -p build/bin
	CGO_ENABLED=0 $(GO) build -o build/bin/te-synthetics ./cmd/te-synthetics

ci: validate test build
