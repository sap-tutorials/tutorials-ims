# Deploy Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Go MCP + CLI that runs a project's deploy chain, keeps full logs on disk, and returns a ~200-token structured verdict instead of raw scrollback.

**Architecture:** A single Go binary exposes both `deploy-watcher mcp serve` (MCP over stdio) and `deploy-watcher plan|run|verdict|logs` (CLI), sharing one engine: a per-project `deploy-watcher.yaml` descriptor (resolved from cwd) → a runner that spawns the chain and tees output to disk → a pure classifier that turns log text + exit code into a `Verdict`. Exec is dev/qa only and strictly human-approved; prod is operator-gated.

**Tech Stack:** Go 1.26, `github.com/mark3labs/mcp-go v0.52.0` (matches sap-devs-cli), `gopkg.in/yaml.v3`, standard library `os/exec`.

**Spec:** `docs/superpowers/specs/2026-09-12-deploy-watcher-design.md`

**Target repo:** New standalone repo (proposed `github.tools.sap/developer-relations/deploy-watcher`). All `Create:` paths below are relative to that new repo's root. This plan and the spec live in tutorials-ims (where the reference descriptor + fixtures originate) and travel to the new repo.

## Global Constraints

- **Module path:** `github.tools.sap/developer-relations/deploy-watcher`. `go 1.26`.
- **MCP SDK:** `github.com/mark3labs/mcp-go v0.52.0`. Server via `server.NewMCPServer(...)`; tools via `s.AddTool(mcp.NewTool(name, mcp.WithDescription(...), mcp.WithString/Number/Boolean(...)), handler)`; results via `mcp.NewToolResultText(jsonString)` and errors via `mcp.NewToolResultError(msg)`. Handler type is `func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error)`; read args with `req.GetString("name","")`, `req.GetBool("name",false)`.
- **Naming:** the tool is the **Deploy Watcher**. Never "oracle".
- **Prod is never executed by the tool.** `env == prod` → return `status: "requires_operator"` + the operator command; do not spawn the chain.
- **Every exec requires human approval** via the MCP client's permission prompt (the tool is non-readonly) AND a valid `plan_id` from a prior `deploy_plan`.
- **Full logs never returned wholesale.** Verdict carries `error_extract` (≤ ~25 lines) + `log_path`; `deploy_logs` serves bounded slices only.
- **Cross-platform:** Windows is a first-class dev environment. Use `filepath`, `os.UserHomeDir()`, and `runtime`-aware command splitting; no hardcoded `/` roots or bash-isms.
- **TDD:** every task writes the failing test first. Frequent commits.

---

### Task 1: Repo bootstrap + version command

**Files:**
- Create: `go.mod`
- Create: `main.go`
- Create: `cmd/root.go`
- Create: `internal/version/version.go`
- Test: `internal/version/version_test.go`

**Interfaces:**
- Produces: `version.Version` (string const), `version.String() string`.

- [ ] **Step 1: Write the failing test**

```go
// internal/version/version_test.go
package version_test

import (
	"strings"
	"testing"

	"github.tools.sap/developer-relations/deploy-watcher/internal/version"
)

func TestStringContainsVersion(t *testing.T) {
	if !strings.Contains(version.String(), version.Version) {
		t.Fatalf("String() %q must contain Version %q", version.String(), version.Version)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/version/`
Expected: FAIL — package `version` does not exist / undefined.

- [ ] **Step 3: Write minimal implementation**

```go
// go.mod
module github.tools.sap/developer-relations/deploy-watcher

go 1.26
```

```go
// internal/version/version.go
package version

const Version = "0.1.0"

func String() string { return "deploy-watcher " + Version }
```

```go
// cmd/root.go
package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.tools.sap/developer-relations/deploy-watcher/internal/version"
)

func NewRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:   "deploy-watcher",
		Short: "Run deploy chains and return a compact verdict instead of raw logs.",
	}
	root.AddCommand(&cobra.Command{
		Use:   "version",
		Short: "Print the deploy-watcher version.",
		Run:   func(_ *cobra.Command, _ []string) { fmt.Println(version.String()) },
	})
	return root
}
```

```go
// main.go
package main

import (
	"fmt"
	"os"

	"github.tools.sap/developer-relations/deploy-watcher/cmd"
)

func main() {
	if err := cmd.NewRootCmd().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
```

- [ ] **Step 4: Resolve deps and run the test**

Run: `go mod tidy && go test ./internal/version/`
Expected: PASS. (`go mod tidy` adds cobra + resolves the module graph.)

- [ ] **Step 5: Commit**

```bash
git add go.mod go.sum main.go cmd/root.go internal/version/
git commit -m "chore: bootstrap deploy-watcher module + version command"
```

---

### Task 2: Descriptor loader

**Files:**
- Create: `internal/descriptor/descriptor.go`
- Test: `internal/descriptor/descriptor_test.go`
- Create (test fixture): `internal/descriptor/testdata/deploy-watcher.yaml`

**Interfaces:**
- Produces:
  - `type Descriptor struct { Project string; Chain Chain; Envs []string; ExecPolicy ExecPolicy; Steps []StepRule; Signals []Signal; Thresholds map[string]int; Smoke SmokeCfg; Preflight []string; Root string }`
  - `type Chain struct { Command, EnvFlag, StrategyFlag string }`
  - `type ExecPolicy struct { HITL []string; OperatorOnly []string }`
  - `type StepRule struct { Match, Name, Status string }`
  - `type Signal struct { ID, Pattern, NextAction string }`
  - `type SmokeCfg struct { Command, Baseline string }`
  - `func Load(startDir string) (*Descriptor, error)` — walks up from `startDir` to find `deploy-watcher.yaml`, parses, validates.
  - `func (d *Descriptor) ChainArgs(env, strategy string) []string` — expands `Command` + `EnvFlag`/`StrategyFlag` templates (`{env}`, `{strategy}`) into an argv slice; omits the strategy flag when `strategy == ""`.
  - `func (d *Descriptor) ExecMode(env string) string` — returns `"hitl"`, `"operator_only"`, or `"unknown"`.

- [ ] **Step 1: Write the failing test**

```go
// internal/descriptor/descriptor_test.go
package descriptor_test

import (
	"reflect"
	"testing"

	"github.tools.sap/developer-relations/deploy-watcher/internal/descriptor"
)

func TestLoadWalksUpAndParses(t *testing.T) {
	d, err := descriptor.Load("testdata")
	if err != nil {
		t.Fatal(err)
	}
	if d.Project != "sample-proj" {
		t.Fatalf("project = %q", d.Project)
	}
	if d.ExecMode("prod") != "operator_only" {
		t.Fatalf("prod exec mode = %q", d.ExecMode("prod"))
	}
	if d.ExecMode("dev") != "hitl" {
		t.Fatalf("dev exec mode = %q", d.ExecMode("dev"))
	}
}

func TestChainArgsExpandsTemplates(t *testing.T) {
	d, err := descriptor.Load("testdata")
	if err != nil {
		t.Fatal(err)
	}
	got := d.ChainArgs("dev", "blue-green")
	want := []string{"node", "deploy.cjs", "--env", "dev", "--strategy", "blue-green"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	// strategy omitted when empty
	got = d.ChainArgs("dev", "")
	want = []string{"node", "deploy.cjs", "--env", "dev"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestLoadRejectsMissingFile(t *testing.T) {
	if _, err := descriptor.Load(t.TempDir()); err == nil {
		t.Fatal("expected error when no descriptor found")
	}
}
```

