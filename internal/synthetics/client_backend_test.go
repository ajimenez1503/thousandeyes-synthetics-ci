// Copyright 2026 Cisco Systems, Inc. and its affiliates
// SPDX-License-Identifier: Apache-2.0

package synthetics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if mode := os.Getenv("TE_SYNTHETICS_HELPER_MODE"); mode != "" {
		runBackendHelper(mode)
		return
	}
	os.Exit(m.Run())
}

func runBackendHelper(mode string) {
	_, _ = io.Copy(io.Discard, os.Stdin)
	switch mode {
	case "measurements", "success-before-cancel":
		if len(os.Args) > 1 && os.Args[1] == "tests" {
			fmt.Fprint(os.Stdout, `{"statusCode":201,"headers":{},"body":{"testId":"101","agents":[{"agentId":"6","agentType":"cloud"}]}}`)
		} else {
			measurements := os.Getenv("TE_SYNTHETICS_HELPER_MEASUREMENTS")
			if mode == "success-before-cancel" {
				measurements = `"responseCode":200`
			}
			fmt.Fprint(os.Stdout, `{"statusCode":200,"headers":{},"body":{"results":[{"agent":{"agentId":"6"},"roundId":1700000000,`+measurements+`}]}}`)
			if mode == "success-before-cancel" {
				time.Sleep(10 * time.Second)
			}
		}
	case "hang":
		fmt.Fprint(os.Stderr, "private-backend-detail fake-backend-token")
		time.Sleep(10 * time.Second)
	case "malformed":
		fmt.Fprint(os.Stdout, "private-backend-detail fake-backend-token")
		fmt.Fprint(os.Stderr, "private-backend-detail fake-backend-token")
		os.Exit(1)
	case "oversized":
		fmt.Fprint(os.Stdout, strings.Repeat("x", maxAPIResponseBytes+(64<<10)+1))
	case "oversized-stderr":
		fmt.Fprint(os.Stderr, strings.Repeat("x", (64<<10)+1))
	case "http-error":
		fmt.Fprint(os.Stdout, `{"statusCode":429,"headers":{"retry-after":["7"]},"body":{"detail":"private-backend-detail fake-backend-token"}}`)
		os.Exit(1)
	case "successful-exit-error":
		fmt.Fprint(os.Stdout, `{"statusCode":200,"headers":{},"body":{"results":[]}}`)
		os.Exit(1)
	default:
		os.Exit(2)
	}
}

