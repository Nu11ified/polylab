# PRD: PolyLab — AI-Native Research, Math, ML, and Robotics Workspace

## 1. Product Name

Official name: **PolyLab**

Tagline:

> Verified AI-native research and experimentation workspace.

## 2. Product Vision

PolyLab is a macOS-first Electron desktop platform for mathematical experimentation, machine learning research, robotics workflows, paper writing, benchmarking, and agentic software development.

The platform unifies:

* AI-assisted formula creation
* symbolic and numerical verification
* code generation and diff review
* markdown and LaTeX authoring
* local and cloud execution
* Git-native workflows
* reproducible experiments
* federated local/cloud workspaces
* GPU execution orchestration
* agent-driven research pipelines

PolyLab is intended to become:

```text
Jupyter + Cursor + Overleaf + Wolfram + Agentic IDE + Research Runtime
```

inside one local-first system.

## 3. Core Product Thesis

PolyLab is built around one core idea:

> AI agents should not only generate code — they should help users create, verify, benchmark, document, execute, and publish mathematical and computational ideas.

The platform should support this end-to-end workflow:

```text
Idea
↓
Formula
↓
Verification
↓
Generated Implementation
↓
Diff Review
↓
Execution
↓
Benchmarking
↓
Paper Generation
↓
Git Versioning
↓
Local/Cloud Federation
```

## 4. Primary User Types

### Primary Users

* ML engineers
* robotics engineers
* AI researchers
* indie researchers
* technical students
* scientific computing users
* quant researchers
* open-source developers
* agentic coding users

### Secondary Users

* educators
* simulation engineers
* data scientists
* hardware researchers
* systems programmers

## 5. Core Differentiator

PolyLab differentiates itself through:

```text
Agent proposes
↓
Verification engine validates
↓
User reviews diff
↓
Execution runs locally or remotely
↓
Results update papers and artifacts automatically
```

The platform is not merely an IDE or notebook.

It is:

> A verified AI-native research operating system.

---

# 6. Platform Architecture

## 6.1 Desktop Shell

### Technology

* Electron
* React
* TypeScript
* Tailwind
* Monaco Editor
* shadcn/ui

### Initial Platform Support

* macOS first
* Apple Silicon optimized
* Intel macOS supported where practical
* Windows/Linux later

### Responsibilities

* native windowing
* keyboard shortcuts
* workspace management
* local process supervision
* secure credential access
* external editor launching
* local server lifecycle management
* remote workspace connections

### Native Keyboard Workflow

The UX should feel keyboard-native and optimized for agentic workflows.

Example shortcuts:

```text
Cmd+K           → Ask agent about selection
Cmd+Shift+K     → Run complex agent task
Cmd+Enter       → Apply patch
Cmd+Shift+Enter → Verify formula
Cmd+Option+R    → Run experiment
Cmd+Option+G    → Generate implementation
Cmd+Option+D    → Open diff viewer
Cmd+Option+M    → Open math viewer
Cmd+Option+L    → Open LaTeX preview
```

---

# 7. Local Backend Server

## Technology

* Bun
* Elysia
* SQLite/libSQL
* Drizzle ORM
* WebSockets/SSE

## Architecture

PolyLab runs a local Elysia server by default.

The Electron frontend communicates with the local backend through internal APIs.

The backend is responsible for:

* project management
* formula registry
* symbolic verification
* numerical verification
* execution routing
* Git integration
* sync/federation
* artifact tracking
* agent orchestration
* cloud provider integrations
* local process management
* reverse proxy management

### Core Structure

```text
apps/desktop/
apps/server/

packages/agent-core/
packages/pi-mono/
packages/formula-engine/
packages/execution-router/
packages/project-indexer/
packages/git-engine/
packages/sync-engine/
packages/ui/
packages/types/
```

---

# 8. Pi Mono Integration

## Critical Product Decision

Pi mono is NOT an alternative AI provider.

Pi mono is the:

> primary PolyLab agent harness and orchestration layer.

Pi mono manages:

* Codex subscription integration
* tool execution
* patch generation
* session management
* execution plans
* verification loops
* multi-agent orchestration
* deterministic execution pipelines

Codex is consumed THROUGH Pi mono.

### Pi Mono Responsibilities

* connect to Codex subscription
* manage agent sessions
* stream patches
* generate diffs
* orchestrate tools
* retry failed verification
* route execution tasks
* manage workspace context
* manage memory/indexing
* provide deterministic workflows

### PolyLab Agent Stack

```text
PolyLab UI
    ↓
Pi mono orchestration layer
    ↓
Codex subscription/runtime
    ↓
Tool execution + patch generation
```

### Pi Mono Features

* structured patch protocol
* deterministic execution plans
* local tool execution
* remote execution delegation
* verification retries
* multi-step workflows
* session persistence
* replayable execution traces
* tool permission enforcement
* local-first execution

