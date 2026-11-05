// Copyright 2026 Cisco Systems, Inc. and its affiliates
// SPDX-License-Identifier: Apache-2.0

package synthetics

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestRunCancelsActualBackendAfterResultHandlerStarts(t *testing.T) {
	backend := os.Getenv("TE_TEST_API_CLI_PATH")
	if backend == "" {
		t.Skip("set TE_TEST_API_CLI_PATH to run official API CLI cancellation integration")
	}
	started, disconnected := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if request.Method == http.MethodPost {
			_, _ = w.Write([]byte(`{"testId":"101","agents":[{"agentId":"6","agentType":"cloud"}]}`))
			return
		}
		close(started)
		<-request.Context().Done()
		close(disconnected)
	}))
	defer server.Close()
	config := Config{Version: 1, AccountGroupID: "123", Timeout: "30s", Tests: []TestConfig{{Name: "interrupted", Type: "http-server", Config: map[string]json.RawMessage{"url": json.RawMessage(`"https://target.invalid"`), "agents": json.RawMessage(`[{"agentId":"6"}]`)}}}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	type outcome struct {
		report Report
		err    error
	}
	completed := make(chan outcome, 1)
	go func() {
		report, err := Run(ctx, config, Options{BaseURL: server.URL, Token: "backend-cancellation-fake-token", APICLIPath: backend})
		completed <- outcome{report, err}
	}()
	select {
	case <-started:
	case <-time.After(30 * time.Second):
		cancel()
		t.Fatal("actual backend did not reach the result handler")
	}
	cancel()
	select {
	case result := <-completed:
		if !errors.Is(result.err, context.Canceled) || !result.report.Failed() || len(result.report.Tests) != 1 || result.report.Tests[0].TestID != "101" || result.report.Tests[0].Status != "error" || result.report.Tests[0].Agents[0].Status != "error" || result.report.FinishedAt.IsZero() {
			t.Fatalf("actual backend cancellation lost its failed report: report=%+v error=%v", result.report, result.err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("actual backend was not stopped promptly after cancellation")
	}
	select {
	case <-disconnected:
	case <-time.After(3 * time.Second):
		t.Fatal("canceled backend left its API request connected")
	}
}
