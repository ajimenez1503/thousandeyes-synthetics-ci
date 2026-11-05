//go:build unix

// Copyright 2026 Cisco Systems, Inc. and its affiliates
// SPDX-License-Identifier: Apache-2.0

package synthetics

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func configFIFO(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "suite.json")
	if output, err := exec.Command("mkfifo", path).CombinedOutput(); err != nil {
		t.Fatalf("create configuration pipe: %v: %s", err, output)
	}
	return path
}

func configFIFOProducer(t *testing.T, path string) *os.File {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		writer, err := os.OpenFile(path, os.O_WRONLY|syscall.O_NONBLOCK, 0600)
		if err == nil {
			return writer
		}
		if !errors.Is(err, syscall.ENXIO) || time.Now().After(deadline) {
			t.Fatalf("open configuration producer: %v", err)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestLoadConfigContextCancelsBlockedRead(t *testing.T) {
	path := configFIFO(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan error, 1)
	go func() { _, err := LoadConfigContext(ctx, path); finished <- err }()
	// Opening the producer handshakes with the consumer, so cancellation occurs
	// after the file has opened rather than relying on process startup timing.
	writer := configFIFOProducer(t, path)
	defer writer.Close()
	if _, err := writer.WriteString(contextConfigPayload); err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected canceled configuration read, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("configuration read ignored cancellation while the producer remained open")
	}
}

func TestLoadConfigContextCancelsBlockedOpenAndClosesLateFile(t *testing.T) {
	path := configFIFO(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	finished := make(chan error, 1)
	go func() { _, err := LoadConfigContext(ctx, path); finished <- err }()
	defer func() {
		// Release any pending kernel open even when the regression fails.
		file, err := os.OpenFile(path, os.O_RDWR|syscall.O_NONBLOCK, 0600)
		if err == nil {
			defer file.Close()
			time.Sleep(10 * time.Millisecond)
		}
	}()
	select {
	case err := <-finished:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("expected deadline while opening configuration, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("configuration open ignored its context deadline")
	}
	writer, err := os.OpenFile(path, os.O_WRONLY|syscall.O_NONBLOCK, 0600)
	if errors.Is(err, syscall.ENXIO) {
		return // The read descriptor was already closed, or never opened.
	}
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	deadline := time.Now().Add(2 * time.Second)
	for {
		_, err := writer.Write([]byte(" "))
		if errors.Is(err, syscall.EPIPE) {
			return
		}
		if err != nil {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatal("file opened after cancellation remained open")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestLoadConfigContextAcceptsPipeAtEOF(t *testing.T) {
	path := configFIFO(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type outcome struct {
		config Config
		err    error
	}
	finished := make(chan outcome, 1)
	go func() { config, err := LoadConfigContext(ctx, path); finished <- outcome{config, err} }()
	writer := configFIFOProducer(t, path)
	if _, err := writer.WriteString(contextConfigPayload); err != nil {
		writer.Close()
		t.Fatal(err)
	}
	writer.Close()
	select {
	case result := <-finished:
		if result.err != nil || len(result.config.Tests) != 1 || result.config.Tests[0].Name != "home" {
			t.Fatalf("pipe configuration changed: config=%+v error=%v", result.config, result.err)
		}
	case <-ctx.Done():
		t.Fatal("valid completed pipe was not loaded")
	}
}
