// Copyright 2026 Cisco Systems, Inc. and its affiliates
// SPDX-License-Identifier: Apache-2.0

package synthetics

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const maxAPIResponseBytes = 4 << 20

type apiClient struct {
	base         *url.URL
	token        string
	aid          string
	apiCLIPath   string
	pollInterval time.Duration
}

type statusError struct{ code int }

func (e *statusError) Error() string { return fmt.Sprintf("ThousandEyes API returned HTTP %d", e.code) }

func newAPIClient(options Options, pollInterval time.Duration) (*apiClient, error) {
	baseURL := strings.TrimRight(options.BaseURL, "/")
	if !strings.HasSuffix(baseURL, "/v7") {
		baseURL += "/v7"
	}
	base, err := url.Parse(baseURL)
	if err != nil || base.Host == "" || (base.Scheme != "https" && base.Scheme != "http") || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, fmt.Errorf("invalid ThousandEyes API base URL")
	}
	if base.Scheme == "http" {
		host := base.Hostname()
		ip := net.ParseIP(host)
		if !strings.EqualFold(host, "localhost") && (ip == nil || !ip.IsLoopback()) {
			return nil, fmt.Errorf("ThousandEyes API base URL must use HTTPS except for localhost or a literal loopback IP")
		}
	}
	if strings.TrimSpace(options.Token) == "" {
		return nil, fmt.Errorf("a ThousandEyes API token is required")
	}
	return &apiClient{base: base, token: options.Token, aid: options.AccountGroupID, apiCLIPath: options.APICLIPath, pollInterval: pollInterval}, nil
}

func (c *apiClient) endpoint(path string) string {
	u := *c.base
	u.Path = strings.TrimRight(c.base.Path, "/") + path
	return u.String()
}

func (c *apiClient) resultURL(link, expectedPath string) (string, error) {
	u, err := url.Parse(link)
	if err != nil {
		return "", fmt.Errorf("invalid result link")
	}
	reference := *c.base
	reference.Path = expectedPath
	u = reference.ResolveReference(u)
	if u.Scheme != c.base.Scheme || !strings.EqualFold(u.Host, c.base.Host) || u.User != nil || u.Fragment != "" || u.Path != expectedPath || u.RawPath != "" {
		return "", fmt.Errorf("unsafe result link; result links must use the configured API origin and test endpoint")
	}
	query := u.Query()
	if c.aid != "" {
		query.Set("aid", c.aid)
	}
	u.RawQuery = query.Encode()
	return u.String(), nil
}

func (c *apiClient) do(ctx context.Context, method, endpoint string, payload []byte, output any) error {
	args, err := c.commandArgs(method, endpoint)
	if err != nil {
		return err
	}
	for attempt := 0; ; attempt++ {
		response, err := c.invoke(ctx, args, payload)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if method == http.MethodGet && attempt < 2 {
				if err := waitContext(ctx, c.retryDelay(nil, attempt)); err != nil {
					return err
				}
				continue
			}
			return err
		}
		if response.StatusCode == http.StatusTooManyRequests || (method == http.MethodGet && response.StatusCode >= 500 && response.StatusCode <= 599 && attempt < 2) {
			if err := waitContext(ctx, c.retryDelay(response.Headers, attempt)); err != nil {
				return err
			}
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return &statusError{code: response.StatusCode}
		}
		if err := json.Unmarshal(response.Body, output); err != nil {
			return fmt.Errorf("invalid JSON in ThousandEyes API response")
		}
		return ctx.Err()
	}
}

func (c *apiClient) commandArgs(method, endpoint string) ([]string, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != c.base.Scheme || !strings.EqualFold(u.Host, c.base.Host) || u.User != nil || u.Fragment != "" || u.RawPath != "" {
		return nil, fmt.Errorf("invalid API endpoint")
	}
	prefix := strings.TrimRight(c.base.Path, "/") + "/"
	if !strings.HasPrefix(u.Path, prefix) {
		return nil, fmt.Errorf("invalid API endpoint")
	}
	parts := strings.Split(strings.TrimPrefix(u.Path, prefix), "/")
	var args []string
	switch {
	case method == http.MethodPost && len(parts) == 3 && parts[0] == "tests" && parts[2] == "instant" && (parts[1] == "http-server" || parts[1] == "agent-to-server"):
		args = []string{"tests", parts[1], "instant", "--body-file", "-", "--expand", "agent"}
	case method == http.MethodGet && len(parts) == 3 && parts[0] == "test-results" && numericID.MatchString(parts[1]) && (parts[2] == "http-server" || parts[2] == "network"):
		args = []string{"test-results", parts[2], "get", "--test-id", parts[1]}
	default:
		return nil, fmt.Errorf("unsupported API endpoint")
	}
	args = append(args, "--http-response", "--no-redirects", "--max-response-bytes", strconv.Itoa(maxAPIResponseBytes), "--aid", c.aid)
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return nil, fmt.Errorf("invalid result query")
	}
	delete(query, "aid")
	for _, field := range []struct{ key, flag string }{{"cursor", "cursor"}, {"direction", "direction"}, {"endDate", "end-date"}, {"expand", "expand"}, {"startDate", "start-date"}, {"window", "window"}} {
		values, ok := query[field.key]
		if !ok {
			continue
		}
		if method != http.MethodGet || len(values) != 1 {
			return nil, fmt.Errorf("invalid result query")
		}
		args = append(args, "--"+field.flag, values[0])
		delete(query, field.key)
	}
	if len(query) != 0 {
		return nil, fmt.Errorf("unsupported result query parameter")
	}
	return args, nil
}

