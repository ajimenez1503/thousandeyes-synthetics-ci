// Copyright 2026 Cisco Systems, Inc. and its affiliates
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/text/unicode/norm"
)

func validateReportPaths(configPath string, reportPaths ...string) error {
	configEntry, err := reportEntryPath(configPath)
	if err != nil {
		return err
	}
	configTarget, err := filepath.EvalSymlinks(configEntry)
	if err != nil {
		return err
	}
	// Reading follows a final configuration symlink; writing atomically replaces
	// a final report symlink. Protect both the configuration entry and its target.
	seen := []string{configEntry, configTarget}
	for _, path := range reportPaths {
		if path == "" {
			continue
		}
		entry, err := reportEntryPath(path)
		if err != nil {
			return err
		}
		for _, previous := range seen {
			same, err := sameReportEntry(previous, entry)
			if err != nil {
				return err
			}
			if same {
				return errors.New("configuration and report files must use different paths")
			}
		}
		seen = append(seen, entry)
	}
	return nil
}

func sameReportEntry(left, right string) (bool, error) {
	leftInfo, err := os.Lstat(left)
	if err != nil && !os.IsNotExist(err) {
		return false, err
	}
	rightInfo, err := os.Lstat(right)
	if err != nil && !os.IsNotExist(err) {
		return false, err
	}
	if leftInfo != nil && rightInfo != nil && os.SameFile(leftInfo, rightInfo) {
		return true, nil
	}
	leftName := norm.NFC.String(filepath.Base(left))
	rightName := norm.NFC.String(filepath.Base(right))
	if !strings.EqualFold(leftName, rightName) {
		return false, nil
	}
	leftParent, err := os.Stat(filepath.Dir(left))
	if err != nil {
		return false, err
	}
	rightParent, err := os.Stat(filepath.Dir(right))
	if err != nil {
		return false, err
	}
	// Reserve case and canonical Unicode variants in the same directory on
	// every OS, even before outputs exist, so suites remain portable.
	return os.SameFile(leftParent, rightParent), nil
}

func reportEntryPath(path string) (string, error) {
	// Split before cleaning so a parent symlink followed by ".." retains its
	// filesystem meaning. The final entry is not followed because Rename replaces it.
	directory, name := filepath.Split(path)
	if directory == "" {
		directory = "."
	}
	directory, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return "", err
	}
	directory, err = filepath.Abs(directory)
	if err != nil {
		return "", err
	}
	// Abs may introduce a symlink through the working directory or macOS /var.
	directory, err = filepath.EvalSymlinks(directory)
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, name), nil
}

func writeReportFile(path string, write func(io.Writer) error) error {
	entry, err := reportEntryPath(path)
	if err != nil {
		return fmt.Errorf("resolve report %q: %w", path, err)
	}
	file, err := os.CreateTemp(filepath.Dir(entry), ".thousandeyes-report-*")
	if err != nil {
		return fmt.Errorf("create report %q: %w", path, err)
	}
	temp := file.Name()
	defer os.Remove(temp)
	if err := write(file); err != nil {
		_ = file.Close()
		return fmt.Errorf("write report %q: %w", path, err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close report %q: %w", path, err)
	}
	if err := os.Rename(temp, entry); err != nil {
		return fmt.Errorf("save report %q: %w", path, err)
	}
	return nil
}
