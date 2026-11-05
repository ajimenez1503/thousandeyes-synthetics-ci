// Copyright 2026 Cisco Systems, Inc. and its affiliates
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"os"
	"testing"

	"github.com/spf13/cobra"
)

func newTestRootCommand(t *testing.T) *cobra.Command {
	t.Helper()
	backend := os.Getenv("TE_TEST_API_CLI_PATH")
	if backend == "" {
		t.Skip("set TE_TEST_API_CLI_PATH to run integration tests against the official API CLI")
	}
	t.Setenv("TE_API_CLI_PATH", backend)
	return newRootCommand()
}

func captureCommandIO(t *testing.T, command *cobra.Command) (*bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
	command.SetOut(stdout)
	command.SetErr(stderr)
	return stdout, stderr
}