func helperBackendClient(t *testing.T, mode string) *apiClient {
	t.Helper()
	t.Setenv("TE_SYNTHETICS_HELPER_MODE", mode)
	t.Setenv("GORACE", "atexit_sleep_ms=0")
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	client, err := newAPIClient(Options{BaseURL: "https://api.example.invalid", Token: "fake-backend-token", AccountGroupID: "123", APICLIPath: binary}, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestBackendCancellationStopsChildAndRetainsContext(t *testing.T) {
	client := helperBackendClient(t, "hang")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := client.invoke(ctx, nil, nil)
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > 2*time.Second {
		t.Fatalf("child cancellation lost or delayed: elapsed=%s error=%v", time.Since(started), err)
	}
}

func TestBackendRejectsMalformedOrExcessiveOutputWithoutLeakingIt(t *testing.T) {
	for _, mode := range []string{"malformed", "oversized", "oversized-stderr", "successful-exit-error"} {
		t.Run(mode, func(t *testing.T) {
			client := helperBackendClient(t, mode)
			_, err := client.invoke(context.Background(), nil, nil)
			if err == nil {
				t.Fatal("invalid subprocess response was accepted")
			}
			if strings.Contains(err.Error(), "private-backend-detail") || strings.Contains(err.Error(), "fake-backend-token") {
				t.Fatal("raw subprocess output leaked through the error")
			}
		})
	}
}

func TestBackendPreservesHTTPErrorStatusAndRetryHeaders(t *testing.T) {
	client := helperBackendClient(t, "http-error")
	response, err := client.invoke(context.Background(), nil, nil)
	if err != nil || response.StatusCode != http.StatusTooManyRequests || response.Headers.Get("Retry-After") != "7" {
		t.Fatalf("HTTP error envelope was lost: status=%d headers=%v error=%v", response.StatusCode, response.Headers, err)
	}
	if delay := client.retryDelay(response.Headers, 0); delay < 7*time.Second {
		t.Fatalf("Retry-After was ignored: %s", delay)
	}
}

func TestRunSanitizesBackendFailureAndPreservesVersionOneReport(t *testing.T) {
	client := helperBackendClient(t, "malformed")
	config := Config{Version: 1, AccountGroupID: "123", Tests: []TestConfig{{Name: "backend-error", Type: "http-server", Config: map[string]json.RawMessage{"url": json.RawMessage(`"https://target.invalid"`), "agents": json.RawMessage(`[{"agentId":"6"}]`)}}}}
	report, err := Run(context.Background(), config, Options{BaseURL: client.base.String(), Token: client.token, APICLIPath: client.apiCLIPath})
	if err == nil || !report.Failed() || len(report.Tests) != 1 || report.Tests[0].Status != "error" || report.Version != 1 {
		t.Fatalf("backend failure did not fail the report: report=%+v error=%v", report, err)
	}
	data, marshalErr := json.Marshal(report)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	if strings.Contains(string(data)+err.Error(), "private-backend-detail") || strings.Contains(string(data)+err.Error(), "fake-backend-token") {
		t.Fatal("raw backend details leaked into the report")
	}
}

func TestBackendUsesOnlySupportedCommandsAndProtectedTransportFlags(t *testing.T) {
	client, err := newAPIClient(Options{BaseURL: "https://api.example.invalid", Token: "fake", AccountGroupID: "123"}, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ method, endpoint, expected string }{
		{http.MethodPost, "/tests/http-server/instant", "tests http-server instant --body-file - --expand agent"},
		{http.MethodPost, "/tests/agent-to-server/instant", "tests agent-to-server instant --body-file - --expand agent"},
		{http.MethodGet, "/test-results/101/http-server?cursor=opaque%2B%2F%3Dnext", "test-results http-server get --test-id 101"},
		{http.MethodGet, "/test-results/102/network", "test-results network get --test-id 102"},
	} {
		args, err := client.commandArgs(item.method, client.endpoint(item.endpoint))
		// endpoint() treats its argument as a path, so add the query separately.
		if strings.Contains(item.endpoint, "?") {
			args, err = client.commandArgs(item.method, client.base.String()+item.endpoint)
		}
		joined := strings.Join(args, " ")
		if err != nil || !strings.HasPrefix(joined, item.expected) || !strings.Contains(joined, "--http-response --no-redirects --max-response-bytes 4194304 --aid 123") {
			t.Fatalf("incorrect backend arguments: %q error=%v", joined, err)
		}
		if strings.Contains(item.endpoint, "cursor") && !strings.Contains(joined, "--cursor opaque+/=next") {
			t.Fatalf("opaque cursor changed: %q", joined)
		}
	}
	for _, endpoint := range []string{"https://foreign.invalid/v7/test-results/1/network", client.base.String() + "/test-results/1/network?futureFilter=ignored", client.base.String() + "/test-results/1/network?cursor=a&cursor=b"} {
		if _, err := client.commandArgs(http.MethodGet, endpoint); err == nil {
			t.Fatal("unsafe or unrepresentable API request was accepted")
		}
	}
}

func TestBackendEnvironmentReplacesInheritedTokenAndOrigin(t *testing.T) {
	t.Setenv("TE_TOKEN", "inherited-token")
	t.Setenv("TE_BASE_URL", "https://inherited.invalid")
	var tokens, origins int
	for _, entry := range backendEnvironment("selected-token", "https://selected.invalid") {
		key, value, _ := strings.Cut(entry, "=")
		if strings.EqualFold(key, "TE_TOKEN") {
			tokens++
			if value != "selected-token" {
				t.Fatal("inherited token reached the child")
			}
		}
		if strings.EqualFold(key, "TE_BASE_URL") {
			origins++
			if value != "https://selected.invalid" {
				t.Fatal("inherited origin reached the child")
			}
		}
	}
	if tokens != 1 || origins != 1 {
		t.Fatalf("child environment has duplicated credentials or origins: tokens=%d origins=%d", tokens, origins)
	}
}

func TestRunDoesNotPassWhenChildWritesSuccessBeforeCancellation(t *testing.T) {
	client := helperBackendClient(t, "success-before-cancel")
	config := Config{Version: 1, AccountGroupID: "123", Tests: []TestConfig{{Name: "interrupted", Type: "http-server", Config: map[string]json.RawMessage{"url": json.RawMessage(`"https://target.invalid"`), "agents": json.RawMessage(`[{"agentId":"6"}]`)}}}}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	report, err := Run(ctx, config, Options{BaseURL: client.base.String(), Token: client.token, APICLIPath: client.apiCLIPath})
	if !errors.Is(err, context.DeadlineExceeded) || !report.Failed() || len(report.Tests) != 1 || report.Tests[0].TestID != "101" || report.Tests[0].Status != "timed-out" || report.Tests[0].Agents[0].Status != "timed-out" {
		t.Fatalf("success before cancellation incorrectly passed: report=%+v error=%v", report, err)
	}
}

func TestRunRejectsPlainHTTPOutsideLoopbackBeforeInvokingBackend(t *testing.T) {
	client := helperBackendClient(t, "malformed")
	config := Config{Version: 1, AccountGroupID: "123", Tests: []TestConfig{{Name: "unsafe-origin", Type: "http-server", Config: map[string]json.RawMessage{"url": json.RawMessage(`"https://target.invalid"`), "agents": json.RawMessage(`[{"agentId":"6"}]`)}}}}
	for _, origin := range []string{"http://api.thousandeyes.com", "http://192.0.2.1", "http://127.0.0.1.example.invalid", "http://localhost.example.invalid"} {
		report, err := Run(context.Background(), config, Options{BaseURL: origin, Token: client.token, APICLIPath: client.apiCLIPath})
		if err == nil || !strings.Contains(err.Error(), "HTTPS") || len(report.Tests) != 0 || report.RunID != "" {
			t.Fatalf("unsafe origin reached execution: origin=%s report=%+v error=%v", origin, report, err)
		}
	}
}

func TestBackendAllowsHTTPSAndControlledLoopbackHTTP(t *testing.T) {
	for _, origin := range []string{"https://api.thousandeyes.com", "https://api.custom.invalid", "http://localhost:8080", "http://LOCALHOST:8080", "http://127.0.0.1:8080", "http://127.0.1.2:8080", "http://[::1]:8080"} {
		if _, err := newAPIClient(Options{BaseURL: origin, Token: "fake", AccountGroupID: "123"}, time.Millisecond); err != nil {
			t.Fatalf("permitted API origin was rejected: %s: %v", origin, err)
		}
	}
}
