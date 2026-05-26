export type RuntimeTarget = "local" | "docker" | "modal" | "runpod" | "vps" | "google-notebook";

export type VerificationStatus = "queued" | "running" | "passed" | "failed" | "warning";

export interface ProjectSummary {
  id: string;
  name: string;
  workspaceRoot?: string;
  branch: string;
  runtime: RuntimeTarget;
  agentRuntime: "pi-mono";
  updatedAt: string;
}

export interface FormulaCard {
  id: string;
  title: string;
  equation: string;
  variables: string[];
  assumptions: string[];
  inputShapes: string[];
  outputShapes: string[];
  constraints: string[];
  referenceImplementation?: string;
  generatedImplementations: string[];
  verificationHistory: VerificationReport[];
  status: VerificationStatus;
  lastCheckedAt?: string;
}

export interface VerificationCheck {
  name:
    | "symbolic"
    | "sympy"
    | "wolfram"
    | "property-based"
    | "metamorphic"
    | "robustness-sweep"
    | "autodiff"
    | "robotics-kinematics"
    | "robotics-dynamics"
    | "reproducibility"
    | "model-evaluation"
    | "distributed-training"
    | "interval-bounds"
    | "smt"
    | "runtime-provider-parity"
    | "numerical"
    | "shape"
    | "dimensional"
    | "gradient"
    | "stability"
    | "runtime-parity"
    | "cross-language-parity"
    | "benchmark-validation";
  status: VerificationStatus;
  detail: string;
  artifactPaths?: string[];
}

export interface VerificationReport {
  id: string;
  formulaId: string;
  status: VerificationStatus;
  checks: VerificationCheck[];
  createdAt: string;
}

export interface WorkspaceSnapshot {
  projects: ProjectSummary[];
  formulas: FormulaCard[];
  tasks: AgentTask[];
  logs: ExecutionLog[];
  executions: ExecutionRun[];
  dependencyPlans: DependencyPlan[];
  cloudProviders: CloudProviderConfig[];
  cloudJobs: CloudExecutionJob[];
  cloudLogs: CloudJobLog[];
  deploymentPlans: DeploymentPlan[];
  deploymentMutations: DeploymentMutation[];
  persistence: PersistenceStatus;
  artifacts: ArtifactRecord[];
  benchmarks: BenchmarkRun[];
  experiments: ExperimentRun[];
  patches: PatchReview[];
  agentRuntime: AgentRuntimeConfig;
  agentHandoffs: AgentHandoff[];
  agentSessions: AgentSession[];
  documents: ResearchDocument[];
  syncRuns: SyncRun[];
  permissions: PermissionDecision[];
  permissionChecks: PermissionCheck[];
  activityEvents: ActivityEvent[];
}

export interface AuthStatus {
  enabled: boolean;
  mode: "local-open" | "token";
  header: "authorization" | "x-polylab-token";
  tokenConfigured: boolean;
}

export interface ClientPerformanceStatus {
  bootMs?: number;
  heapUsedMb?: number;
  heapLimitMb?: number;
  cacheSupported: boolean;
  serviceWorkerSupported: boolean;
  serviceWorkerState: "unsupported" | "unregistered" | "installing" | "waiting" | "active" | "redundant" | "error";
  cacheName: string;
  cachedAssetCount?: number;
  collectedAt: string;
}

export interface ActivityEvent {
  id: string;
  type: "agent" | "execution" | "git" | "sync" | "artifact" | "permission" | "editor" | "deployment" | "formula" | "document" | "system";
  level: "info" | "warn" | "error";
  title: string;
  detail: string;
  resource?: string;
  createdAt: string;
}

export interface WorkspaceFile {
  path: string;
  name: string;
  kind: "file" | "directory";
  size: number;
  updatedAt: string;
  language?: "python" | "typescript" | "markdown" | "latex" | "json" | "text";
}

export interface WorkspaceFileContent {
  path: string;
  language: WorkspaceFile["language"];
  content: string;
  size: number;
  updatedAt: string;
}

export interface WorkspaceSymbol {
  id: string;
  path: string;
  name: string;
  kind: "function" | "class" | "constant" | "heading" | "equation" | "cell";
  line: number;
  column: number;
  detail: string;
}

export interface WorkspaceDiagnostic {
  id: string;
  path: string;
  severity: "info" | "warning" | "error";
  line: number;
  column: number;
  message: string;
}

export interface ExternalEditorPreset {
  id: "vscode" | "cursor" | "neovim" | "emacs" | "custom" | string;
  name: string;
  command: string;
  variables: Array<"{workspace}" | "{file}" | "{line}" | "{column}">;
  updatedAt: string;
}

export interface ExternalEditorLaunch {
  preset: ExternalEditorPreset;
  command: string;
  args: string[];
  workspace: string;
  file?: string;
  line: number;
  column: number;
  ok: boolean;
  message: string;
}

export interface AgentTask {
  id: string;
  title: string;
  state: "planned" | "running" | "blocked" | "done";
  shortcut?: string;
}