---

# 9. Project Workspace System

Each PolyLab project is a local-first workspace.

## Example Structure

```text
.polylab/
  project.json
  settings.json
  sessions/
  verification/
  execution/
  sync/

formulas/
notebooks/
experiments/
papers/
references/
src/
benchmarks/
figures/
artifacts/
```

## Project Metadata Example

```json
{
  "name": "attention-research",
  "defaultLanguage": "python",
  "mathEngine": "sympy",
  "gpuProvider": "modal",
  "editor": {
    "type": "vscode",
    "command": "code -r {workspace}"
  },
  "agent": {
    "runtime": "pi-mono",
    "provider": "codex"
  }
}
```

---

# 10. Main User Interface

## Main Layout

```text
┌──────────────────────────────────────────────────────────────┐
│ Project | Branch | Runtime | Agent | Execution Target       │
├──────────────┬──────────────────────────┬────────────────────┤
│ File Tree    │ Main Workspace            │ Agent Panel        │
│ Formulas     │                           │                    │
│ Symbols      │ Code / Markdown / Math    │ Plan / Chat        │
│ Experiments  │ LaTeX / Notebook / Diff   │ Tools / Tasks      │
├──────────────┴──────────────────────────┴────────────────────┤
│ Terminal | Verification | Git | Logs | Execution             │
└──────────────────────────────────────────────────────────────┘
```

## Required UI Views

### Core Views

* Code editor
* Diff viewer
* Markdown viewer
* Math viewer
* Formula builder
* Verification dashboard
* Notebook view
* Execution logs
* Git panel
* Artifact viewer
* Agent session panel

### Advanced Views

* LaTeX editor + PDF preview
* Benchmark dashboard
* Simulation visualization
* Experiment graph view
* Remote sync panel
* Cloud execution panel

---

# 11. Code Editor + Diff Viewer

## Built-in Editor

PolyLab ships with a lightweight but capable editor.

### Requirements

* Monaco-based editing
* syntax highlighting
* inline diagnostics
* symbol navigation
* AI patch visualization
* inline diff rendering
* multi-tab support
* file indexing

## External Editor Support

PolyLab must deeply support external editors.

### Presets

```json
[
  { "name": "VS Code", "command": "code -r {workspace}" },
  { "name": "Cursor", "command": "cursor -r {workspace}" },
  { "name": "Neovim", "command": "nvim {file}" },
  { "name": "Emacs", "command": "emacsclient -n {file}" },
  { "name": "Custom", "command": "<custom-command>" }
]
```

### Variables

```text
{workspace}
{file}
{line}
{column}
```

## Diff Viewer

The diff viewer is a core workflow surface.

### Features

* side-by-side diff
* inline diff
* hunk acceptance/rejection
* patch explanations
* verification status per patch
* Git staging integration
* patch replay history
* verification rerun button

### Workflow

```text
Agent generates patch
↓
User reviews diff
↓
User accepts/rejects hunks
↓
Verification runs
↓
Agent revises if necessary
↓
User commits final result
```

---

# 12. Markdown, Math, and LaTeX System

## Markdown Viewer

### Features

* live preview
* Mermaid diagrams
* math rendering
* executable code blocks
* artifact linking
* formula references
* inline agent comments

## Math Viewer

The math viewer is one of the core PolyLab features.

### Capabilities

* render equations
* symbolic simplification
* Jacobian display
* derivative display
* dimensional analysis
* matrix visualization
* tensor shape display
* generated implementation links
* numerical validation results
* stability warnings

### Formula Cards

Each formula contains:

```text
Equation
Variables
Assumptions
Input shapes
Output shapes
Constraints
Reference implementation
Generated implementations
Verification history
Experiment links
Paper references
```

## LaTeX Viewer

### Features

* side-by-side source + preview
* PDF rendering
* equation references
* bibliography support
* build logs
* agent-assisted paper editing
* formula linking
* benchmark embedding

---

# 13. Formula Verification Engine

## Core Goal

Ensure generated implementations are mathematically and numerically correct.

## Verification Types

1. symbolic verification
2. numerical verification
3. shape verification
4. dimensional verification
5. gradient verification
6. runtime parity checks
7. stability analysis
8. cross-language parity
9. benchmark validation

## Symbolic Engine

Initial engine:

* SymPy

Future possibilities:

* Julia symbolic stack
* Wolfram integration
* theorem engines

## Numerical Verification Workflow

```text
Reference formula
↓
Generated implementation
↓
Shared test inputs
↓
Tolerance comparison
↓
Verification report
```

## Stability Checks

PolyLab should detect:

* divide-by-zero
* NaN
* Inf
* unstable recurrence
* singular matrices
* exploding gradients
* overflow
* underflow
* tensor shape mismatch

