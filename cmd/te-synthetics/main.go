// Copyright 2026 Cisco Systems, Inc. and its affiliates
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"github.com/thousandeyes/thousandeyes-synthetics-ci/internal/synthetics"
)

var version = "dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	command := newRootCommand()
	err := command.ExecuteContext(ctx)
	if err == nil {
		err = ctx.Err()
	}
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
}

func newRootCommand() *cobra.Command {
	root := &cobra.Command{Use: "te-synthetics", Short: "Run ThousandEyes synthetic checks for CI", Version: version, SilenceErrors: true, SilenceUsage: true}
	var configPath, accountGroupID, jsonPath, junitPath, apiCLIPath string
	var timeout, pollInterval time.Duration
	var jsonOutput bool
	run := &cobra.Command{
		Use: "run-tests", Short: "Create instant tests, wait for results, and evaluate CI checks", Args: cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if command.Flags().Changed("timeout") && timeout <= 0 {
				return errors.New("--timeout must be positive")
			}
			if command.Flags().Changed("poll-interval") && pollInterval <= 0 {
				return errors.New("--poll-interval must be positive")
			}
			suite, err := synthetics.LoadConfigContext(command.Context(), configPath)
			if err != nil {
				return err
			}
			destinations, err := validateReportPaths(configPath, jsonPath, junitPath)
			if err != nil {
				return err
			}
			jsonPath, junitPath = destinations[0], destinations[1]
			report, runErr := synthetics.Run(command.Context(), suite, synthetics.Options{
				BaseURL: os.Getenv("TE_BASE_URL"), Token: os.Getenv("TE_TOKEN"), APICLIPath: apiCLIPath,
				AccountGroupID: accountGroupID, Timeout: timeout, PollInterval: pollInterval,
			})
			var outputErrors []error
			if jsonOutput {
				outputErrors = append(outputErrors, synthetics.WriteJSON(command.OutOrStdout(), report))
			} else {
				outputErrors = append(outputErrors, synthetics.WriteSummary(command.OutOrStdout(), report))
			}
			if jsonPath != "" {
				outputErrors = append(outputErrors, writeReportFile(jsonPath, func(w io.Writer) error { return synthetics.WriteJSON(w, report) }))
			}
			if junitPath != "" {
				outputErrors = append(outputErrors, writeReportFile(junitPath, func(w io.Writer) error { return synthetics.WriteJUnit(w, report) }))
			}
			if outputErr := errors.Join(outputErrors...); outputErr != nil {
				return errors.Join(runErr, outputErr)
			}
			if runErr != nil {
				return runErr
			}
			if report.Failed() {
				return errors.New("synthetic CI checks failed; see the report for details")
			}
			return nil
		},
	}
	run.Flags().StringVar(&configPath, "config", "", "Path to the version 1 synthetic suite JSON file")
	_ = run.MarkFlagRequired("config")
	run.Flags().StringVar(&apiCLIPath, "api-cli-path", "", "Path to the official ThousandEyes API CLI (or TE_API_CLI_PATH)")
	run.Flags().StringVar(&accountGroupID, "account-group-id", "", "Override the account group used for this execution")
	run.Flags().DurationVar(&timeout, "timeout", 0, "Override the suite timeout (for example 5m)")
	run.Flags().DurationVar(&pollInterval, "poll-interval", 0, "Override the result polling interval (for example 5s)")
	run.Flags().StringVar(&jsonPath, "json-report", "", "Write a sanitized JSON report to this file")
	run.Flags().StringVar(&junitPath, "junit-report", "", "Write a JUnit XML report to this file")
	run.Flags().BoolVar(&jsonOutput, "json", false, "Print the sanitized CI report as JSON")
	root.AddCommand(run)
	return root
}