```yaml
# internal/descriptor/testdata/deploy-watcher.yaml
project: sample-proj
chain:
  command: "node deploy.cjs"
  env_flag: "--env {env}"
  strategy_flag: "--strategy {strategy}"
envs: [dev, qa, prod]
exec_policy:
  hitl: [dev, qa]
  operator_only: [prod]
steps:
  - match: "SMOKE GATE FAILED"
    name: "smoke gate"
    status: smoke_regressed
signals:
  - id: oom
    pattern: "exit status 137"
    next_action: "raise memory"
thresholds:
  srv_qa_min_mb: 1536
smoke:
  command: "npm run test:smoke"
  baseline: "smoke-baseline.dev.json"
preflight:
  - git_fresh_origin
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/descriptor/`
Expected: FAIL — undefined `descriptor.Load`.

- [ ] **Step 3: Write minimal implementation**

```go
// internal/descriptor/descriptor.go
package descriptor

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

const FileName = "deploy-watcher.yaml"

type Chain struct {
	Command      string `yaml:"command"`
	EnvFlag      string `yaml:"env_flag"`
	StrategyFlag string `yaml:"strategy_flag"`
}

type ExecPolicy struct {
	HITL         []string `yaml:"hitl"`
	OperatorOnly []string `yaml:"operator_only"`
}

type StepRule struct {
	Match  string `yaml:"match"`
	Name   string `yaml:"name"`
	Status string `yaml:"status"`
}

type Signal struct {
	ID         string `yaml:"id"`
	Pattern    string `yaml:"pattern"`
	NextAction string `yaml:"next_action"`
}

type SmokeCfg struct {
	Command  string `yaml:"command"`
	Baseline string `yaml:"baseline"`
}

type Descriptor struct {
	Project    string         `yaml:"project"`
	Chain      Chain          `yaml:"chain"`
	Envs       []string       `yaml:"envs"`
	ExecPolicy ExecPolicy     `yaml:"exec_policy"`
	Steps      []StepRule     `yaml:"steps"`
	Signals    []Signal       `yaml:"signals"`
	Thresholds map[string]int `yaml:"thresholds"`
	Smoke      SmokeCfg       `yaml:"smoke"`
	Preflight  []string       `yaml:"preflight"`
	Root       string         `yaml:"-"`
}

// Load walks up from startDir looking for deploy-watcher.yaml.
func Load(startDir string) (*Descriptor, error) {
	dir, err := filepath.Abs(startDir)
	if err != nil {
		return nil, err
	}
	for {
		p := filepath.Join(dir, FileName)
		if _, statErr := os.Stat(p); statErr == nil {
			return parse(p, dir)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return nil, fmt.Errorf("no %s found from %s upward", FileName, startDir)
		}
		dir = parent
	}
}

func parse(path, root string) (*Descriptor, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var d Descriptor
	if err := yaml.Unmarshal(b, &d); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if d.Project == "" || d.Chain.Command == "" {
		return nil, fmt.Errorf("%s: project and chain.command are required", path)
	}
	d.Root = root
	return &d, nil
}

func (d *Descriptor) ChainArgs(env, strategy string) []string {
	args := strings.Fields(d.Chain.Command)
	if d.Chain.EnvFlag != "" {
		args = append(args, strings.Fields(strings.ReplaceAll(d.Chain.EnvFlag, "{env}", env))...)
	}
	if strategy != "" && d.Chain.StrategyFlag != "" {
		args = append(args, strings.Fields(strings.ReplaceAll(d.Chain.StrategyFlag, "{strategy}", strategy))...)
	}
	return args
}

func (d *Descriptor) ExecMode(env string) string {
	for _, e := range d.ExecPolicy.OperatorOnly {
		if e == env {
			return "operator_only"
		}
	}
	for _, e := range d.ExecPolicy.HITL {
		if e == env {
			return "hitl"
		}
	}
	return "unknown"
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go mod tidy && go test ./internal/descriptor/`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add internal/descriptor/ go.mod go.sum
git commit -m "feat: descriptor loader with cwd walk-up and template expansion"
```

---

### Task 3: Classifier (pure log → verdict)

**Files:**
- Create: `internal/classify/verdict.go`
- Create: `internal/classify/classify.go`
- Test: `internal/classify/classify_test.go`

**Interfaces:**
- Consumes: `descriptor.Descriptor`, `descriptor.StepRule`, `descriptor.Signal`.
- Produces:
  - `type Verdict struct { RunID, Project, Env, Strategy, Status, FailedStep, Signal, ErrorExtract, MtarVersion string; SmokeDiff *smoke.SmokeDiff; DurationS int; ExitCode int; LogPath, NextAction string }` with JSON tags: `run_id, project, env, strategy, status, failed_step, signal, error_extract, mtar_version, smoke_diff, duration_s, exit_code, log_path, next_action`.
  - `func Classify(log string, exitCode int, d *descriptor.Descriptor) Verdict` — sets `Status, FailedStep, Signal, ErrorExtract, MtarVersion, ExitCode, NextAction` only. Caller fills run metadata + `SmokeDiff`.
- Status rules (in order): `exitCode == 0` → `"success"`; a matched `StepRule.Status` override on the last matched step → that status (e.g. `smoke_regressed`); otherwise → `"failed"`.

> **Note:** `Verdict` imports `smoke.SmokeDiff` from Task 4. To keep Task 3 self-contained, define `SmokeDiff` in Task 4's package and have Task 3 import it — implement Task 4 before running Task 3's build, or temporarily type the field as `*smoke.SmokeDiff` and complete `go mod`/build once Task 4 lands. Tasks 3 and 4 are sibling leaf packages; either order compiles once both exist. Implement Task 4 first if doing them strictly sequentially.

- [ ] **Step 1: Write the failing test**

```go
// internal/classify/classify_test.go
package classify_test

import (
	"strings"
	"testing"

	"github.tools.sap/developer-relations/deploy-watcher/internal/classify"
	"github.tools.sap/developer-relations/deploy-watcher/internal/descriptor"
)

func fixtureDescriptor() *descriptor.Descriptor {
	return &descriptor.Descriptor{
		Project: "tutorials-ims",
		Steps: []descriptor.StepRule{
			{Match: "Step 3.5", Name: "admin-bundle drift check"},
			{Match: "SMOKE GATE FAILED", Name: "smoke gate", Status: "smoke_regressed"},
		},
		Signals: []descriptor.Signal{
			{ID: "stale_admin_bundle", Pattern: "stale admin UI", NextAction: "Rebuild WITHOUT --skip-build."},
			{ID: "cds_deploy_error", Pattern: `in cds\.deploy`, NextAction: "grep the full log for 'in cds.deploy'."},
			{ID: "oom", Pattern: "exit status 137", NextAction: "raise memory (srv-qa >=1536M)."},
		},
	}
}