## Gradient Verification

Use finite-difference comparisons against analytical gradients.

---

# 14. Notebook Experience

PolyLab should support notebook-native workflows without depending entirely on notebooks.

## Features

* markdown cells
* code cells
* math cells
* plot cells
* execution cells
* remote execution
* agent-generated cells
* linked formulas
* notebook-to-script conversion
* artifact persistence

---

# 15. Execution Router

## Purpose

Automatically determine where workloads should run.

## Execution Targets

* local machine
* Docker sandbox
* remote VPS
* Modal
* RunPod
* Google notebook providers
* future providers

## Routing Inputs

* GPU requirements
* runtime duration
* memory requirements
* security constraints
* user preference
* reproducibility needs
* estimated cost
* provider availability

## Example Decisions

```text
Small NumPy verification → local
GPU training → Modal/RunPod
Long-running experiment → VPS
Educational notebook → Google notebook runtime
```

---

# 16. Local Execution

## Requirements

* Python execution
* notebook execution
* lightweight local inference
* optional Docker sandboxing
* dependency detection
* execution logs
* agent-approved dependency installation

---

# 17. Cloud Execution

## Modal Integration

### Use Cases

* GPU training
* notebook execution
* benchmark jobs
* serverless execution
* sandboxed runs

### Requirements

* authentication flow
* artifact upload/download
* log streaming
* cost display where possible
* execution history

## RunPod Integration

### Use Cases

* persistent GPU nodes
* long-running jobs
* SSH workflows
* custom containers

### Requirements

* pod provisioning
* pod lifecycle management
* sync local projects
* execution logs
* artifact persistence

## Google Notebook Integration

### Use Cases

* educational workflows
* notebook export
* quick experimentation

---

# 18. Git Integration

## Required Features

* init repo
* clone repo
* branches
* staging
* commits
* pull/push
* diff rendering
* conflict resolution
* agent-assisted commits
* verification-linked commits

## Agent Restrictions

Destructive actions require approval:

* force push
* hard reset
* branch deletion
* history rewrite

---

# 19. Local/Cloud Federation

## Core Principle

PolyLab is local-first but federation-native.

## Supported Modes

1. fully local
2. local desktop + remote server
3. remote standalone workspace
4. local/remote bidirectional sync
5. future multi-node federation

## Supported Operations

```text
Clone project
Push project
Pull updates
Transfer artifacts
Stream changes
Sync sessions
Replay sessions
```

## Example Use Cases

* local UI with remote GPU server
* home server orchestration
* VPS persistent agents
* remote benchmarks
* local paper writing with remote execution

---

# 20. Standalone Server Mode

PolyLab servers should run independently from the desktop application.

## Server Features

* standalone Elysia server
* remote workspace hosting
* cloud execution workers
* sync services
* Caddy integration
* remote API access
* authentication
* artifact storage

## Deployment Targets

* VPS
* home server
* Docker Compose
* future Kubernetes support

---

# 21. Caddy Reverse Proxy Integration

## Purpose

PolyLab should optionally manage HTTPS and reverse proxy configuration.

## Features

* generate Caddy configs
* reload Caddy
* expose local services
* attach HTTPS
* route workspaces
* route notebook previews

### Example Routes

```text
studio.example.com
project.example.com
api.example.com
```

---

# 22. Cloudflare DNS Integration

## Workflow

```text
Connect Cloudflare
↓
Select zone
↓
Preview DNS changes
↓
Approve
↓
Apply DNS automatically
↓
Caddy reloads
↓
HTTPS becomes active
```

## Requirements

* scoped permissions
* secure token storage
* rollback support
* preview before mutation
* local Keychain integration

---

# 23. Security Model

## Principles

1. local-first ownership
2. explicit permissioning
3. sandbox execution where possible
4. encrypted sync transport
5. protected provider credentials
6. review-before-mutation workflows

## Agent Permission Categories

```text
Read files
Write files
Run local code
Run cloud code
Modify Git state
Modify DNS
Transfer artifacts
Install dependencies
```

### Permission Modes

```text
Deny
Allow once
Allow session
Allow project
```

---

# 24. API Surface

## Project APIs

```http
GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
```

## Formula APIs

```http
POST   /api/formulas/:id/verify
POST   /api/formulas/:id/generate
```

## Agent APIs

```http
POST   /api/agents/session
POST   /api/agents/message
GET    /api/agents/events
```

## Execution APIs

```http
POST   /api/execution/run
GET    /api/execution/logs
```

## Sync APIs

```http
POST   /api/sync/push
POST   /api/sync/pull
```

---

# 25. Core User Workflows

## Workflow A — Formula to Verified Code

```text
User writes formula
↓
Pi mono explains assumptions
↓
Verification engine generates

```