type cliResponse struct {
	StatusCode int             `json:"statusCode"`
	Headers    http.Header     `json:"headers"`
	Body       json.RawMessage `json:"body"`
}

func (c *apiClient) invoke(ctx context.Context, args []string, payload []byte) (cliResponse, error) {
	binary, err := resolveAPICLIPath(c.apiCLIPath)
	if err != nil {
		return cliResponse{}, err
	}
	requestCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	command := exec.CommandContext(requestCtx, binary, args...)
	command.WaitDelay = time.Second
	command.Stdin = bytes.NewReader(payload)
	command.Env = backendEnvironment(c.token, c.base.String())
	stdout := boundedCapture{limit: maxAPIResponseBytes + (64 << 10)}
	stderr := boundedCapture{limit: 64 << 10}
	command.Stdout, command.Stderr = &stdout, &stderr
	runErr := command.Run()
	if requestCtx.Err() != nil {
		if ctx.Err() != nil {
			return cliResponse{}, ctx.Err()
		}
		return cliResponse{}, fmt.Errorf("ThousandEyes API CLI request timed out")
	}
	if stdout.exceeded || stderr.exceeded {
		return cliResponse{}, fmt.Errorf("ThousandEyes API CLI response exceeded size limit")
	}
	var response cliResponse
	if err := json.Unmarshal(stdout.data.Bytes(), &response); err != nil || response.StatusCode < 200 || response.StatusCode > 599 || len(response.Body) == 0 || len(response.Body) > maxAPIResponseBytes {
		return cliResponse{}, fmt.Errorf("ThousandEyes API CLI did not return a valid HTTP response; verify the configured backend version")
	}
	if runErr != nil && response.StatusCode >= 200 && response.StatusCode < 300 {
		return cliResponse{}, fmt.Errorf("ThousandEyes API CLI failed while returning a successful response")
	}
	headers := make(http.Header, len(response.Headers))
	for key, values := range response.Headers {
		for _, value := range values {
			headers.Add(key, value)
		}
	}
	response.Headers = headers
	return response, nil
}

func resolveAPICLIPath(override string) (string, error) {
	if override == "" {
		override = os.Getenv("TE_API_CLI_PATH")
	}
	if override != "" {
		if path, err := exec.LookPath(override); err == nil {
			return path, nil
		}
		return "", fmt.Errorf("cannot locate the configured ThousandEyes API CLI")
	}
	name := "thousandeyes"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if executable, err := os.Executable(); err == nil {
		if path, err := exec.LookPath(filepath.Join(filepath.Dir(executable), name)); err == nil {
			return path, nil
		}
	}
	if path, err := exec.LookPath(name); err == nil {
		return path, nil
	}
	return "", fmt.Errorf("cannot locate the ThousandEyes API CLI; set --api-cli-path or TE_API_CLI_PATH")
}

func backendEnvironment(token, baseURL string) []string {
	environment := make([]string, 0, len(os.Environ())+2)
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.EqualFold(key, "TE_TOKEN") && !strings.EqualFold(key, "TE_BASE_URL") {
			environment = append(environment, entry)
		}
	}
	return append(environment, "TE_TOKEN="+token, "TE_BASE_URL="+baseURL)
}

type boundedCapture struct {
	data     bytes.Buffer
	limit    int
	exceeded bool
}

func (capture *boundedCapture) Write(data []byte) (int, error) {
	remaining := capture.limit - capture.data.Len()
	if len(data) > remaining {
		capture.exceeded = true
		capture.data.Write(data[:max(remaining, 0)])
	} else {
		capture.data.Write(data)
	}
	return len(data), nil
}

func (c *apiClient) retryDelay(headers http.Header, attempt int) time.Duration {
	delay := c.pollInterval
	if delay > time.Second {
		delay = time.Second
	}
	if delay < time.Millisecond {
		delay = time.Millisecond
	}
	if attempt > 6 {
		attempt = 6
	}
	delay *= 1 << attempt
	if retryAfter := headers.Get("Retry-After"); retryAfter != "" {
		if seconds, err := strconv.Atoi(retryAfter); err == nil && seconds >= 0 && seconds <= 86400 {
			if candidate := time.Duration(seconds) * time.Second; candidate > delay {
				delay = candidate
			}
		} else if deadline, err := http.ParseTime(retryAfter); err == nil {
			if candidate := time.Until(deadline); candidate > delay {
				delay = candidate
			}
		}
	}
	for _, field := range []string{"X-Organization-Rate-Limit-Reset", "X-Instant-Test-Rate-Limit-Reset"} {
		if reset, err := strconv.ParseInt(headers.Get(field), 10, 64); err == nil {
			if candidate := time.Until(time.Unix(reset, 0)); candidate > delay {
				delay = candidate
			}
		}
	}
	return delay
}

func waitContext(ctx context.Context, delay time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func pendingResultError(err error) bool {
	var status *statusError
	return errors.As(err, &status) && status.code == http.StatusNotFound
}