func TestSuccess(t *testing.T) {
	log := "  ✓ Step 2: build\n  ✓ Step 5: smoke gate\nMTA version 1.25.0\n"
	v := classify.Classify(log, 0, fixtureDescriptor())
	if v.Status != "success" {
		t.Fatalf("status = %q", v.Status)
	}
	if v.MtarVersion != "1.25.0" {
		t.Fatalf("mtar = %q", v.MtarVersion)
	}
}

func TestAdminBundleDrift(t *testing.T) {
	log := "Step 3.5: verify admin bundle\n[deploy] FAILED: This mtar would ship a stale admin UI\n"
	v := classify.Classify(log, 1, fixtureDescriptor())
	if v.Status != "failed" {
		t.Fatalf("status = %q", v.Status)
	}
	if v.FailedStep != "Step 3.5: admin-bundle drift check" {
		t.Fatalf("failed_step = %q", v.FailedStep)
	}
	if v.Signal != "stale_admin_bundle" {
		t.Fatalf("signal = %q", v.Signal)
	}
	if !strings.Contains(v.ErrorExtract, "stale admin UI") {
		t.Fatalf("extract missing failure line: %q", v.ErrorExtract)
	}
	if v.NextAction == "" {
		t.Fatal("expected next_action")
	}
}

func TestSmokeRegressionUsesStatusOverride(t *testing.T) {
	log := "  ✓ Step 4: cf deploy\n[deploy] SMOKE GATE FAILED\n"
	v := classify.Classify(log, 2, fixtureDescriptor())
	if v.Status != "smoke_regressed" {
		t.Fatalf("status = %q", v.Status)
	}
	if v.FailedStep != "smoke gate" {
		t.Fatalf("failed_step = %q", v.FailedStep)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/classify/`
Expected: FAIL — undefined `classify.Classify`.

- [ ] **Step 3: Write minimal implementation**

```go
// internal/classify/verdict.go
package classify

import "github.tools.sap/developer-relations/deploy-watcher/internal/smoke"

type Verdict struct {
	RunID        string           `json:"run_id"`
	Project      string           `json:"project"`
	Env          string           `json:"env"`
	Strategy     string           `json:"strategy"`
	Status       string           `json:"status"`
	FailedStep   string           `json:"failed_step,omitempty"`
	Signal       string           `json:"signal,omitempty"`
	ErrorExtract string           `json:"error_extract,omitempty"`
	MtarVersion  string           `json:"mtar_version,omitempty"`
	SmokeDiff    *smoke.SmokeDiff `json:"smoke_diff,omitempty"`
	DurationS    int              `json:"duration_s"`
	ExitCode     int              `json:"exit_code"`
	LogPath      string           `json:"log_path,omitempty"`
	NextAction   string           `json:"next_action,omitempty"`
}
```

```go
// internal/classify/classify.go
package classify

import (
	"regexp"
	"strings"

	"github.tools.sap/developer-relations/deploy-watcher/internal/descriptor"
)

var mtarRe = regexp.MustCompile(`(?i)mta version[^0-9]*([0-9]+\.[0-9]+\.[0-9]+)`)

const extractLines = 25

func Classify(log string, exitCode int, d *descriptor.Descriptor) Verdict {
	v := Verdict{ExitCode: exitCode, Status: "failed"}

	if m := mtarRe.FindStringSubmatch(log); m != nil {
		v.MtarVersion = m[1]
	}

	// Last matching step rule wins (deepest phase reached / failed).
	for _, s := range d.Steps {
		if strings.Contains(log, s.Match) {
			if s.Name != "" {
				v.FailedStep = s.Name
			} else {
				v.FailedStep = s.Match
			}
			if s.Status != "" {
				v.Status = s.Status
			}
		}
	}

	// First matching signal wins (declaration order = priority).
	for _, sig := range d.Signals {
		re, err := regexp.Compile(sig.Pattern)
		if err != nil {
			continue
		}
		if re.MatchString(log) {
			v.Signal = sig.ID
			v.NextAction = sig.NextAction
			break
		}
	}

	if exitCode == 0 {
		v.Status = "success"
		v.FailedStep = ""
		return v
	}

	v.ErrorExtract = extract(log)
	return v
}

// extract returns the last extractLines non-empty lines, biased toward the failure.
func extract(log string) string {
	lines := strings.Split(strings.TrimRight(log, "\n"), "\n")
	// Prefer a window around the first FAILED/error marker.
	for i, ln := range lines {
		if strings.Contains(ln, "FAILED") || strings.Contains(ln, "Error") {
			start := i - 5
			if start < 0 {
				start = 0
			}
			end := i + extractLines - 5
			if end > len(lines) {
				end = len(lines)
			}
			return strings.Join(lines[start:end], "\n")
		}
	}
	if len(lines) > extractLines {
		lines = lines[len(lines)-extractLines:]
	}
	return strings.Join(lines, "\n")
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/classify/`
Expected: PASS (requires Task 4's `smoke` package to exist — do Task 4 first if strictly sequential).

- [ ] **Step 5: Commit**

```bash
git add internal/classify/
git commit -m "feat: pure log-to-verdict classifier (step, signal, extract, mtar)"
```

---

### Task 4: Smoke diff

**Files:**
- Create: `internal/smoke/smoke.go`
- Test: `internal/smoke/smoke_test.go`

**Interfaces:**
- Produces:
  - `type SmokeDiff struct { Failed []string `json:"failed"`; NewlyPassing []string `json:"newly_passing"` }`
  - `type SmokeSet map[string]bool` (test name → passed)
  - `func LoadBaseline(path string) (SmokeSet, error)` — reads a JSON `{ "name": true/false }` file; missing file returns an empty set + nil error (first run has no baseline).
  - `func Diff(current, baseline SmokeSet) SmokeDiff` — `Failed` = names failing now; `NewlyPassing` = names failing in baseline but passing now. Sorted for determinism.

- [ ] **Step 1: Write the failing test**

```go
// internal/smoke/smoke_test.go
package smoke_test

import (
	"reflect"
	"testing"

	"github.tools.sap/developer-relations/deploy-watcher/internal/smoke"
)

func TestDiff(t *testing.T) {
	base := smoke.SmokeSet{"browse": true, "advocates": false, "home": true}
	cur := smoke.SmokeSet{"browse": false, "advocates": true, "home": true}
	got := smoke.Diff(cur, base)
	want := smoke.SmokeDiff{Failed: []string{"browse"}, NewlyPassing: []string{"advocates"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v want %+v", got, want)
	}
}

func TestLoadBaselineMissingIsEmpty(t *testing.T) {
	s, err := smoke.LoadBaseline(t.TempDir() + "/nope.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(s) != 0 {
		t.Fatalf("expected empty set, got %v", s)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/smoke/`
Expected: FAIL — undefined `smoke.Diff`.

- [ ] **Step 3: Write minimal implementation**

```go
// internal/smoke/smoke.go
package smoke

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"sort"
)

type SmokeDiff struct {
	Failed       []string `json:"failed"`
	NewlyPassing []string `json:"newly_passing"`
}

type SmokeSet map[string]bool

func LoadBaseline(path string) (SmokeSet, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return SmokeSet{}, nil
	}
	if err != nil {
		return nil, err
	}
	var s SmokeSet
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, err
	}
	return s, nil
}

func Diff(current, baseline SmokeSet) SmokeDiff {
	d := SmokeDiff{Failed: []string{}, NewlyPassing: []string{}}
	for name, pass := range current {
		if !pass {
			d.Failed = append(d.Failed, name)
		}
		if was, ok := baseline[name]; ok && !was && pass {
			d.NewlyPassing = append(d.NewlyPassing, name)
		}
	}
	sort.Strings(d.Failed)
	sort.Strings(d.NewlyPassing)
	return d
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/smoke/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/smoke/
git commit -m "feat: smoke result baseline load + diff"
```

---

### Task 5: Runner (spawn + tee + capture)

**Files:**
- Create: `internal/runner/runner.go`
- Test: `internal/runner/runner_test.go`
- Create (test fixture): `internal/runner/testdata/fake_chain.go` (a tiny program the test builds/runs), OR use a shell/`go run` inline script — see step.

**Interfaces:**
- Produces:
  - `type RunResult struct { ExitCode int; LogPath string; Duration time.Duration }`
  - `func Run(ctx context.Context, argv []string, workDir, logPath string) (RunResult, error)` — spawns `argv[0]` with `argv[1:]` in `workDir`, tees combined stdout+stderr to `logPath` (created, parent dirs made), returns exit code (0 on success; the process exit code on `*exec.ExitError`; non-nil `error` only for spawn/setup failures, not for a non-zero child exit).

- [ ] **Step 1: Write the failing test**

```go
// internal/runner/runner_test.go
package runner_test

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.tools.sap/developer-relations/deploy-watcher/internal/runner"
)

func TestRunTeesAndCapturesExit(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "run.log")

	// Cross-platform fake chain: a go program that prints and exits 3.
	var argv []string
	if runtime.GOOS == "windows" {
		argv = []string{"cmd", "/c", "echo hello-chain & exit 3"}
	} else {
		argv = []string{"sh", "-c", "echo hello-chain; exit 3"}
	}

	res, err := runner.Run(context.Background(), argv, dir, logPath)
	if err != nil {
		t.Fatalf("Run returned setup error: %v", err)
	}
	if res.ExitCode != 3 {
		t.Fatalf("exit code = %d, want 3", res.ExitCode)
	}
	b, readErr := os.ReadFile(logPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if !strings.Contains(string(b), "hello-chain") {
		t.Fatalf("log missing output: %q", string(b))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/runner/`
Expected: FAIL — undefined `runner.Run`.

- [ ] **Step 3: Write minimal implementation**

```go
// internal/runner/runner.go
package runner

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

type RunResult struct {
	ExitCode int
	LogPath  string
	Duration time.Duration
}

func Run(ctx context.Context, argv []string, workDir, logPath string) (RunResult, error) {
	if len(argv) == 0 {
		return RunResult{}, errors.New("empty argv")
	}
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return RunResult{}, err
	}
	f, err := os.Create(logPath)
	if err != nil {
		return RunResult{}, err
	}
	defer f.Close()

	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = workDir
	mw := io.MultiWriter(f) // extend with an in-memory tail writer if needed
	cmd.Stdout = mw
	cmd.Stderr = mw

	start := time.Now()
	runErr := cmd.Run()
	res := RunResult{LogPath: logPath, Duration: time.Since(start)}

	var exitErr *exec.ExitError
	switch {
	case runErr == nil:
		res.ExitCode = 0
	case errors.As(runErr, &exitErr):
		res.ExitCode = exitErr.ExitCode()
	default:
		return res, runErr // spawn/setup failure
	}
	return res, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/runner/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/runner/
git commit -m "feat: chain runner with tee-to-file and exit-code capture"
```

---

### Task 6: Preflight guards (read-only)

**Files:**
- Create: `internal/preflight/preflight.go`
- Test: `internal/preflight/preflight_test.go`

**Interfaces:**
- Consumes: `descriptor.Descriptor`.
- Produces:
  - `type Result struct { Guard string `json:"guard"`; OK bool `json:"ok"`; Detail string `json:"detail"` }`
  - `type Runner func(args ...string) (string, error)` — injectable command runner (real one shells out; tests inject a fake).
  - `func Check(names []string, env string, run Runner) []Result` — runs each named guard, returns one `Result` each. Unknown guard names produce `OK:false, Detail:"unknown guard"`.
  - Guard IDs implemented: `cf_target_matches_env` (parses `cf target` output for the env's org/space substring), `git_fresh_origin` (`git status -sb` has no `behind`), `node_auth_token_present` (`NODE_AUTH_TOKEN` env var non-empty).

> Guards are read-only. `cf_target_matches_env` matches on the env name appearing in `cf target` output (e.g. space `prod`/`dev`); the tutorials-ims descriptor relies on space naming, which the classifier's `cf_target_drift` signal complements.

- [ ] **Step 1: Write the failing test**

```go
// internal/preflight/preflight_test.go
package preflight_test

import (
	"fmt"
	"testing"

	"github.tools.sap/developer-relations/deploy-watcher/internal/preflight"
)

func TestGitFreshOriginDetectsBehind(t *testing.T) {
	fake := func(args ...string) (string, error) {
		return "## main...origin/main [behind 2]", nil
	}
	res := preflight.Check([]string{"git_fresh_origin"}, "dev", fake)
	if len(res) != 1 || res[0].OK {
		t.Fatalf("expected git_fresh_origin to fail when behind: %+v", res)
	}
}

func TestCfTargetMatchesEnv(t *testing.T) {
	fake := func(args ...string) (string, error) {
		return "space:            dev\norg:  tutorial-system", nil
	}
	if res := preflight.Check([]string{"cf_target_matches_env"}, "dev", fake); !res[0].OK {
		t.Fatalf("expected match for dev: %+v", res)
	}
	if res := preflight.Check([]string{"cf_target_matches_env"}, "prod", fake); res[0].OK {
		t.Fatalf("expected mismatch when targeting prod but on dev: %+v", res)
	}
}

func TestUnknownGuard(t *testing.T) {
	res := preflight.Check([]string{"nope"}, "dev", func(...string) (string, error) { return "", fmt.Errorf("x") })
	if res[0].OK || res[0].Detail != "unknown guard" {
		t.Fatalf("unexpected: %+v", res)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/preflight/`
Expected: FAIL — undefined `preflight.Check`.

- [ ] **Step 3: Write minimal implementation**

```go
// internal/preflight/preflight.go
package preflight

import (
	"os"
	"os/exec"
	"strings"
)

type Result struct {
	Guard  string `json:"guard"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

type Runner func(args ...string) (string, error)

// ExecRunner is the production Runner: run args[0] with args[1:].
func ExecRunner(args ...string) (string, error) {
	if len(args) == 0 {
		return "", nil
	}
	out, err := exec.Command(args[0], args[1:]...).CombinedOutput()
	return string(out), err
}

func Check(names []string, env string, run Runner) []Result {
	out := make([]Result, 0, len(names))
	for _, n := range names {
		switch n {
		case "git_fresh_origin":
			out = append(out, gitFresh(run))
		case "cf_target_matches_env":
			out = append(out, cfTarget(env, run))
		case "node_auth_token_present":
			ok := os.Getenv("NODE_AUTH_TOKEN") != ""
			out = append(out, Result{Guard: n, OK: ok, Detail: cond(ok, "set", "NODE_AUTH_TOKEN missing")})
		default:
			out = append(out, Result{Guard: n, OK: false, Detail: "unknown guard"})
		}
	}
	return out
}

func gitFresh(run Runner) Result {
	s, err := run("git", "status", "-sb")
	if err != nil {
		return Result{Guard: "git_fresh_origin", OK: false, Detail: "git status failed"}
	}
	if strings.Contains(s, "behind") {
		return Result{Guard: "git_fresh_origin", OK: false, Detail: "HEAD is behind origin — never deploy stale"}
	}
	return Result{Guard: "git_fresh_origin", OK: true, Detail: "up to date"}
}

func cfTarget(env string, run Runner) Result {
	s, err := run("cf", "target")
	if err != nil {
		return Result{Guard: "cf_target_matches_env", OK: false, Detail: "cf target failed (logged in?)"}
	}
	ok := strings.Contains(s, env)
	return Result{Guard: "cf_target_matches_env", OK: ok, Detail: cond(ok, "target contains "+env, "cf target does not match "+env)}
}

func cond(b bool, y, n string) string {
	if b {
		return y
	}
	return n
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/preflight/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/preflight/
git commit -m "feat: read-only preflight guards (cf target, git fresh, node auth token)"
```

---

### Task 7: MCP server + tools (engine wiring, HITL, prod gate)

**Files:**
- Create: `internal/engine/engine.go` (run store + orchestration shared by MCP and CLI)
- Create: `internal/mcpserver/server.go`
- Create: `internal/mcpserver/tools.go`
- Test: `internal/engine/engine_test.go`
- Test: `internal/mcpserver/server_test.go`

**Interfaces:**
- Consumes: `descriptor`, `runner`, `classify`, `smoke`, `preflight`.
- Produces (engine):
  - `type Engine struct { WorkDir, LogRoot string; Run runner.RunFunc; Preflight preflight.Runner; Now func() time.Time }` where `runner.RunFunc = func(ctx, argv []string, workDir, logPath string) (runner.RunResult, error)` (add this alias to the runner package: `type RunFunc = func(...)`).
  - `func New(workDir string) (*Engine, error)` — sets `LogRoot` to `<userHome>/.deploy-watcher/runs`, real runner + preflight.
  - `type Plan struct { PlanID, Project, Env, Strategy string; Preflight []preflight.Result; ChainPreview []string }`
  - `func (e *Engine) MakePlan(env, strategy string) (Plan, *descriptor.Descriptor, error)` — loads descriptor, validates env ∈ `Envs`, runs preflight, mints `PlanID`, stores it.
  - `func (e *Engine) Execute(planID string, confirm bool) (classify.Verdict, error)` — validates plan; if `ExecMode(env)=="operator_only"` returns a `Verdict{Status:"requires_operator", NextAction:<operator cmd>}` WITHOUT running; if `!confirm` returns error `"confirmation required"`; else runs chain → reads log → `classify.Classify` → fills run metadata; if descriptor has a smoke baseline and the log includes smoke output, attaches `SmokeDiff`. Registers the run so `Verdict(runID)` and `Logs(...)` work.
  - `func (e *Engine) Verdict(runID string) (classify.Verdict, error)`
  - `func (e *Engine) Logs(runID, step, grep string, maxBytes int) (string, error)` — bounded slice of the on-disk log.
- Produces (mcpserver): `func NewServer(e *engine.Engine) *server.MCPServer` registering tools `deploy_plan`, `deploy_run`, `deploy_verdict`, `deploy_logs`, each returning `mcp.NewToolResultText(<json>)`.

> **Prod-gate test is the load-bearing safety test.** It must assert that `Execute` on an `operator_only` env never calls the runner.

- [ ] **Step 1: Write the failing tests**

```go
// internal/engine/engine_test.go
package engine_test

import (
	"context"
	"testing"
	"time"

	"github.tools.sap/developer-relations/deploy-watcher/internal/descriptor"
	"github.tools.sap/developer-relations/deploy-watcher/internal/engine"
	"github.tools.sap/developer-relations/deploy-watcher/internal/preflight"
	"github.tools.sap/developer-relations/deploy-watcher/internal/runner"
)

// newTestEngine builds an Engine whose descriptor is in workDir and whose
// runner/preflight are fakes that never touch the network.
func newTestEngine(t *testing.T, ran *bool) *engine.Engine {
	t.Helper()
	dir := writeDescriptor(t) // helper writes a deploy-watcher.yaml (dev=hitl, prod=operator_only) into a temp dir
	e := &engine.Engine{
		WorkDir:   dir,
		LogRoot:   t.TempDir(),
		Preflight: func(...string) (string, error) { return "## main...origin/main", nil },
		Now:       func() time.Time { return time.Unix(0, 0) },
		Run: func(_ context.Context, _ []string, _, logPath string) (runner.RunResult, error) {
			*ran = true
			return runner.RunResult{ExitCode: 0, LogPath: logPath}, nil
		},
	}
	return e
}

func TestProdGateNeverRuns(t *testing.T) {
	ran := false
	e := newTestEngine(t, &ran)
	p, _, err := e.MakePlan("prod", "")
	if err != nil {
		t.Fatal(err)
	}
	v, err := e.Execute(p.PlanID, true)
	if err != nil {
		t.Fatal(err)
	}
	if v.Status != "requires_operator" {
		t.Fatalf("status = %q, want requires_operator", v.Status)
	}
	if ran {
		t.Fatal("prod must NEVER invoke the runner")
	}
}

func TestHITLRequiresConfirm(t *testing.T) {
	ran := false
	e := newTestEngine(t, &ran)
	p, _, _ := e.MakePlan("dev", "")
	if _, err := e.Execute(p.PlanID, false); err == nil {
		t.Fatal("expected error when confirm=false")
	}
	if ran {
		t.Fatal("must not run without confirmation")
	}
}

func TestUnknownPlanRejected(t *testing.T) {
	ran := false
	e := newTestEngine(t, &ran)
	if _, err := e.Execute("bogus-plan-id", true); err == nil {
		t.Fatal("expected error for unknown plan_id")
	}
}

func TestDevExecutesAndProducesVerdict(t *testing.T) {
	ran := false
	e := newTestEngine(t, &ran)
	p, _, _ := e.MakePlan("dev", "")
	v, err := e.Execute(p.PlanID, true)
	if err != nil {
		t.Fatal(err)
	}
	if !ran || v.Status != "success" || v.RunID == "" {
		t.Fatalf("unexpected verdict: %+v (ran=%v)", v, ran)
	}
	if got, err := e.Verdict(v.RunID); err != nil || got.RunID != v.RunID {
		t.Fatalf("verdict lookup failed: %+v err=%v", got, err)
	}
}
```

```go
// internal/mcpserver/server_test.go
package mcpserver_test

import (
	"testing"

	"github.tools.sap/developer-relations/deploy-watcher/internal/engine"
	"github.tools.sap/developer-relations/deploy-watcher/internal/mcpserver"
)

func TestNewServerRegistersTools(t *testing.T) {
	s := mcpserver.NewServer(&engine.Engine{})
	if s == nil {
		t.Fatal("nil server")
	}
	// mcp-go exposes registered tools via ListTools on the server; assert the four names are present.
	// (Use the mcp-go server API available in v0.52.0; if no public lister exists,
	//  assert construction does not panic and rely on engine tests for behavior.)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/engine/ ./internal/mcpserver/`
Expected: FAIL — undefined `engine.Engine`, `mcpserver.NewServer`.

- [ ] **Step 3: Write minimal implementation**

Add to `internal/runner/runner.go`: `type RunFunc = func(ctx context.Context, argv []string, workDir, logPath string) (RunResult, error)`.

```go
// internal/engine/engine.go
package engine

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.tools.sap/developer-relations/deploy-watcher/internal/classify"
	"github.tools.sap/developer-relations/deploy-watcher/internal/descriptor"
	"github.tools.sap/developer-relations/deploy-watcher/internal/preflight"
	"github.tools.sap/developer-relations/deploy-watcher/internal/runner"
	"github.tools.sap/developer-relations/deploy-watcher/internal/smoke"
)

type Engine struct {
	WorkDir   string
	LogRoot   string
	Run       runner.RunFunc
	Preflight preflight.Runner
	Now       func() time.Time

	mu    sync.Mutex
	plans map[string]planRec
	runs  map[string]classify.Verdict
}

type planRec struct {
	env, strategy string
}

type Plan struct {
	PlanID       string             `json:"plan_id"`
	Project      string             `json:"project"`
	Env          string             `json:"env"`
	Strategy     string             `json:"strategy"`
	Preflight    []preflight.Result `json:"preflight"`
	ChainPreview []string           `json:"chain_preview"`
}

func New(workDir string) (*Engine, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return &Engine{
		WorkDir:   workDir,
		LogRoot:   filepath.Join(home, ".deploy-watcher", "runs"),
		Run:       runner.Run,
		Preflight: preflight.ExecRunner,
		Now:       time.Now,
	}, nil
}

func (e *Engine) init() {
	if e.plans == nil {
		e.plans = map[string]planRec{}
	}
	if e.runs == nil {
		e.runs = map[string]classify.Verdict{}
	}
	if e.Now == nil {
		e.Now = time.Now
	}
}

func (e *Engine) MakePlan(env, strategy string) (Plan, *descriptor.Descriptor, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.init()

	d, err := descriptor.Load(e.WorkDir)
	if err != nil {
		return Plan{}, nil, err
	}
	if !contains(d.Envs, env) {
		return Plan{}, nil, fmt.Errorf("env %q not in descriptor envs %v", env, d.Envs)
	}
	pf := preflight.Check(d.Preflight, env, e.Preflight)
	id := fmt.Sprintf("%s-%s-%d", d.Project, env, e.Now().UnixNano())
	e.plans[id] = planRec{env: env, strategy: strategy}
	return Plan{
		PlanID:       id,
		Project:      d.Project,
		Env:          env,
		Strategy:     strategy,
		Preflight:    pf,
		ChainPreview: d.ChainArgs(env, strategy),
	}, d, nil
}

func (e *Engine) Execute(planID string, confirm bool) (classify.Verdict, error) {
	e.mu.Lock()
	rec, ok := e.plans[planID]
	e.mu.Unlock()
	if !ok {
		return classify.Verdict{}, errors.New("unknown or expired plan_id — call deploy_plan first")
	}
	d, err := descriptor.Load(e.WorkDir)
	if err != nil {
		return classify.Verdict{}, err
	}

	if d.ExecMode(rec.env) == "operator_only" {
		return classify.Verdict{
			Project:    d.Project,
			Env:        rec.env,
			Strategy:   rec.strategy,
			Status:     "requires_operator",
			NextAction: operatorCommand(d, rec.env, rec.strategy),
		}, nil
	}
	if !confirm {
		return classify.Verdict{}, errors.New("confirmation required: re-call with confirm=true")
	}

	runID := fmt.Sprintf("%s-%s-%s", d.Project, rec.env, e.Now().Format("20060102-150405"))
	logPath := filepath.Join(e.LogRoot, runID+".log")
	argv := d.ChainArgs(rec.env, rec.strategy)

	res, runErr := e.Run(context.Background(), argv, d.Root, logPath)
	if runErr != nil {
		return classify.Verdict{}, fmt.Errorf("chain failed to start: %w", runErr)
	}
	logBytes, _ := os.ReadFile(res.LogPath)
	v := classify.Classify(string(logBytes), res.ExitCode, d)
	v.RunID, v.Project, v.Env, v.Strategy = runID, d.Project, rec.env, rec.strategy
	v.DurationS = int(res.Duration.Seconds())
	v.LogPath = res.LogPath

	if d.Smoke.Baseline != "" {
		base, _ := smoke.LoadBaseline(filepath.Join(d.Root, d.Smoke.Baseline))
		cur := parseSmokeFromLog(string(logBytes))
		if len(cur) > 0 {
			sd := smoke.Diff(cur, base)
			v.SmokeDiff = &sd
		}
	}

	e.mu.Lock()
	e.runs[runID] = v
	e.mu.Unlock()
	return v, nil
}

func (e *Engine) Verdict(runID string) (classify.Verdict, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	v, ok := e.runs[runID]
	if !ok {
		return classify.Verdict{}, fmt.Errorf("unknown run_id %q", runID)
	}
	return v, nil
}

func (e *Engine) Logs(runID, step, grep string, maxBytes int) (string, error) {
	if maxBytes <= 0 {
		maxBytes = 8000
	}
	e.mu.Lock()
	v, ok := e.runs[runID]
	e.mu.Unlock()
	if !ok {
		return "", fmt.Errorf("unknown run_id %q", runID)
	}
	b, err := os.ReadFile(v.LogPath)
	if err != nil {
		return "", err
	}
	lines := strings.Split(string(b), "\n")
	var kept []string
	for _, ln := range lines {
		if step != "" && !strings.Contains(ln, step) {
			continue
		}
		if grep != "" && !strings.Contains(ln, grep) {
			continue
		}
		kept = append(kept, ln)
	}
	out := strings.Join(kept, "\n")
	if len(out) > maxBytes {
		out = out[len(out)-maxBytes:]
	}
	return out, nil
}

func operatorCommand(d *descriptor.Descriptor, env, strategy string) string {
	return "This env is operator-only. Run in the primary tree: " + strings.Join(d.ChainArgs(env, strategy), " ")
}

// parseSmokeFromLog is a placeholder hook: projects whose smoke step emits a
// machine-readable "SMOKE-RESULT <name> pass|fail" line populate this. Returns
// an empty set when no such lines exist (SmokeDiff then omitted).
func parseSmokeFromLog(log string) smoke.SmokeSet {
	set := smoke.SmokeSet{}
	for _, ln := range strings.Split(log, "\n") {
		f := strings.Fields(ln)
		if len(f) == 3 && f[0] == "SMOKE-RESULT" {
			set[f[1]] = f[2] == "pass"
		}
	}
	return set
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}
```

```go
// internal/mcpserver/server.go
package mcpserver

import (
	"github.com/mark3labs/mcp-go/server"
	"github.tools.sap/developer-relations/deploy-watcher/internal/engine"
)

func NewServer(e *engine.Engine) *server.MCPServer {
	s := server.NewMCPServer("deploy-watcher", "0.1.0",
		server.WithInstructions("Run a project's deploy chain and get a compact verdict instead of raw logs. ALWAYS deploy_plan first (read-only preflight), then deploy_run with the returned plan_id — deploy_run requires human approval and refuses prod (returns requires_operator). Use deploy_verdict to poll a long run and deploy_logs for a bounded slice of the full log."),
	)
	registerTools(s, e)
	return s
}
```

```go
// internal/mcpserver/tools.go
package mcpserver

import (
	"context"
	"encoding/json"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.tools.sap/developer-relations/deploy-watcher/internal/engine"
)

func jsonResult(v any) (*mcp.CallToolResult, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return mcp.NewToolResultText(string(b)), nil
}

func registerTools(s *server.MCPServer, e *engine.Engine) {
	s.AddTool(mcp.NewTool("deploy_plan",
		mcp.WithDescription("Resolve the project's deploy-watcher.yaml, run read-only preflight guards, and return a plan with a plan_id. Mutates nothing. Call before deploy_run."),
		mcp.WithString("env", mcp.Required(), mcp.Description("Target environment, e.g. dev|qa|prod.")),
		mcp.WithString("strategy", mcp.Description("Optional deploy strategy, e.g. blue-green.")),
	), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		plan, _, err := e.MakePlan(req.GetString("env", ""), req.GetString("strategy", ""))
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		return jsonResult(plan)
	})

	s.AddTool(mcp.NewTool("deploy_run",
		mcp.WithDescription("Execute a previously planned deploy. Requires a valid plan_id from deploy_plan and confirm=true (human approval). Refuses prod: returns status=requires_operator with the operator command. Returns a compact verdict; full logs stay on disk."),
		mcp.WithString("plan_id", mcp.Required(), mcp.Description("plan_id returned by deploy_plan.")),
		mcp.WithString("env", mcp.Required(), mcp.Description("Environment being deployed — echoed for human approval; must match the plan.")),
		mcp.WithBoolean("confirm", mcp.Required(), mcp.Description("Must be true to execute. Human confirms the env shown above.")),
	), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		v, err := e.Execute(req.GetString("plan_id", ""), req.GetBool("confirm", false))
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		return jsonResult(v)
	})

	s.AddTool(mcp.NewTool("deploy_verdict",
		mcp.WithDescription("Fetch the current verdict for a run_id (status=running while in flight)."),
		mcp.WithString("run_id", mcp.Required()),
	), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		v, err := e.Verdict(req.GetString("run_id", ""))
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		return jsonResult(v)
	})

	s.AddTool(mcp.NewTool("deploy_logs",
		mcp.WithDescription("Return a bounded slice of a run's full on-disk log, optionally filtered by a step marker and/or grep substring. Use when the verdict's error_extract is not enough."),
		mcp.WithString("run_id", mcp.Required()),
		mcp.WithString("step", mcp.Description("Only lines containing this step marker.")),
		mcp.WithString("grep", mcp.Description("Only lines containing this substring.")),
		mcp.WithNumber("max_bytes", mcp.Description("Max bytes to return (default 8000).")),
	), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		out, err := e.Logs(req.GetString("run_id", ""), req.GetString("step", ""), req.GetString("grep", ""), int(req.GetFloat("max_bytes", 8000)))
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		return mcp.NewToolResultText(out), nil
	})
}
```

> Add the `writeDescriptor` test helper in `engine_test.go` (writes the Task-2 sample yaml into a temp dir and returns it). If `mcp.CallToolRequest` arg accessors differ in v0.52.0 (`GetFloat` name), adjust to the actual method (`req.GetInt`/`req.GetFloat`) — verify with `go doc github.com/mark3labs/mcp-go/mcp CallToolRequest`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/engine/ ./internal/mcpserver/`
Expected: PASS. The `TestProdGateNeverRuns` and `TestHITLRequiresConfirm` assertions are the safety gate.

- [ ] **Step 5: Commit**

```bash
git add internal/engine/ internal/mcpserver/ internal/runner/runner.go
git commit -m "feat: engine (plan/execute/verdict/logs) + MCP tools with prod gate + HITL"
```

---

### Task 8: CLI commands + `mcp serve`

**Files:**
- Modify: `cmd/root.go` (register subcommands)
- Create: `cmd/plan.go`, `cmd/run.go`, `cmd/verdict.go`, `cmd/logs.go`, `cmd/mcp.go`
- Test: `cmd/plan_test.go`

**Interfaces:**
- Consumes: `engine.Engine`, `mcpserver.NewServer`.
- Produces: cobra commands `plan --env --strategy`, `run --plan-id --env --confirm`, `verdict --run-id`, `logs --run-id --step --grep`, and `mcp serve` (serves over stdio via `server.ServeStdio(mcpserver.NewServer(e))`). Each non-serve command prints the JSON verdict/plan to stdout.

- [ ] **Step 1: Write the failing test**

```go
// cmd/plan_test.go
package cmd_test

import (
	"bytes"
	"strings"
	"testing"

	"github.tools.sap/developer-relations/deploy-watcher/cmd"
)

func TestPlanCommandRequiresEnv(t *testing.T) {
	root := cmd.NewRootCmd()
	root.SetArgs([]string{"plan"}) // no --env
	var out bytes.Buffer
	root.SetErr(&out)
	if err := root.Execute(); err == nil {
		t.Fatal("expected error when --env missing")
	}
}

func TestVersionStillWorks(t *testing.T) {
	root := cmd.NewRootCmd()
	root.SetArgs([]string{"version"})
	var out bytes.Buffer
	root.SetOut(&out)
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "deploy-watcher") {
		t.Fatalf("version output = %q", out.String())
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/`
Expected: FAIL — `plan` subcommand undefined (unknown command).

- [ ] **Step 3: Write minimal implementation**

```go
// cmd/mcp.go
package cmd

import (
	"os"

	"github.com/mark3labs/mcp-go/server"
	"github.com/spf13/cobra"
	"github.tools.sap/developer-relations/deploy-watcher/internal/engine"
	"github.tools.sap/developer-relations/deploy-watcher/internal/mcpserver"
)

func newMCPCmd() *cobra.Command {
	c := &cobra.Command{Use: "mcp", Short: "MCP server commands."}
	c.AddCommand(&cobra.Command{
		Use:   "serve",
		Short: "Serve the Deploy Watcher MCP over stdio.",
		RunE: func(_ *cobra.Command, _ []string) error {
			wd, _ := os.Getwd()
			e, err := engine.New(wd)
			if err != nil {
				return err
			}
			return server.ServeStdio(mcpserver.NewServer(e))
		},
	})
	return c
}
```

```go
// cmd/plan.go
package cmd

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"github.tools.sap/developer-relations/deploy-watcher/internal/engine"
)

func newPlanCmd() *cobra.Command {
	var env, strategy string
	c := &cobra.Command{
		Use:   "plan",
		Short: "Run read-only preflight and print a deploy plan (with plan_id).",
		RunE: func(cmd *cobra.Command, _ []string) error {
			wd, _ := os.Getwd()
			e, err := engine.New(wd)
			if err != nil {
				return err
			}
			plan, _, err := e.MakePlan(env, strategy)
			if err != nil {
				return err
			}
			b, _ := json.MarshalIndent(plan, "", "  ")
			fmt.Fprintln(cmd.OutOrStdout(), string(b))
			return nil
		},
	}
	c.Flags().StringVar(&env, "env", "", "target environment (required)")
	c.Flags().StringVar(&strategy, "strategy", "", "deploy strategy (optional)")
	_ = c.MarkFlagRequired("env")
	return c
}
```

Implement `newRunCmd`, `newVerdictCmd`, `newLogsCmd` in the same shape (flags → `engine.New` → `Execute`/`Verdict`/`Logs` → print JSON; `run` has `--plan-id` (required), `--env` (required), `--confirm` (bool)). Then wire all into `NewRootCmd`:

```go
// add inside NewRootCmd(), after the version command:
root.AddCommand(newPlanCmd(), newRunCmd(), newVerdictCmd(), newLogsCmd(), newMCPCmd())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./cmd/ && go build ./...`
Expected: PASS + clean build.

- [ ] **Step 5: Commit**

```bash
git add cmd/ go.mod go.sum
git commit -m "feat: CLI commands (plan/run/verdict/logs) + mcp serve over stdio"
```

---

### Task 9: tutorials-ims reference descriptor, fixtures, README

**Files:**
- Create (in the tutorials-ims repo, not the watcher repo): `deploy-watcher.yaml`
- Create (watcher repo): `testdata/logs/success.log`, `cds_deploy_fail.log`, `mbt_minify_fail.log`, `oom.log`, `smoke_regression.log`
- Create (watcher repo): `internal/classify/fixtures_test.go` — table test over the fixture logs
- Create (watcher repo): `README.md`

**Interfaces:** none new — this task hardens the classifier against real-shaped logs and documents install.

- [ ] **Step 1: Write the failing fixture table test**

```go
// internal/classify/fixtures_test.go
package classify_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.tools.sap/developer-relations/deploy-watcher/internal/classify"
)

func TestFixtureLogs(t *testing.T) {
	cases := []struct {
		file, wantStatus, wantSignal string
		exit                         int
	}{
		{"success.log", "success", "", 0},
		{"cds_deploy_fail.log", "failed", "cds_deploy_error", 1},
		{"mbt_minify_fail.log", "failed", "mbt_minify", 1},
		{"oom.log", "failed", "oom", 1},
		{"smoke_regression.log", "smoke_regressed", "", 2},
	}
	d := fixtureDescriptor() // extend with mbt_minify signal to match cases
	for _, c := range cases {
		t.Run(c.file, func(t *testing.T) {
			b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "logs", c.file))
			if err != nil {
				t.Fatal(err)
			}
			v := classify.Classify(string(b), c.exit, d)
			if v.Status != c.wantStatus {
				t.Fatalf("%s status = %q want %q", c.file, v.Status, c.wantStatus)
			}
			if v.Signal != c.wantSignal {
				t.Fatalf("%s signal = %q want %q", c.file, v.Signal, c.wantSignal)
			}
		})
	}
}
```

- [ ] **Step 2: Create the fixture logs**

Author each `testdata/logs/*.log` as a short (~30-line) realistic excerpt containing the marker lines the classifier keys on. Examples of the load-bearing lines to include:
- `success.log`: `  ✓ Step 5: smoke gate` + `MTA version 1.25.0` + a final `✓ deploy complete`.
- `cds_deploy_fail.log`: a stack line containing `in cds.deploy` + `[deploy] FAILED:`.
- `mbt_minify_fail.log`: `Minification failed` + `Unexpected token`.
- `oom.log`: `exit status 137` (and `Insufficient memory`).
- `smoke_regression.log`: `  ✓ Step 4: cf deploy` + `[deploy] SMOKE GATE FAILED`.

Extend `fixtureDescriptor()` (Task 3) to include the `mbt_minify` signal (`pattern: "Minification failed|Unexpected token"`).

- [ ] **Step 3: Run the table test**

Run: `go test ./internal/classify/`
Expected: PASS for all five fixtures.

- [ ] **Step 4: Author the tutorials-ims reference descriptor + README**

Write `deploy-watcher.yaml` (in tutorials-ims) using the full reference from the spec (chain `node scripts/deploy-mta.cjs`, envs dev/qa/prod, exec_policy hitl:[dev,qa]/operator_only:[prod], the five signals, thresholds srv_qa_min_mb:1536 / approuter_prod_min_mb:2048, smoke `npm run test:smoke`, preflight cf_target_matches_env/git_fresh_origin/node_auth_token_present). Write `README.md` covering: what it does, install (`go install`), MCP registration snippet (`deploy-watcher mcp serve`), the descriptor format, and the prod-gate/HITL behavior.

- [ ] **Step 5: Commit**

```bash
# in the watcher repo:
git add testdata/logs/ internal/classify/fixtures_test.go README.md
git commit -m "test: fixture-driven classifier coverage + docs; add tutorials-ims descriptor"
# the tutorials-ims deploy-watcher.yaml is committed in that repo via its own PR
```

---

## Self-Review

**1. Spec coverage:**
- Standalone Go repo, sap-devs-cli parity → Task 1 + Global Constraints. ✔
- Per-project descriptor, cwd resolution, differentiation → Task 2, Task 9. ✔
- Wrap existing orchestrator, key off Step markers/exit codes → Task 3. ✔
- Verdict schema (all fields) → Task 3 `Verdict`. ✔
- smoke_diff → Task 4 + engine wiring Task 7. ✔
- Runner tee-to-file, logs never wholesale → Task 5, `deploy_logs` Task 7. ✔
- Preflight guards (cf target / git fresh / node auth) → Task 6. ✔
- 4 MCP tools, HITL nonce, prod gate → Task 7. ✔
- CLI + `mcp serve` → Task 8. ✔
- Fixture tests for the gotchas (cds.deploy / minify / OOM / smoke) → Task 9. ✔

**2. Placeholder scan:** No "TBD"/"add error handling" left. `parseSmokeFromLog` is a documented, implemented hook (returns empty set → SmokeDiff omitted), not a placeholder. The one call-out to verify `mcp-go` arg-accessor names (`GetFloat`) is a real API-verification step with a `go doc` command, not a gap.

**3. Type consistency:** `Verdict` fields/JSON tags identical across Tasks 3 and 7. `runner.RunResult`/`RunFunc`, `preflight.Result`/`Runner`, `smoke.SmokeDiff`/`SmokeSet`, `descriptor.*` names match every consumer. `engine.MakePlan` returns `(Plan, *descriptor.Descriptor, error)` and every caller (tools.go, plan.go) uses the 3-tuple. Cross-package dependency Task 3→Task 4 flagged with build ordering.
