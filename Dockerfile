# Copyright 2026 Cisco Systems, Inc. and its affiliates
# SPDX-License-Identifier: Apache-2.0

FROM --platform=$BUILDPLATFORM golang:1.26.10 AS build
ENV GOTOOLCHAIN=local
ARG TARGETOS=linux
ARG TARGETARCH
ARG RUNNER_VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-X main.version=${RUNNER_VERSION}" -o /out/te-synthetics ./cmd/te-synthetics

# Prepare this pinned source with node scripts/prepare-backend.js first.
WORKDIR /backend
COPY build/backend-source ./
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -buildvcs=false -o /out/thousandeyes .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/te-synthetics /out/thousandeyes /usr/local/bin/
COPY LICENSE NOTICE backend.json /usr/share/te-synthetics/
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/te-synthetics"]
