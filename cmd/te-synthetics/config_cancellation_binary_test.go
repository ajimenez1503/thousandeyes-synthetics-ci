//go:build unix

// Copyright 2026 Cisco Systems, Inc. and its affiliates
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestConfigPipeSIGTERMStopsStandaloneBinary(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "te-synthetics")
	if output, err := exec.Command("go", "build", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatalf("build standalone runner: %v\n%s", err, output)
	}
	for _, heldOpen := range []bool{false, true} {
		name := "startup or blocked open"
		if heldOpen {
			name = "blocked read"
		}
		t.Run(name, func(t *testing.T) {
			fifo := filepath.Join(t.TempDir(), "suite.json")
			if output, err := exec.Command("mkfifo", fifo).CombinedOutput(); err != nil {
				t.Fatalf("create configuration pipe: %v: %s", err, output)
			}
			child := exec.Command(binary, "run-tests", "--config", fifo, "--timeout", "1s")
			for _, entry := range os.Environ() {
				key, _, _ := strings.Cut(entry, "=")
				if !strings.EqualFold(key, "TE_TOKEN") && !strings.EqualFold(key, "TE_BASE_URL") {
					child.Env = append(child.Env, entry)
				}
			}
			child.Env = append(child.Env, "TE_TOKEN=config-cancellation-fake-token", "TE_BASE_URL=https://api.example.invalid")
			var stdout, stderr bytes.Buffer
			child.Stdout, child.Stderr = &stdout, &stderr
			if err := child.Start(); err != nil {
				t.Fatal(err)
			}
			finished := make(chan error, 1)
			go func() { finished <- child.Wait() }()
			waited := false
			defer func() {
				if !waited {
					_ = child.Process.Kill()
					<-finished
				}
			}()
			if heldOpen {
				deadline := time.Now().Add(5 * time.Second)
				var writer *os.File
				for {
					var err error
					writer, err = os.OpenFile(fifo, os.O_WRONLY|syscall.O_NONBLOCK, 0600)
					if err == nil {
						break
					}
					if !errors.Is(err, syscall.ENXIO) || time.Now().After(deadline) {
						t.Fatalf("runner never opened configuration pipe: %v", err)
					}
					time.Sleep(time.Millisecond)
				}
				defer writer.Close()
				const suite = `{"version":1,"accountGroupId":"123","tests":[{"name":"skip","type":"http-server","executionRule":"skipped","config":{"url":"https://target.invalid","agents":[{"agentId":"6"}]}}]}`
				if _, err := writer.WriteString(suite); err != nil {
					t.Fatal(err)
				}
			} else {
				select {
				case err := <-finished:
					waited = true
					t.Fatalf("runner exited before SIGTERM: error=%v stdout=%q stderr=%q", err, stdout.String(), stderr.String())
				case <-time.After(500 * time.Millisecond):
				}
			}
			if err := child.Process.Signal(syscall.SIGTERM); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-finished:
				waited = true
				exit, ok := err.(*exec.ExitError)
				if !ok || stdout.Len() != 0 {
					t.Fatalf("pipe cancellation did not propagate: error=%v stdout=%q stderr=%q", err, stdout.String(), stderr.String())
				}
				handled := exit.ExitCode() == 1 && strings.Contains(stderr.String(), "context canceled")
				// Before main installs its handler, SIGTERM itself is the correct
				// termination. The context-level FIFO test separately proves blocked
				// opening cancels. A held-open producer handshakes with the reader,
				// so that case must always report handled cancellation.
				status, isWaitStatus := exit.Sys().(syscall.WaitStatus)
				startupSignal := !heldOpen && isWaitStatus && status.Signaled() && status.Signal() == syscall.SIGTERM && stderr.Len() == 0
				if !handled && !startupSignal {
					t.Fatalf("unexpected interruption: error=%v stdout=%q stderr=%q", err, stdout.String(), stderr.String())
				}
				t.Logf("interruption outcome: handled cancellation=%t, startup SIGTERM=%t", handled, startupSignal)
			case <-time.After(3 * time.Second):
				t.Fatal("standalone runner ignored SIGTERM while loading its configuration")
			}
		})
	}
}