export interface AgentPlanStep {
  id: string;
  title: string;
  state: "pending" | "running" | "done" | "failed";
  detail: string;
}

export type AgentTraceType = "plan" | "tool" | "patch" | "verification" | "message" | "retry" | "artifact";

export interface AgentTraceEvent {
  id: string;
  type: AgentTraceType;
  message: string;
  createdAt: string;
}

export interface AgentSession {
  id: string;
  runtime: "pi-mono";
  provider: "codex";
  title: string;
  state: "planned" | "running" | "blocked" | "done" | "failed";
  formulaId?: string;
  plan: AgentPlanStep[];
  trace: AgentTraceEvent[];
  attempts: number;
  maxAttempts: number;
  artifactPaths: string[];
  replayPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentReplay {
  session: AgentSession;
  createdAt: string;
  events: AgentTraceEvent[];
  plan: AgentPlanStep[];
  artifacts: string[];
}

export interface AgentRuntimeConfig {
  runtime: "pi-mono";
  provider: "codex";
  state: "not-configured" | "configured" | "connected" | "unavailable";
  codexCommand?: string;
  credentialHint: string;
  workspaceIndexPath: string;
  updatedAt: string;
}

export interface AgentHandoff {
  id: string;
  sessionId: string;
  provider: "codex";
  state: "created" | "skipped" | "dispatched" | "completed" | "failed";
  requestPath: string;
  resultPath?: string;
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionLog {
  id: string;
  target: RuntimeTarget;
  message: string;
  level: "info" | "warn" | "error";
  createdAt: string;
}

export interface ExecutionRequest {
  command: string;
  target?: RuntimeTarget | "auto";
  gpuRequired?: boolean;
  notebook?: boolean;
  estimatedSeconds?: number;
  memoryMb?: number;
  allowNetwork?: boolean;
  sandbox?: "none" | "docker";
  dockerImage?: string;
}

export interface ExecutionRoute {
  target: RuntimeTarget;
  reason: string;
}

export interface ExecutionRun {
  id: string;
  command: string;
  route: ExecutionRoute;
  state: "queued" | "running" | "succeeded" | "failed" | "skipped";
  exitCode?: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt?: string;
  cloudJobId?: string;
  sandbox?: "none" | "docker";
  artifactPaths?: string[];
}

export interface DependencyItem {
  name: string;
  manager: "python" | "bun";
  source: string;
  requestedVersion?: string;
  installed?: boolean;
}

export interface DependencyPlan {
  id: string;
  state: "planned" | "approved" | "installed" | "skipped" | "failed";
  summary: string;
  items: DependencyItem[];
  installCommand: string;
  artifactPaths: string[];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CloudProviderConfig {
  id: RuntimeTarget;
  name: string;
  state: "not-configured" | "configured" | "connected" | "unavailable";
  authMethod: "env" | "token" | "ssh" | "none";
  credentialHint?: string;
  defaultRegion?: string;
  costHint?: string;
  updatedAt: string;
}

export interface CloudExecutionJob {
  id: string;
  provider: RuntimeTarget;
  command: string;
  state: "queued" | "ready-for-dispatch" | "running" | "succeeded" | "failed" | "cancelled";
  reason: string;
  artifactPaths: string[];
  costEstimate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudJobLog {
  id: string;
  jobId: string;
  provider: RuntimeTarget;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: string;
}

export interface CloudDispatchResult {
  job: CloudExecutionJob;
  logs: CloudJobLog[];
}

export interface BenchmarkRequest {
  name: string;
  command: string;
  iterations?: number;
  target?: RuntimeTarget | "auto";
  memoryMb?: number;
  gpuRequired?: boolean;
}

export interface BenchmarkRun {
  id: string;
  name: string;
  command: string;
  iterations: number;
  route: ExecutionRoute;
  state: "succeeded" | "failed";
  durationsMs: number[];
  meanMs: number;
  minMs: number;
  maxMs: number;
  artifactPaths: string[];
  createdAt: string;
}

export interface ExperimentNode {
  id: string;
  label: string;
  kind: "idea" | "formula" | "execution" | "artifact" | "benchmark" | "document";
  status: VerificationStatus | "succeeded" | "failed" | "queued";
}

export interface ExperimentEdge {
  from: string;
  to: string;
  label: string;
}

export interface ExperimentSample {
  step: number;
  value: number;
  label: string;
}

export interface ExperimentRun {
  id: string;
  name: string;
  command: string;
  state: "queued" | "running" | "succeeded" | "failed";
  executionRunId?: string;
  nodes: ExperimentNode[];
  edges: ExperimentEdge[];
  samples: ExperimentSample[];
  artifactPaths: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRecord {
  id: string;
  sourceId: string;
  sourceType: "execution" | "benchmark" | "experiment" | "dependency" | "document" | "formula" | "cloud" | "deployment" | "agent";
  path: string;
  mediaType: string;
  size: number;
  createdAt: string;
}

export interface ArtifactContent {
  artifact: ArtifactRecord;
  content: string;
  encoding: "utf8";
  previewable: boolean;
}

export interface DeploymentRoute {
  host: string;
  upstream: string;
  tls: "auto" | "internal" | "off";
}

export interface DnsPreviewChange {
  action: "create" | "update";
  type: "A" | "CNAME";
  name: string;
  content: string;
  proxied: boolean;
}

export interface DeploymentPlan {
  id: string;
  name: string;
  routes: DeploymentRoute[];
  caddyfile: string;
  dockerCompose?: string;
  envExample?: string;
  dnsPreview: DnsPreviewChange[];
  state: "draft" | "ready" | "applied" | "rolled-back";
  artifactPaths: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentMutation {
  id: string;
  planId: string;
  kind: "caddy-write" | "caddy-reload" | "cloudflare-dns" | "rollback";
  state: "planned" | "applied" | "skipped" | "failed";
  target: string;
  detail: string;
  artifactPaths: string[];
  createdAt: string;
}

export interface DeploymentApplyResult {
  plan: DeploymentPlan;
  mutations: DeploymentMutation[];
}

export interface PersistenceStatus {
  engine: "sqlite";
  orm: "drizzle";
  path: string;
  entityCount: number;
  eventCount: number;
  lastEventAt?: string;
}

export interface PersistenceEvent {
  id: number;
  entityType: string;
  entityId: string;
  operation: "upsert" | "delete";
  createdAt: string;
}

export type PermissionCategory =
  | "read-files"
  | "write-files"
  | "run-local-code"
  | "run-cloud-code"
  | "modify-git-state"
  | "modify-dns"
  | "transfer-artifacts"
  | "install-dependencies";

export type PermissionMode = "deny" | "allow-once" | "allow-session" | "allow-project";

export interface PermissionDecision {
  id: string;
  category: PermissionCategory;
  mode: PermissionMode;
  scope: "project" | "session";
  reason: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface PermissionCheck {
  id: string;
  category: PermissionCategory;
  action: string;
  resource: string;
  allowed: boolean;
  mode: PermissionMode;
  reason: string;
  createdAt: string;
}

export interface GitFileStatus {
  path: string;
  index: string;
  worktree: string;
  conflicted?: boolean;
}

export interface GitStatus {
  initialized: boolean;
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  conflicts: GitConflict[];
  summary: string;
}

export interface GitConflict {
  path: string;
  ours: string;
  theirs: string;
  base: string;
  markerCount: number;
}

export interface GitRemote {
  name: string;
  url: string;
}

export interface GitOperationResult {
  ok: boolean;
  message: string;
  status?: GitStatus;
  remotes?: GitRemote[];
  branches?: string[];
  path?: string;
}

export interface GitCommitResult {
  ok: boolean;
  hash?: string;
  branch: string;
  message: string;
  filesCommitted: number;
  status: GitStatus;
  verificationSummary?: GitVerificationSummary;
}

export interface GitVerificationSummary {
  status: VerificationStatus;
  formulaCount: number;
  passed: number;
  warning: number;
  failed: number;
  queued: number;
  linkedFormulaIds: string[];
  createdAt: string;
}

export interface PatchHunk {
  id: string;
  filePath: string;
  summary: string;
  before: string;
  after: string;
  status: "pending" | "accepted" | "rejected";
}

export interface PatchReview {
  id: string;
  formulaId?: string;
  title: string;
  explanation: string;
  status: "pending" | "partially-applied" | "accepted" | "rejected";
  hunks: PatchHunk[];
  createdAt: string;
  updatedAt: string;
}

export interface ResearchDocument {
  id: string;
  kind: "markdown" | "latex" | "notebook";
  title: string;
  path: string;
  source: string;
  cells: NotebookCell[];
  previewHtml: string;
  buildLog: string[];
  linkedFormulaIds: string[];
  citationKeys: string[];
  bibliography: BibliographyEntry[];
  pdfArtifactPath?: string;
  updatedAt: string;
}

export interface BibliographyEntry {
  key: string;
  title: string;
  authors: string[];
  year?: string;
  source?: string;
}

export interface NotebookCell {
  id: string;
  kind: "markdown" | "code" | "math" | "plot";
  language?: "markdown" | "python" | "typescript" | "latex" | "text";
  source: string;
  output?: string;
  executionState?: "idle" | "running" | "succeeded" | "failed";
  artifactPaths: string[];
  updatedAt: string;
}

export interface SyncEntry {
  path: string;
  size: number;
  sha256: string;
  updatedAt: string;
}

export interface SyncManifest {
  id: string;
  workspaceRoot: string;
  files: SyncEntry[];
  createdAt: string;
}

export interface SyncRun {
  id: string;
  direction: "push" | "pull";
  state: "succeeded" | "failed";
  remotePath: string;
  filesScanned: number;
  filesCopied: number;
  manifest: SyncManifest;
  message: string;
  startedAt: string;
  finishedAt: string;
}
