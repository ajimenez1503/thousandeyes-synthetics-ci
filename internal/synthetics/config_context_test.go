// Copyright 2026 Cisco Systems, Inc. and its affiliates
// SPDX-License-Identifier: Apache-2.0

package synthetics

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

const contextConfigPayload = `{"version":1,"accountGroupId":"123","tests":[{"name":"home","type":"http-server","config":{"url":"https://target.invalid","agents":[{"agentId":"6"}]}}]}`

func TestLoadConfigContextDoesNotOpenWhenAlreadyCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := LoadConfigContext(ctx, filepath.Join(t.TempDir(), "does-not-exist.json"))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation before opening configuration, got %v", err)
	}
}

func TestLoadConfigContextAcceptsRegularConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "suite.json")
	if err := os.WriteFile(path, []byte(contextConfigPayload), 0600); err != nil {
		t.Fatal(err)
	}
	config, err := LoadConfigContext(context.Background(), path)
	if err != nil || len(config.Tests) != 1 || config.Tests[0].Name != "home" {
		t.Fatalf("configuration changed: config=%+v error=%v", config, err)
	}
}
