// Copyright 2026 Cisco Systems, Inc. and its affiliates
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"encoding/xml"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestSyntheticsReportDestinationsSurviveParentRetarget(t *testing.T) {
	for _, flag := range []string{"--json-report", "--junit-report"} {
		t.Run(flag, func(t *testing.T) {
			directory := t.TempDir()
			configDirectory := filepath.Join(directory, "configuration")
			artifactDirectory := filepath.Join(directory, "artifacts")
			for _, path := range []string{configDirectory, artifactDirectory} {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			}
			alias := filepath.Join(directory, "current-artifacts")
			symlinkSyntheticPath(t, artifactDirectory, alias)
			configPath := filepath.Join(configDirectory, "suite.json")
			payload := singleHTTPConfig("blocking")
			if err := os.WriteFile(configPath, []byte(payload), 0600); err != nil {
				t.Fatal(err)
			}
			var retarget sync.Once
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost {
					syntheticJSON(t, w, http.StatusCreated, map[string]any{
						"testId": "101", "agents": []any{map[string]any{"agentId": "6", "agentType": "cloud"}},
					})
					return
				}
				retarget.Do(func() {
					if err := os.Remove(alias); err != nil {
						t.Errorf("remove report parent alias: %v", err)
						return
					}
					if err := os.Symlink(configDirectory, alias); err != nil {
						t.Errorf("retarget report parent alias: %v", err)
					}
				})
				syntheticJSON(t, w, http.StatusOK, map[string]any{"results": []any{
					map[string]any{"agent": map[string]any{"agentId": "6"}, "roundId": 1793268000, "responseCode": 200},
				}})
			}))
			defer server.Close()
			if err := executeSyntheticPaths(t, server.URL, configPath, flag, filepath.Join(alias, "suite.json")); err != nil {
				t.Fatalf("run passing suite: %v", err)
			}
			original, err := os.ReadFile(configPath)
			if err != nil || string(original) != payload {
				t.Fatalf("report replaced the input configuration: error=%v", err)
			}
			data, err := os.ReadFile(filepath.Join(artifactDirectory, "suite.json"))
			if err != nil {
				t.Fatalf("report missing from the validated destination: %v", err)
			}
			if flag == "--json-report" {
				var report struct {
					RunID string `json:"runId"`
				}
				if err := json.Unmarshal(data, &report); err != nil || report.RunID == "" {
					t.Fatalf("invalid JSON report: %v", err)
				}
			} else {
				var report struct{ XMLName xml.Name }
				if err := xml.Unmarshal(data, &report); err != nil || report.XMLName.Local != "testsuite" {
					t.Fatalf("invalid JUnit report: %v", err)
				}
			}
		})
	}
}
