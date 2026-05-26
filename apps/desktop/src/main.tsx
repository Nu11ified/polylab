import React, { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Bot, Braces, CheckCircle2, Cloud, Code2, Command, Database, Download, FileText, FolderKanban, FolderOpen, Gauge, GitBranch, Globe2, KeyRound, MessageSquare, Monitor, Moon, Play, Plus, Save, Search, Settings, ShieldCheck, Sigma, Sun, Terminal, Zap } from "lucide-react";
import type { ActivityEvent, AgentHandoff, AgentRuntimeConfig, AgentSession, AgentTask, ArtifactContent, ArtifactRecord, AuthStatus, BenchmarkRun, ClientPerformanceStatus, CloudDispatchResult, CloudExecutionJob, CloudJobLog, CloudProviderConfig, DependencyPlan, DeploymentApplyResult, DeploymentMutation, DeploymentPlan, ExecutionLog, ExecutionRun, ExperimentRun, ExternalEditorLaunch, ExternalEditorPreset, FormulaCard, GitCommitResult, GitConflict, GitOperationResult, GitRemote, GitStatus, GitVerificationSummary, PatchReview, PermissionCheck, PermissionDecision, PersistenceEvent, PersistenceStatus, ProjectSummary, ResearchDocument, SyncRun, VerificationCheck, WorkspaceDiagnostic, WorkspaceFile, WorkspaceFileContent, WorkspaceSnapshot, WorkspaceSymbol } from "@polylab/types";
import { enqueueMutation, markMutationFailed, markMutationSynced, pendingMutationCount, reconcileOptimisticFormula, type LocalMutation } from "./optimistic";
import { collectPerformanceStatus, PERFORMANCE_BUDGETS, registerPolylabServiceWorker } from "./performance";
import "./styles.css";

const MonacoEditor = lazy(() => import("@monaco-editor/react"));

type ViewId = "home" | "build" | "run" | "publish" | "code" | "diff" | "math" | "latex" | "verify" | "notebook" | "experiment" | "benchmark" | "cloud" | "deploy" | "performance" | "database" | "security" | "artifacts" | "activity" | "git" | "sync" | "logs" | "settings";
type ThemeMode = "light" | "dark" | "system";

interface CommandItem {
  id: string;
  title: string;
  shortcut: string;
  view?: ViewId;
  run: () => void;
}

interface DesktopCredentialStatus {
  available: boolean;
  backend: string;
  message: string;
}

interface DesktopCredentialBridge {
  status: () => Promise<{ available: boolean; backend?: string }>;
  saveApiToken: (token: string) => Promise<{ ok: boolean; reason?: string }>;
  loadApiToken: () => Promise<{ ok: boolean; token?: string; reason?: string }>;
  clearApiToken: () => Promise<{ ok: boolean; reason?: string }>;
  saveCredential?: (name: string, value: string) => Promise<{ ok: boolean; reason?: string }>;
  loadCredential?: (name: string) => Promise<{ ok: boolean; value?: string; reason?: string }>;
  clearCredential?: (name: string) => Promise<{ ok: boolean; reason?: string }>;
}

declare global {
  interface Window {
    polylabDesktop?: {
      platform: string;
      versions: Record<string, string>;
      credentials?: DesktopCredentialBridge;
    };
  }
}

interface ClientState {
  activeView: ViewId;
  commandOpen: boolean;
  selectedProjectId: string;
  selectedThreadId: string;
  theme: ThemeMode;
  codexCommandDraft: string;
  selectedFormulaId: string;
  selectedFilePath: string;
  workspaceFiles: WorkspaceFile[];
  editorFile?: WorkspaceFileContent;
  editorTabs: WorkspaceFileContent[];
  workspaceSymbols: WorkspaceSymbol[];
  workspaceDiagnostics: WorkspaceDiagnostic[];
  editorPresets: ExternalEditorPreset[];
  selectedEditorPresetId: string;
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
  persistenceEvents: PersistenceEvent[];
  performanceStatus: ClientPerformanceStatus;
  authStatus: AuthStatus;
  authToken: string;
  credentialStatus: DesktopCredentialStatus;
  permissions: PermissionDecision[];
  permissionChecks: PermissionCheck[];
  artifacts: ArtifactRecord[];
  artifactPreview?: ArtifactContent;
  benchmarks: BenchmarkRun[];
  experiments: ExperimentRun[];
  patches: PatchReview[];
  agentRuntime: AgentRuntimeConfig;
  agentHandoffs: AgentHandoff[];
  agentSessions: AgentSession[];
  documents: ResearchDocument[];
  syncRuns: SyncRun[];
  activityEvents: ActivityEvent[];
  pendingMutations: LocalMutation[];
}

const initialState: ClientState = {
  activeView: "home",
  commandOpen: false,
  selectedProjectId: "local-research",
  selectedThreadId: "general",
  theme: "system",
  codexCommandDraft: "",
  selectedFormulaId: "softmax-jacobian",
  selectedFilePath: "",
  workspaceFiles: [],
  editorFile: undefined,
  editorTabs: [],
  workspaceSymbols: [],
  workspaceDiagnostics: [],
  editorPresets: [],
  selectedEditorPresetId: "vscode",
  projects: [
    {
      id: "local-research",
      name: "Local Research Workspace",
      branch: "main",
      runtime: "local",
      agentRuntime: "pi-mono",
      updatedAt: new Date().toISOString()
    }
  ],
  formulas: [],
  tasks: [],
  logs: [],
  executions: [],
  dependencyPlans: [],
  cloudProviders: [],
  cloudJobs: [],
  cloudLogs: [],
  deploymentPlans: [],
  deploymentMutations: [],
  persistence: { engine: "sqlite", orm: "drizzle", path: ".polylab/workspace.db", entityCount: 0, eventCount: 0 },
  persistenceEvents: [],
  performanceStatus: { cacheSupported: false, serviceWorkerSupported: false, serviceWorkerState: "unsupported", cacheName: "polylab-shell-v1", collectedAt: new Date().toISOString() },
  authStatus: { enabled: false, mode: "local-open", header: "authorization", tokenConfigured: false },
  authToken: "",
  credentialStatus: { available: false, backend: "browser-session", message: "Token is held only in memory." },
  permissions: [],
  permissionChecks: [],
  artifacts: [],
  artifactPreview: undefined,
  benchmarks: [],
  experiments: [],
  patches: [],
  agentRuntime: {
    runtime: "pi-mono",
    provider: "codex",
    state: "not-configured",
    credentialHint: "Use POLYLAB_CODEX_COMMAND to dispatch Codex through Pi mono.",
    workspaceIndexPath: "artifacts/agents/workspace-index.json",
    updatedAt: new Date().toISOString()
  },
  agentHandoffs: [],
  agentSessions: [],
  documents: [],
  syncRuns: [],
  activityEvents: [],
  pendingMutations: []
};

function createStore() {
  let state = readCachedState();
  const listeners = new Set<() => void>();

  const emit = () => {
    localStorage.setItem("polylab:client-state", JSON.stringify(persistableClientState(state)));
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(recipe: (draft: ClientState) => ClientState) {
      state = recipe(state);
      emit();
    }
  };
}

function readCachedState(): ClientState {
  const cached = localStorage.getItem("polylab:client-state");
  if (!cached) return initialState;
  try {
    const parsed = { ...initialState, ...JSON.parse(cached) } as ClientState;
    return {
      ...parsed,
      authToken: "",
      selectedProjectId: parsed.selectedProjectId ?? parsed.projects[0]?.id ?? initialState.selectedProjectId,
      selectedThreadId: parsed.selectedThreadId ?? "general",
      theme: parsed.theme ?? "system",
      codexCommandDraft: parsed.codexCommandDraft ?? parsed.agentRuntime.codexCommand ?? "",
      formulas: parsed.formulas.map(normalizeFormula),
      documents: parsed.documents.map(normalizeDocument)
    };
  } catch {
    return initialState;
  }
}

function persistableClientState(state: ClientState): ClientState {
  return { ...state, authToken: "" };
}

const store = createStore();

function useAppState() {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

function updateState(recipe: (draft: ClientState) => ClientState) {
  store.update(recipe);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = store.getSnapshot().authToken.trim();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`http://127.0.0.1:3917${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

async function loadStoredApiToken() {
  const credentials = window.polylabDesktop?.credentials;
  if (!credentials) return;
  try {
    const status = await credentials.status();
    const loaded = await credentials.loadApiToken();
    updateState((draft) => ({
      ...draft,
      authToken: loaded.ok && loaded.token ? loaded.token : draft.authToken,
      credentialStatus: {
        available: status.available,
        backend: status.backend ?? "unknown",
        message: loaded.ok ? "Protected API token loaded for this session." : credentialMessage(loaded.reason, status.available)
      }
    }));
  } catch {
    updateState((draft) => ({
      ...draft,
      credentialStatus: { available: false, backend: "unavailable", message: "Protected credential storage is unavailable." }
    }));
  }
}

async function saveApiToken() {
  const credentials = window.polylabDesktop?.credentials;
  const token = store.getSnapshot().authToken.trim();
  if (!credentials || !token) return;
  const result = await credentials.saveApiToken(token);
  const status = await credentials.status();
  updateState((draft) => ({
    ...draft,
    credentialStatus: {
      available: status.available,
      backend: status.backend ?? "unknown",
      message: result.ok ? "Protected API token stored." : credentialMessage(result.reason, status.available)
    }
  }));
}

async function clearStoredApiToken() {
  const credentials = window.polylabDesktop?.credentials;
  if (!credentials) return;
  const result = await credentials.clearApiToken();
  const status = await credentials.status();
  updateState((draft) => ({
    ...draft,
    authToken: "",
    credentialStatus: {
      available: status.available,
      backend: status.backend ?? "unknown",
      message: result.ok ? "Protected API token cleared." : credentialMessage(result.reason, status.available)
    }
  }));
}

function credentialMessage(reason: string | undefined, available: boolean) {
  if (!available) return "OS-protected credential storage is unavailable on this session.";
  if (reason === "missing") return "No protected API token is stored.";
  if (reason === "empty-token") return "Enter a token before storing it.";
  return "Protected credential storage is ready.";
}

function App() {
  const state = useAppState();
  const activeFormula = state.formulas.find((formula) => formula.id === state.selectedFormulaId) ?? state.formulas[0];

  useEffect(() => {
    void initializePerformanceRuntime();
    void loadStoredApiToken();
    void hydrate();
  }, []);

  useEffect(() => {
    applyTheme(state.theme);
    if (state.theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [state.theme]);

  const commands = useMemo<CommandItem[]>(() => [
    { id: "ask", title: "Ask agent about selection", shortcut: "Cmd+K", run: () => toggleCommand(true) },
    { id: "complex-task", title: "Run complex agent task", shortcut: "Cmd+Shift+K", run: () => void runAgentWorkflow() },
    { id: "apply-patch", title: "Apply patch", shortcut: "Cmd+Enter", run: () => void acceptFirstPendingHunk() },
    { id: "verify", title: "Verify formula", shortcut: "Cmd+Shift+Enter", view: "verify", run: () => void verifyActiveFormula() },
    { id: "run", title: "Run experiment", shortcut: "Cmd+Option+R", view: "experiment", run: () => void runExperiment() },
    { id: "sandbox", title: "Run Docker sandbox", shortcut: "Cmd+Option+S", view: "logs", run: () => void runSandboxExperiment() },
    { id: "generate", title: "Generate implementation", shortcut: "Cmd+Option+G", view: "diff", run: () => void generatePatch() },
    { id: "performance", title: "Open performance panel", shortcut: "Cmd+Option+P", view: "performance", run: () => setView("performance") },
    { id: "settings", title: "Open settings", shortcut: "Cmd+,", view: "settings", run: () => setView("settings") },
    { id: "new-formula", title: "Create formula", shortcut: "Cmd+Option+N", view: "math", run: () => void createFormula() },
    { id: "diff", title: "Open diff viewer", shortcut: "Cmd+Option+D", view: "diff", run: () => setView("diff") },
    { id: "math", title: "Open math viewer", shortcut: "Cmd+Option+M", view: "math", run: () => setView("math") },
    { id: "latex", title: "Open LaTeX preview", shortcut: "Cmd+Option+L", view: "latex", run: () => setView("latex") }
  ], []);

  useKeyboard(commands);

  const project = selectedProject(state);

  return (
    <div className="app-shell lab-shell">
      <aside className="lab-sidebar">
        <div className="lab-brand-row">
          <button className="brand lab-brand" onClick={() => setView("home")}><Sigma size={18} />PolyLab</button>
          <button className="lab-icon-button" aria-label="Settings" onClick={() => setView("settings")}><Settings size={15} /></button>
        </div>
        <ProjectSwitcher state={state} />
        <div className="lab-sidebar-actions">
          <button className="lab-primary-action" onClick={() => void refreshWorkspaceFiles()}><FolderOpen size={15} />Open project</button>
          <button className="lab-icon-button" aria-label="Command palette" onClick={() => toggleCommand(true)}><Command size={15} /></button>
        </div>

        <ThreadList state={state} />

        <NavSection label="Workspace">
          <NavItem icon={<Search size={15} />} label="Workbench" active={isViewIn(state.activeView, ["home", "math", "verify", "code", "diff"])} onClick={() => setView("home")} />
          <NavItem icon={<Braces size={15} />} label="Build" active={isViewIn(state.activeView, ["build", "notebook"])} onClick={() => setView("build")} />
          <NavItem icon={<Play size={15} />} label="Run" active={isViewIn(state.activeView, ["run", "experiment", "benchmark", "cloud", "logs"])} onClick={() => setView("run")} />
          <NavItem icon={<GitBranch size={15} />} label="Publish" active={isViewIn(state.activeView, ["publish", "git", "deploy", "latex"])} onClick={() => setView("publish")} />
          <NavItem icon={<Settings size={15} />} label="Settings" active={state.activeView === "settings"} onClick={() => setView("settings")} />
        </NavSection>
      </aside>

      <main className="workspace lab-workspace">
        <header className="topbar lab-topbar">
          <div className="top-meta">
            <span className="lab-title">{project.name}</span>
            <span><GitBranch size={14} />{project.branch}</span>
            <span><MessageSquare size={14} />{selectedThreadLabel(state)}</span>
            <span><Bot size={14} />{state.agentRuntime.state}</span>
            {project.workspaceRoot ? <span className="lab-path">{project.workspaceRoot}</span> : null}
          </div>
          <div className="top-actions">
            <button onClick={() => void openWorkspaceRoot()}><FolderOpen size={14} />Editor</button>
            <button onClick={() => void verifyActiveFormula()}><CheckCircle2 size={14} />Verify</button>
            <button onClick={() => void runAgentWorkflow()}><Bot size={14} />Run agent</button>
          </div>
        </header>
        <ViewSwitch view={state.activeView} formula={activeFormula} />
      </main>

      <CodeContextPanel state={state} />

      {state.commandOpen ? <CommandPalette commands={commands} /> : null}
    </div>
  );
}

function ViewSwitch({ view, formula }: { view: ViewId; formula?: FormulaCard }) {
  if (view === "home") return <HomeView formula={formula} />;
  if (view === "build") return <BuildWorkspace formula={formula} />;
  if (view === "run") return <RunWorkspace />;
  if (view === "publish") return <PublishWorkspace />;
  if (view === "code") return <CodeView />;
  if (view === "diff") return <DiffView formula={formula} />;
  if (view === "math") return <MathView formula={formula} />;
  if (view === "latex") return <LatexView />;
  if (view === "verify") return <VerificationView formula={formula} />;
  if (view === "experiment") return <ExperimentView />;
  if (view === "benchmark") return <BenchmarkView />;
  if (view === "cloud") return <CloudView />;
  if (view === "deploy") return <DeploymentView />;
  if (view === "performance") return <PerformanceView />;
  if (view === "database") return <DatabaseView />;
  if (view === "security") return <SecurityView />;
  if (view === "artifacts") return <ArtifactView />;
  if (view === "activity") return <ActivityView />;
  if (view === "git") return <GitView />;
  if (view === "sync") return <SyncView />;
  if (view === "logs") return <LogsView />;
  if (view === "settings") return <SettingsView />;
  return <NotebookView />;
}

function ProjectSwitcher({ state }: { state: ClientState }) {
  const project = selectedProject(state);
  return (
    <section className="project-switcher">
      <label htmlFor="project-select">Project</label>
      <div className="select-wrap">
        <FolderKanban size={15} />
        <select
          id="project-select"
          value={project.id}
          onChange={(event) => updateState((draft) => ({ ...draft, selectedProjectId: event.target.value, activeView: "home" }))}
        >
          {state.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </div>
      <small>{project.runtime} / {project.agentRuntime}</small>
    </section>
  );
}

function ThreadList({ state }: { state: ClientState }) {
  const threads = threadOptions(state);
  return (
    <NavSection label="Threads">
      {threads.map((thread) => (
        <button
          key={thread.id}
          className={`thread-row ${state.selectedThreadId === thread.id ? "active" : ""}`}
          onClick={() => updateState((draft) => ({ ...draft, selectedThreadId: thread.id, activeView: thread.view }))}
        >
          <MessageSquare size={14} />
          <span>{thread.label}</span>
          <small data-status={thread.status}>{thread.status}</small>
        </button>
      ))}
    </NavSection>
  );
}

function HomeView({ formula }: { formula?: FormulaCard }) {
  const state = useAppState();
  const project = selectedProject(state);
  const threadLabel = selectedThreadLabel(state);
  const latestSession = state.agentSessions[0];
  const latestVerification = formula?.verificationHistory[0];
  const failedChecks = latestVerification?.checks.filter((check) => check.status === "failed").length ?? 0;
  const warningChecks = latestVerification?.checks.filter((check) => check.status === "warning").length ?? 0;
  const activeRun = state.experiments[0] ?? state.executions[0];
  return (
    <section className="view workbench-view">
      <ViewHeader title={project.name} detail={`${threadLabel} / ${project.workspaceRoot ?? "local workspace"}`} />
      <div className="workbench-grid">
        <section className="workbench-primary">
          <div className="surface-heading">
            <strong>{formula?.title ?? "Math spec"}</strong>
            <div className="compact-actions">
              <button onClick={() => setView("math")}><Sigma size={14} />Spec</button>
              <button onClick={() => void verifyActiveFormula()}><CheckCircle2 size={14} />Verify</button>
              <button onClick={() => void generatePatch()}><Braces size={14} />Patch</button>
            </div>
          </div>
          <pre className="equation-block">{formula?.equation ?? "Select or create a formula for this project."}</pre>
          <div className="workbench-metrics">
            <Metric label="Verification" value={latestVerification ? `${latestVerification.status} / ${failedChecks} failed / ${warningChecks} warnings` : "not run"} />
            <Metric label="Implementation" value={state.editorFile?.path ?? `${state.workspaceFiles.filter((file) => file.kind === "file").length} indexed files`} />
            <Metric label="Run" value={activeRun ? `${activeRun.state}: ${activeRun.command}` : "idle"} />
          </div>
        </section>

        <section className="workbench-chat">
          <div className="surface-heading">
            <strong>Agent thread</strong>
            <div className="compact-actions">
              <button onClick={() => void runAgentWorkflow()}><Bot size={14} />Run</button>
              {latestSession ? <button onClick={() => void dispatchAgentHandoff(latestSession.id)}><Command size={14} />Codex</button> : null}
            </div>
          </div>
          <div className="status-stack">
            <span>{latestSession?.title ?? "No active agent session"}</span>
            <small>{latestSession ? `${latestSession.state} / ${latestSession.attempts}/${latestSession.maxAttempts} attempts` : state.agentRuntime.credentialHint}</small>
          </div>
          {latestSession?.plan.slice(0, 7).map((step) => (
            <div className="data-row" key={step.id}>
              <span>{step.title}</span>
              <small data-status={step.state}>{step.state}</small>
            </div>
          ))}
        </section>

        <section className="workbench-side">
          <CategoryCard icon={<Braces size={15} />} title="Build" detail={`${state.patches.length} patches / ${state.documents.length} docs`} onClick={() => setView("build")} />
          <CategoryCard icon={<Play size={15} />} title="Run" detail={`${state.experiments.length} experiments / ${state.benchmarks.length} benchmarks`} onClick={() => setView("run")} />
          <CategoryCard icon={<GitBranch size={15} />} title="Publish" detail={`${state.deploymentPlans.length} deploy plans / ${state.syncRuns.length} sync runs`} onClick={() => setView("publish")} />
        </section>
      </div>
    </section>
  );
}

function BuildWorkspace({ formula }: { formula?: FormulaCard }) {
  const state = useAppState();
  const latestPatch = state.patches[0];
  const latestVerification = formula?.verificationHistory[0];
  return (
    <section className="view category-view">
      <ViewHeader title="Build" detail="Math spec, generated implementation, patch review, and local documentation." />
      <div className="category-grid">
        <CategoryAction icon={<Sigma size={16} />} title="Math spec" detail={formula?.title ?? "No formula selected"} meta={formula?.status ?? "queued"} onClick={() => setView("math")} />
        <CategoryAction icon={<Code2 size={16} />} title="Implementation" detail={state.editorFile?.path ?? "Select a source file on the right"} meta={`${state.workspaceFiles.filter((file) => file.kind === "file").length} files`} onClick={() => setView("code")} />
        <CategoryAction icon={<Braces size={16} />} title="Patch review" detail={latestPatch?.title ?? "Generate a verified patch"} meta={latestPatch?.status ?? "idle"} onClick={() => setView("diff")} />
        <CategoryAction icon={<CheckCircle2 size={16} />} title="Verification" detail={latestVerification ? latestVerification.id : "Run checks before merging"} meta={latestVerification?.status ?? "not run"} onClick={() => setView("verify")} />
        <CategoryAction icon={<FileText size={16} />} title="Notebook" detail={state.documents[0]?.title ?? "Research notebook and executable cells"} meta={`${state.documents.length} docs`} onClick={() => setView("notebook")} />
        <CategoryAction icon={<Bot size={16} />} title="Agent build" detail={state.agentSessions[0]?.title ?? "Formula to verified implementation"} meta={state.agentRuntime.state} onClick={() => void runAgentWorkflow()} />
      </div>
    </section>
  );
}

function RunWorkspace() {
  const state = useAppState();
  return (
    <section className="view category-view">
      <ViewHeader title="Run" detail="Project-scoped execution, experiments, benchmarks, cloud jobs, and logs." />
      <div className="category-grid">
        <CategoryAction icon={<Play size={16} />} title="Experiment" detail={state.experiments[0]?.name ?? "Run reproducible graph/simulation checks"} meta={state.experiments[0]?.state ?? "idle"} onClick={() => setView("experiment")} />
        <CategoryAction icon={<Gauge size={16} />} title="Benchmark" detail={state.benchmarks[0]?.name ?? "Repeatable timing and artifact capture"} meta={state.benchmarks[0]?.state ?? "idle"} onClick={() => setView("benchmark")} />
        <CategoryAction icon={<Cloud size={16} />} title="Cloud" detail={`${state.cloudJobs.length} jobs / ${state.cloudProviders.length} providers`} meta={state.cloudJobs[0]?.state ?? "idle"} onClick={() => setView("cloud")} />
        <CategoryAction icon={<Terminal size={16} />} title="Logs" detail={state.logs[0]?.message ?? "Execution and server traces"} meta={`${state.logs.length} logs`} onClick={() => setView("logs")} />
        <CategoryAction icon={<ShieldCheck size={16} />} title="Security" detail="Permissions and audit checks for project actions" meta={`${state.permissionChecks.length} checks`} onClick={() => setView("security")} />
        <CategoryAction icon={<Zap size={16} />} title="Performance" detail="Shell, cache, memory, and offline status" meta={state.performanceStatus.serviceWorkerState} onClick={() => setView("performance")} />
      </div>
    </section>
  );
}

function PublishWorkspace() {
  const state = useAppState();
  return (
    <section className="view category-view">
      <ViewHeader title="Publish" detail="Git state, papers, notebooks, artifacts, sync, and deployment plans." />
      <div className="category-grid">
        <CategoryAction icon={<GitBranch size={16} />} title="Git" detail="Branch, diff, commit, remote, push, and pull" meta={selectedProject(state).branch} onClick={() => setView("git")} />
        <CategoryAction icon={<Globe2 size={16} />} title="Deploy" detail={state.deploymentPlans[0]?.name ?? "Docker/Caddy/DNS guarded deployment"} meta={state.deploymentPlans[0]?.state ?? "draft"} onClick={() => setView("deploy")} />
        <CategoryAction icon={<FileText size={16} />} title="Paper" detail={state.documents.find((document) => document.kind === "latex")?.title ?? "LaTeX preview and export"} meta={`${state.documents.length} docs`} onClick={() => setView("latex")} />
        <CategoryAction icon={<Download size={16} />} title="Artifacts" detail={`${state.artifacts.length} tracked outputs`} meta="local" onClick={() => setView("artifacts")} />
        <CategoryAction icon={<Cloud size={16} />} title="Sync" detail={state.syncRuns[0]?.message ?? "Manifest-based workspace federation"} meta={state.syncRuns[0]?.state ?? "idle"} onClick={() => setView("sync")} />
        <CategoryAction icon={<Database size={16} />} title="Database" detail={state.persistence.path} meta={`${state.persistence.entityCount} entities`} onClick={() => setView("database")} />
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <small>{label}</small>
      <span>{value}</span>
    </div>
  );
}

function CategoryCard({ icon, title, detail, onClick }: { icon: React.ReactNode; title: string; detail: string; onClick: () => void }) {
  return (
    <button className="category-card compact" onClick={onClick}>
      {icon}
      <span>{title}</span>
      <small>{detail}</small>
    </button>
  );
}

function CategoryAction({ icon, title, detail, meta, onClick }: { icon: React.ReactNode; title: string; detail: string; meta: string; onClick: () => void }) {
  return (
    <button className="category-action" onClick={onClick}>
      <span className="category-action-icon">{icon}</span>
      <span className="category-action-main">
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <small data-status={meta}>{meta}</small>
    </button>
  );
}

function CodeContextPanel({ state }: { state: ClientState }) {
  const files = state.workspaceFiles.filter((file) => file.kind === "file");
  const activeSymbols = state.workspaceSymbols.filter((symbol) => symbol.path === state.selectedFilePath);
  const activeDiagnostics = state.workspaceDiagnostics.filter((diagnostic) => diagnostic.path === state.selectedFilePath);
  const fileName = state.editorFile?.path ?? state.selectedFilePath;
  const source = state.editorFile?.content ?? "Select a file from this project.";
  return (
    <aside className="inspector-panel lab-code-panel">
      <section className="inspector-card">
        <div className="surface-heading">
          <strong>Implementation</strong>
          <small>{files.length} files</small>
        </div>
        <div className="lab-code-actions">
          <button onClick={() => void refreshWorkspaceFiles()}><Search size={14} />Index</button>
          <button onClick={() => void openExternalEditor()} disabled={!state.editorFile}><FolderOpen size={14} />Open</button>
        </div>
      </section>

      <section className="inspector-card lab-file-browser">
        <div className="surface-heading">
          <strong>Files</strong>
          <small>{fileName ? fileName.split("/").pop() : "none"}</small>
        </div>
        <div className="lab-file-list">
          {files.slice(0, 24).map((file) => (
            <button key={file.path} className={file.path === state.selectedFilePath ? "active" : ""} onClick={() => void openWorkspaceFile(file.path)}>
              <span>{file.path}</span>
              <small>{file.language ?? "text"}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="inspector-card lab-source-card">
        <div className="surface-heading">
          <strong>{fileName ? fileName.split("/").pop() : "Source"}</strong>
          <small>{state.editorFile?.language ?? "text"}</small>
        </div>
        <pre>{source}</pre>
      </section>

      <section className="inspector-card">
        <div className="surface-heading">
          <strong>Symbols</strong>
          <small>{activeDiagnostics.length} diagnostics</small>
        </div>
        {activeSymbols.slice(0, 8).map((symbol) => (
          <div className="data-row" key={symbol.id}>
            <span>{symbol.name}</span>
            <small>{symbol.kind} L{symbol.line}</small>
          </div>
        ))}
        {activeDiagnostics.slice(0, 5).map((diagnostic) => (
          <div className="data-row" key={diagnostic.id}>
            <span>{diagnostic.message}</span>
            <small data-status={diagnostic.severity}>L{diagnostic.line}</small>
          </div>
        ))}
        {activeSymbols.length === 0 && activeDiagnostics.length === 0 ? <small>No symbols or diagnostics for this file.</small> : null}
      </section>

      <section className="inspector-card">
        <div className="surface-heading">
          <strong>Checks</strong>
          <small>{state.formulas.find((formula) => formula.id === state.selectedFormulaId)?.status ?? "queued"}</small>
        </div>
        {(state.formulas.find((formula) => formula.id === state.selectedFormulaId)?.verificationHistory[0]?.checks ?? []).slice(0, 7).map((check) => (
          <div className="data-row" key={check.name}>
            <span>{check.name}</span>
            <small data-status={check.status}>{check.status}</small>
          </div>
        ))}
      </section>
    </aside>
  );
}

function SettingsView() {
  const state = useAppState();
  const project = selectedProject(state);
  return (
    <section className="view settings-view">
      <ViewHeader title="Settings" detail={`${project.name} / ${project.branch}`} />
      <div className="settings-grid">
        <section className="surface-panel">
          <div className="surface-heading">
            <strong>Appearance</strong>
            <small>{state.theme}</small>
          </div>
          <div className="segmented">
            <button className={state.theme === "light" ? "active" : ""} onClick={() => setTheme("light")}><Sun size={14} />Light</button>
            <button className={state.theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}><Moon size={14} />Dark</button>
            <button className={state.theme === "system" ? "active" : ""} onClick={() => setTheme("system")}><Monitor size={14} />System</button>
          </div>
        </section>

        <section className="surface-panel">
          <div className="surface-heading">
            <strong>Pi mono / Codex</strong>
            <small>{state.agentRuntime.state}</small>
          </div>
          <input
            className="git-message"
            value={state.codexCommandDraft}
            onChange={(event) => updateState((draft) => ({ ...draft, codexCommandDraft: event.target.value }))}
            aria-label="Codex command"
            placeholder="codex --model gpt-5"
          />
          <div className="settings-actions">
            <button className="commit-button" onClick={() => void saveAgentRuntimeConfig()}><Save size={14} />Save command</button>
            <button onClick={() => updateState((draft) => ({ ...draft, codexCommandDraft: "" }))}><KeyRound size={14} />Clear draft</button>
          </div>
          <small>{state.agentRuntime.credentialHint}</small>
        </section>

        <section className="surface-panel">
          <div className="surface-heading">
            <strong>API token</strong>
            <small>{state.credentialStatus.available ? state.credentialStatus.backend : "session"}</small>
          </div>
          <input
            className="git-message"
            value={state.authToken}
            onChange={(event) => updateState((draft) => ({ ...draft, authToken: event.target.value }))}
            aria-label="API token"
            placeholder="Remote API token"
            type="password"
          />
          <div className="settings-actions">
            <button onClick={() => void hydrate()}><ShieldCheck size={14} />Reconnect</button>
            <button onClick={() => void saveApiToken()}><ShieldCheck size={14} />Store</button>
            <button onClick={() => void clearStoredApiToken()}><ShieldCheck size={14} />Clear</button>
          </div>
          <small>{state.credentialStatus.message}</small>
        </section>

        <section className="surface-panel settings-wide">
          <div className="surface-heading">
            <strong>System</strong>
            <small>{state.persistence.engine}</small>
          </div>
          <div className="settings-link-grid">
            <button onClick={() => setView("artifacts")}><Download size={14} />Artifacts</button>
            <button onClick={() => setView("sync")}><Cloud size={14} />Sync</button>
            <button onClick={() => setView("security")}><ShieldCheck size={14} />Security</button>
            <button onClick={() => setView("database")}><Database size={14} />Database</button>
            <button onClick={() => setView("performance")}><Zap size={14} />Performance</button>
            <button onClick={() => setView("activity")}><Zap size={14} />Activity</button>
          </div>
        </section>

        <section className="surface-panel settings-wide">
          <div className="surface-heading">
            <strong>Cloud credentials</strong>
            <small>{state.cloudProviders.length} providers</small>
          </div>
          <div className="cloud-settings-list">
            {state.cloudProviders.map((provider) => (
              <div className="provider-settings-row" key={provider.id}>
                <div>
                  <strong>{provider.name}</strong>
                  <small data-status={provider.state}>{provider.state}</small>
                </div>
                <CloudCredentialControls provider={provider} />
              </div>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

function CodeView() {
  const { workspaceFiles, editorFile, editorTabs, workspaceSymbols, workspaceDiagnostics, selectedFilePath, editorPresets, selectedEditorPresetId } = useAppState();
  const files = workspaceFiles.filter((file) => file.kind === "file");
  const activeSymbols = workspaceSymbols.filter((symbol) => symbol.path === selectedFilePath);
  const activeDiagnostics = workspaceDiagnostics.filter((diagnostic) => diagnostic.path === selectedFilePath);
  const source = editorFile?.content ?? "# Select or create a workspace file.\n";
  const language = editorFile?.language === "typescript" ? "typescript" : editorFile?.language ?? "markdown";
  return (
    <section className="view">
      <ViewHeader title="Code Editor" detail={editorFile?.path ?? "Indexed workspace files with Monaco editing and local save."} />
      <div className="code-grid">
        <div className="file-index">
          <div className="git-actions">
            <button onClick={() => void refreshWorkspaceFiles()}><Search size={14} />Index</button>
            <button onClick={() => void saveEditorFile()} disabled={!editorFile}><Download size={14} />Save</button>
          </div>
          <select
            className="git-message"
            value={selectedEditorPresetId}
            onChange={(event) => updateState((draft) => ({ ...draft, selectedEditorPresetId: event.target.value }))}
            aria-label="External editor preset"
          >
            {editorPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
          <button className="commit-button" onClick={() => void openExternalEditor()} disabled={!editorFile}>Open external</button>
          {files.map((file) => (
            <button key={file.path} className={`file-row ${file.path === selectedFilePath ? "active" : ""}`} onClick={() => void openWorkspaceFile(file.path)}>
              <span>{file.path}</span>
              <small>{file.language ?? "text"}</small>
            </button>
          ))}
          {files.length === 0 ? <div className="wide-row"><span>No editable files indexed</span><small>empty</small></div> : null}
        </div>
        <div className="editor-frame">
        <div className="editor-tabs">
          {editorTabs.map((tab) => (
            <button key={tab.path} className={tab.path === selectedFilePath ? "active" : ""} onClick={() => selectEditorTab(tab.path)}>
              <span>{tab.path.split("/").pop()}</span>
              <small>{tab.language ?? "text"}</small>
            </button>
          ))}
        </div>
        <Suspense fallback={<div className="editor-fallback">Loading editor...</div>}>
          <MonacoEditor
            key={editorFile?.path ?? "empty"}
            height="calc(100% - 36px)"
            language={language}
            value={source}
            onChange={(value) => updateEditorContent(value ?? "")}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              fontLigatures: true,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              padding: { top: 16, bottom: 16 }
            }}
          />
        </Suspense>
        </div>
        <div className="symbol-index">
          <strong>Symbols</strong>
          {activeSymbols.slice(0, 12).map((symbol) => (
            <button key={symbol.id} onClick={() => void openWorkspaceFile(symbol.path)}>
              <span>{symbol.name}</span>
              <small>{symbol.kind} L{symbol.line}</small>
            </button>
          ))}
          <strong>Diagnostics</strong>
          {activeDiagnostics.slice(0, 12).map((diagnostic) => (
            <div className="diagnostic-row" key={diagnostic.id} data-status={diagnostic.severity}>
              <span>{diagnostic.message}</span>
              <small>L{diagnostic.line}:{diagnostic.column}</small>
            </div>
          ))}
          {activeSymbols.length === 0 && activeDiagnostics.length === 0 ? <small>No symbols or diagnostics for this file.</small> : null}
        </div>
      </div>
    </section>
  );
}

function DiffView({ formula }: { formula?: FormulaCard }) {
  const { patches } = useAppState();
  const activePatch = patches[0];
  return (
    <section className="view">
      <ViewHeader title="Diff Viewer" detail="Side-by-side review with hunk acceptance and verification status." />
      <div className="diff-grid">
        <pre>{activePatch ? activePatch.hunks.map((hunk) => `--- ${hunk.filePath}\n+++ ${hunk.filePath}\n${hunk.before ? `- ${hunk.before}` : ""}\n+ ${hunk.after}`).join("\n\n") : "No generated patch yet."}</pre>
        <div className="patch-meta">
          <strong>{activePatch?.title ?? "Patch review"}</strong>
          <span>{activePatch?.explanation ?? "Generate an implementation patch from the active formula."}</span>
          <small>{activePatch?.status ?? "idle"}</small>
          <button onClick={() => void generatePatch(formula?.id)}><Braces size={15} />Generate</button>
          {activePatch?.hunks.map((hunk) => (
            <div className="hunk-actions" key={hunk.id}>
              <span>{hunk.summary}</span>
              <small>{hunk.status}</small>
              <button onClick={() => void decideHunk(activePatch.id, hunk.id, "accepted")} disabled={hunk.status !== "pending"}>Accept</button>
              <button onClick={() => void decideHunk(activePatch.id, hunk.id, "rejected")} disabled={hunk.status !== "pending"}>Reject</button>
            </div>
          ))}
          <button onClick={() => void verifyActiveFormula()}><CheckCircle2 size={15} />Verify patch</button>
        </div>
      </div>
    </section>
  );
}

function MathView({ formula }: { formula?: FormulaCard }) {
  return (
    <section className="view">
      <ViewHeader title={formula?.title ?? "Math Viewer"} detail="Symbolic simplification, shapes, assumptions, generated implementations." />
      <div className="formula-card-large">
        <div className="equation">{formula?.equation ?? "No formula selected"}</div>
        <div className="pill-row">{formula?.variables.map((item) => <span key={item}>{item}</span>)}</div>
        <div className="metadata-grid">
          <MetaList label="Assumptions" items={formula?.assumptions ?? []} />
          <MetaList label="Inputs" items={formula?.inputShapes ?? []} />
          <MetaList label="Outputs" items={formula?.outputShapes ?? []} />
          <MetaList label="Constraints" items={formula?.constraints ?? []} />
        </div>
      </div>
    </section>
  );
}

function NotebookView() {
  const document = useAppState().documents.find((item) => item.kind === "notebook");
  if (!document) return <DocumentView fallbackTitle="Notebook" fallbackBody="# Notebook\n\nNo notebook document loaded." />;
  return (
    <section className="view">
      <ViewHeader title={document.title} detail={document.path} />
      <div className="notebook-grid">
        <div className="notebook-cells">
          {document.cells.map((cell) => (
            <div className="notebook-cell-row" key={cell.id} data-status={cell.executionState ?? "idle"}>
              <div>
                <strong>{cell.kind}</strong>
                <small>{cell.language ?? "text"}</small>
              </div>
              <pre>{cell.source}</pre>
              {cell.output ? <pre className="cell-output">{cell.output}</pre> : null}
              {cell.artifactPaths.length > 0 ? <small>{cell.artifactPaths.join(", ")}</small> : null}
              {cell.kind === "code" ? <button onClick={() => void runNotebookCell(document.id, cell.id)}><Play size={14} />Run</button> : null}
            </div>
          ))}
          <button className="commit-button" onClick={() => void exportNotebook(document.id)}><Download size={14} />Export script</button>
        </div>
        <div className="document-preview">
          <div dangerouslySetInnerHTML={{ __html: document.previewHtml }} />
          <div className="build-log">{document.buildLog.map((line) => <span key={line}>{line}</span>)}</div>
        </div>
      </div>
    </section>
  );
}

function LatexView() {
  const document = useAppState().documents.find((item) => item.kind === "latex");
  return <DocumentView document={document} fallbackTitle="LaTeX Preview" fallbackBody="\\begin{equation}\nJ_{ij} = s_i(\\delta_{ij} - s_j)\n\\end{equation}" />;
}

function DocumentView({ document, fallbackTitle, fallbackBody }: { document?: ResearchDocument; fallbackTitle: string; fallbackBody: string }) {
  const source = document?.source ?? fallbackBody;
  return (
    <section className="view">
      <ViewHeader title={document?.title ?? fallbackTitle} detail={document?.path ?? "Local document preview"} />
      <div className="document-grid">
        <pre>{source}</pre>
        <div className="document-preview">
          <div dangerouslySetInnerHTML={{ __html: document?.previewHtml ?? "<p>No preview rendered.</p>" }} />
          <div className="build-log">
            {(document?.buildLog ?? ["Preview not rendered yet."]).map((line) => <span key={line}>{line}</span>)}
          </div>
          {document ? (
            <button className="commit-button" onClick={() => void exportDocumentPdf(document.id)}><Download size={14} />Export PDF</button>
          ) : null}
          {document?.pdfArtifactPath ? <small>{document.pdfArtifactPath}</small> : null}
        </div>
      </div>
    </section>
  );
}

function VerificationView({ formula }: { formula?: FormulaCard }) {
  const latest = formula?.verificationHistory[0];
  return (
    <section className="view">
      <ViewHeader title="Verification Dashboard" detail="Symbolic, property, metamorphic, robustness, autodiff, robotics, reproducibility, model, distributed, interval, SMT, parity, and benchmark gates." />
      <div className="check-grid">
        {(latest?.checks ?? defaultChecks(formula)).map((check) => (
          <div className="check-card" key={check.name} data-status={check.status}>
            <CheckCircle2 size={18} />
            <strong>{check.name}</strong>
            <span>{check.detail}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ExperimentView() {
  const { experiments } = useAppState();
  const active = experiments[0];
  return (
    <section className="view">
      <ViewHeader title="Experiment Graph" detail={active ? `${active.name} / ${active.state}` : "Run a reproducible simulation experiment with graph and sample artifacts."} />
      <div className="experiment-grid">
        <div className="wide-list">
          <div className="git-actions">
            <button onClick={() => void runExperiment()}><Play size={14} />Run simulation</button>
            <button onClick={() => void runSandboxExperiment()}><ShieldCheck size={14} />Docker</button>
          </div>
          {experiments.map((experiment) => (
            <div className="run-row" key={experiment.id} data-status={experiment.state}>
              <div>
                <strong>{experiment.name}</strong>
                <span>{experiment.command}</span>
              </div>
              <small>{experiment.nodes.length} nodes / {experiment.artifactPaths.length} artifacts</small>
            </div>
          ))}
          {experiments.length === 0 ? <div className="wide-row"><span>No experiments yet</span><small>idle</small></div> : null}
        </div>
        <div className="experiment-graph">
          {(active?.nodes ?? []).map((node) => (
            <div className="graph-node" key={node.id} data-status={node.status}>
              <strong>{node.label}</strong>
              <small>{node.kind}</small>
            </div>
          ))}
          <pre>{(active?.edges ?? []).map((edge) => `${edge.from} -> ${edge.to}: ${edge.label}`).join("\n") || "Graph appears after a run."}</pre>
        </div>
        <div className="simulation-panel">
          {(active?.samples ?? []).map((sample) => (
            <div className="sample-row" key={sample.step}>
              <span>{sample.label}</span>
              <meter min={0} max={1.4} value={Math.max(0, Math.min(1.4, sample.value))} />
              <small>{sample.value.toFixed(3)}</small>
            </div>
          ))}
          {active?.artifactPaths.map((path) => <small key={path}>{path}</small>)}
        </div>
      </div>
    </section>
  );
}

function LogsView() {
  const { logs, executions, dependencyPlans } = useAppState();
  return (
    <section className="view">
      <ViewHeader title="Execution Logs" detail="Local and remote execution traces." />
      <div className="execution-grid">
        <div className="wide-list">
          <div className="git-actions">
            <button onClick={() => void runExperiment()}><Play size={14} />Local</button>
            <button onClick={() => void runSandboxExperiment()}><ShieldCheck size={14} />Docker</button>
            <button onClick={() => void scanDependencies()}><Search size={14} />Deps</button>
            {dependencyPlans[0] ? <button onClick={() => void applyDependencyPlan(dependencyPlans[0]!.id)}><Download size={14} />Install</button> : null}
          </div>
          {dependencyPlans.map((plan) => (
            <div className="run-row" key={plan.id} data-status={plan.state === "failed" ? "failed" : plan.state === "installed" ? "succeeded" : "queued"}>
              <div>
                <strong>{plan.summary}</strong>
                <span>{plan.installCommand || "No install command needed"}</span>
              </div>
              <small>{plan.state}</small>
              <pre>{plan.items.map((item) => `${item.manager}: ${item.name}${item.requestedVersion ?? ""}`).join("\n") || plan.stderr || "No dependencies detected."}</pre>
            </div>
          ))}
          {executions.map((run) => (
            <div className="run-row" key={run.id} data-status={run.state}>
              <div>
                <strong>{run.command}</strong>
                <span>{run.route.target}{run.sandbox ? ` / ${run.sandbox}` : ""}: {run.route.reason}</span>
              </div>
              <small>{run.state}{run.exitCode !== undefined ? ` / ${run.exitCode}` : ""}</small>
              <pre>{run.stdout || run.stderr || "No output."}</pre>
            </div>
          ))}
          {executions.length === 0 ? <div className="wide-row"><span>No executions yet</span><small>idle</small></div> : null}
        </div>
        <div className="wide-list">
          {logs.map((log) => (
            <div className="wide-row" key={log.id}>
              <span>{log.message}</span>
              <small>{log.target} / {log.level}</small>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ArtifactView() {
  const { artifacts, artifactPreview } = useAppState();
  return (
    <section className="view">
      <ViewHeader title="Artifacts" detail={artifactPreview?.artifact.path ?? "Tracked execution, benchmark, document, cloud, and deployment outputs."} />
      <div className="artifact-grid">
        <div className="wide-list artifacts-list">
          {artifacts.map((artifact) => (
            <button className="artifact-row" key={artifact.id} onClick={() => void previewArtifact(artifact.id)}>
              <span>{artifact.path}</span>
              <small>{artifact.sourceType} / {artifact.size} bytes</small>
            </button>
          ))}
          {artifacts.length === 0 ? <div className="wide-row"><span>No artifacts yet</span><small>empty</small></div> : null}
        </div>
        <pre className="artifact-preview">{artifactPreview?.content ?? "Select an artifact to preview its contents."}</pre>
      </div>
    </section>
  );
}

function ActivityView() {
  const { activityEvents } = useAppState();
  return (
    <section className="view">
      <ViewHeader title="Activity" detail="Persisted workspace event stream across agents, execution, Git, sync, artifacts, permissions, editor, and deployment." />
      <div className="wide-list">
        {activityEvents.map((event) => (
          <div className="run-row" key={event.id} data-status={event.level === "error" ? "failed" : "succeeded"}>
            <div>
              <strong>{event.title}</strong>
              <span>{event.detail}</span>
            </div>
            <small>{event.type} / {new Date(event.createdAt).toLocaleTimeString()}</small>
          </div>
        ))}
        {activityEvents.length === 0 ? <div className="wide-row"><span>No activity yet</span><small>empty</small></div> : null}
      </div>
    </section>
  );
}

function PerformanceView() {
  const { performanceStatus, pendingMutations } = useAppState();
  const bootOk = !performanceStatus.bootMs || performanceStatus.bootMs <= PERFORMANCE_BUDGETS.bootMs;
  const heapOk = !performanceStatus.heapUsedMb || performanceStatus.heapUsedMb <= PERFORMANCE_BUDGETS.heapMb;
  return (
    <section className="view">
      <ViewHeader title="Performance" detail="Local-first cache, boot timing, memory budget, and offline shell state." />
      <div className="performance-grid">
        <div className="sync-summary">
          <strong>{performanceStatus.serviceWorkerState}</strong>
          <span>{performanceStatus.serviceWorkerSupported ? `${performanceStatus.cacheName} caches the shell and built assets.` : "Service workers are unavailable in this runtime."}</span>
          <small>{performanceStatus.cachedAssetCount ?? 0} cached assets / {pendingMutationCount(pendingMutations)} queued mutations</small>
          <button className="commit-button" onClick={() => void refreshPerformanceStatus()}><Zap size={14} />Refresh</button>
        </div>
        <div className="wide-list">
          <div className="wide-row" data-status={bootOk ? "passed" : "warning"}>
            <span>Boot to React</span>
            <small>{performanceStatus.bootMs ? `${performanceStatus.bootMs}ms / ${PERFORMANCE_BUDGETS.bootMs}ms budget` : "not measured"}</small>
          </div>
          <div className="wide-row" data-status={heapOk ? "passed" : "warning"}>
            <span>JS heap</span>
            <small>{performanceStatus.heapUsedMb ? `${performanceStatus.heapUsedMb}MB used / ${PERFORMANCE_BUDGETS.heapMb}MB budget` : "not exposed"}</small>
          </div>
          <div className="wide-row" data-status={performanceStatus.cacheSupported ? "passed" : "failed"}>
            <span>Cache API</span>
            <small>{performanceStatus.cacheSupported ? "available" : "unavailable"}</small>
          </div>
          <div className="wide-row" data-status={performanceStatus.serviceWorkerSupported ? "passed" : "warning"}>
            <span>Offline shell</span>
            <small>{performanceStatus.serviceWorkerSupported ? performanceStatus.serviceWorkerState : "file protocol"}</small>
          </div>
        </div>
      </div>
    </section>
  );
}

function GitView() {
  const [status, setStatus] = useState<GitStatus | undefined>();
  const [diff, setDiff] = useState("");
  const [commitMessage, setCommitMessage] = useState("PolyLab verified workspace update");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [branchName, setBranchName] = useState("research/update");
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [verificationSummary, setVerificationSummary] = useState<GitVerificationSummary | undefined>();

  useEffect(() => {
    void refreshGit(setStatus, setDiff);
    void refreshGitRefs(setRemotes, setBranches);
    void refreshGitVerification(setVerificationSummary);
  }, []);

  return (
    <section className="view">
      <ViewHeader title="Git Panel" detail="Branch, working tree status, diff preview, and repository initialization." />
      <div className="git-grid">
        <div className="git-summary">
          <strong>{status?.branch ?? "Loading"}</strong>
          <span>{status?.summary ?? "Reading repository status..."}</span>
          <div className="git-actions">
            <button onClick={() => void refreshGit(setStatus, setDiff)}>Refresh</button>
            <button onClick={() => void initGit(setStatus, setDiff)} disabled={status?.initialized}>Init</button>
            <button onClick={() => void stageGit(setStatus, setDiff)}>Stage</button>
          </div>
          <input
            className="git-message"
            value={commitMessage}
            onChange={(event) => setCommitMessage(event.target.value)}
            aria-label="Commit message"
          />
          <button className="commit-button" onClick={() => void commitGit(commitMessage, setStatus, setDiff)}>Commit</button>
          <button className="commit-button" onClick={() => void resolveAllConflicts(setStatus, setDiff, "theirs")} disabled={!status?.conflicts.length}>Use theirs</button>
          <small>{verificationSummary ? `Verification ${verificationSummary.status}: ${verificationSummary.passed} passed / ${verificationSummary.warning} warnings / ${verificationSummary.failed} failed` : "Verification summary loading"}</small>
          <input
            className="git-message"
            value={branchName}
            onChange={(event) => setBranchName(event.target.value)}
            aria-label="Branch name"
          />
          <div className="git-actions">
            <button onClick={() => void createGitBranch(branchName, setStatus, setRemotes, setBranches)}>Branch</button>
            <button onClick={() => void pullGit(setStatus, setDiff, setRemotes, setBranches)}>Pull</button>
            <button onClick={() => void pushGit(setStatus, setDiff, setRemotes, setBranches)}>Push</button>
          </div>
          <input
            className="git-message"
            value={remoteUrl}
            onChange={(event) => setRemoteUrl(event.target.value)}
            aria-label="Remote URL"
            placeholder="Remote URL"
          />
          <div className="git-actions">
            <button onClick={() => void addGitRemote(remoteUrl, setStatus, setRemotes, setBranches)}>Remote</button>
            <button onClick={() => void cloneGit(remoteUrl)}>Clone</button>
          </div>
          <small>{remotes.map((remote) => `${remote.name}: ${remote.url}`).join(" / ") || "No remotes"}</small>
          <small>{branches.join(", ") || "No branches"}</small>
        </div>
        <div className="wide-list">
          {(status?.conflicts ?? []).map((conflict) => (
            <div className="run-row" key={conflict.path} data-status="failed">
              <div>
                <strong>{conflict.path}</strong>
                <span>{conflict.markerCount} conflict marker{conflict.markerCount === 1 ? "" : "s"}</span>
              </div>
              <small>conflict</small>
              <div className="git-actions">
                <button onClick={() => void resolveGitConflict(conflict, "ours", setStatus, setDiff)}>Ours</button>
                <button onClick={() => void resolveGitConflict(conflict, "theirs", setStatus, setDiff)}>Theirs</button>
              </div>
              <pre>{`ours:\n${conflict.ours || "(empty)"}\n---\ntheirs:\n${conflict.theirs || "(empty)"}`}</pre>
            </div>
          ))}
          {(status?.files ?? []).map((file) => (
            <div className="wide-row" key={file.path} data-status={file.conflicted ? "failed" : undefined}>
              <span>{file.path}</span>
              <small>{file.index}{file.worktree}{file.conflicted ? " conflict" : ""}</small>
            </div>
          ))}
          {status?.files.length === 0 ? <div className="wide-row"><span>No changed files</span><small>clean</small></div> : null}
        </div>
        <pre className="git-diff">{diff || "No unstaged diff."}</pre>
      </div>
    </section>
  );
}

function BenchmarkView() {
  const { benchmarks } = useAppState();
  return (
    <section className="view">
      <ViewHeader title="Benchmark Dashboard" detail="Repeatable command benchmarks with timing summaries and persisted artifacts." />
      <div className="benchmark-grid">
        <div className="sync-summary">
          <strong>{benchmarks[0] ? `${benchmarks[0].name}: ${benchmarks[0].meanMs}ms` : "No benchmark runs"}</strong>
          <span>{benchmarks[0]?.command ?? "Run the default local benchmark to validate the execution and artifact pipeline."}</span>
          <small>{benchmarks[0] ? `${benchmarks[0].iterations} iterations / ${benchmarks[0].route.target}` : "Default: echo PolyLab benchmark ready"}</small>
          <button className="commit-button" onClick={() => void runBenchmark()}><Gauge size={14} />Run benchmark</button>
        </div>
        <div className="wide-list">
          {benchmarks.map((benchmark) => (
            <div className="run-row" key={benchmark.id} data-status={benchmark.state}>
              <div>
                <strong>{benchmark.name}</strong>
                <span>{benchmark.command}</span>
              </div>
              <small>{benchmark.meanMs}ms mean</small>
              <pre>{`min ${benchmark.minMs}ms\nmax ${benchmark.maxMs}ms\nartifacts ${benchmark.artifactPaths.length}`}</pre>
            </div>
          ))}
          {benchmarks.length === 0 ? <div className="wide-row"><span>No benchmarks yet</span><small>idle</small></div> : null}
        </div>
      </div>
    </section>
  );
}

function CloudView() {
  const { cloudProviders, cloudJobs, cloudLogs } = useAppState();
  return (
    <section className="view">
      <ViewHeader title="Cloud Execution" detail="Provider readiness, remote job handoff, artifact transfer metadata, and execution history." />
      <div className="cloud-grid">
        <div className="wide-list">
          {cloudProviders.map((provider) => (
            <div className="run-row" key={provider.id} data-status={provider.state}>
              <div>
                <strong>{provider.name}</strong>
                <span>{provider.credentialHint ?? provider.authMethod}</span>
              </div>
              <small>{provider.state}</small>
              <CloudCredentialControls provider={provider} />
              <pre>{`${provider.defaultRegion ?? "default"}\n${provider.costHint ?? "cost unknown"}`}</pre>
            </div>
          ))}
          {cloudProviders.length === 0 ? <div className="wide-row"><span>No providers loaded</span><small>idle</small></div> : null}
          <button className="commit-button" onClick={() => void runCloudJob()}><Cloud size={14} />Queue GPU job</button>
          <button className="commit-button" onClick={() => void runNotebookCloudJob()}><Cloud size={14} />Queue notebook</button>
        </div>
        <div className="wide-list">
          {cloudJobs.map((job) => (
            <div className="run-row" key={job.id} data-status={job.state}>
              <div>
                <strong>{job.provider} / {job.state}</strong>
                <span>{job.command}</span>
              </div>
              <small>{job.costEstimate ?? "cost pending"}</small>
              <div className="git-actions">
                <button onClick={() => void dispatchCloudJob(job.id)} disabled={job.state === "succeeded" || job.state === "failed" || job.state === "cancelled"}><Play size={14} />Dispatch</button>
                <button onClick={() => void cancelCloudJob(job.id)} disabled={job.state === "succeeded" || job.state === "failed" || job.state === "cancelled"}>Cancel</button>
              </div>
              <pre>{job.artifactPaths.join("\n") || job.reason}</pre>
            </div>
          ))}
          {cloudJobs.length === 0 ? <div className="wide-row"><span>No cloud jobs yet</span><small>idle</small></div> : null}
          {cloudLogs.slice(0, 8).map((log) => (
            <div className="wide-row" key={log.id} data-status={log.level === "error" ? "failed" : log.level === "warn" ? "warning" : "passed"}>
              <span>{log.message}</span>
              <small>{log.provider}</small>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CloudCredentialControls({ provider }: { provider: CloudProviderConfig }) {
  const [value, setValue] = useState("");
  const disabled = provider.id === "local" || provider.id === "docker";
  return (
    <div className="git-actions">
      <input
        className="git-message"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-label={`${provider.name} credential`}
        placeholder={`${provider.name} credential`}
        type="password"
        disabled={disabled}
      />
      <button onClick={() => void storeProviderCredential(provider, value, setValue)} disabled={disabled || !value.trim()}><ShieldCheck size={14} />Store</button>
      <button onClick={() => void clearProviderCredential(provider)} disabled={disabled}><ShieldCheck size={14} />Clear</button>
    </div>
  );
}

function DeploymentView() {
  const { deploymentPlans, deploymentMutations } = useAppState();
  const latest = deploymentPlans[0];
  return (
    <section className="view">
      <ViewHeader title="Deployment" detail="Docker Compose, Caddy reverse-proxy config, guarded reloads, Cloudflare DNS mutation, and rollback artifacts." />
      <div className="deployment-grid">
        <div className="sync-summary">
          <strong>{latest?.name ?? "No deployment plan"}</strong>
          <span>{latest ? `${latest.routes.length} routes / ${latest.dnsPreview.length} DNS changes / ${latest.artifactPaths.length} artifacts / ${deploymentMutations.length} mutations` : "Generate a local deployment plan before mutating infrastructure."}</span>
          <small>{latest?.state ?? "draft"}</small>
          <button className="commit-button" onClick={() => void createDeploymentPlan()}><Globe2 size={14} />Generate plan</button>
          <button className="commit-button" onClick={() => latest ? void applyDeploymentPlan(latest.id, false) : undefined} disabled={!latest}><CheckCircle2 size={14} />Apply guarded</button>
          <button className="commit-button" onClick={() => latest ? void applyDeploymentPlan(latest.id, true) : undefined} disabled={!latest}><Cloud size={14} />Apply DNS</button>
          <button className="commit-button" onClick={() => latest ? void rollbackDeploymentPlan(latest.id) : undefined} disabled={!latest}><Download size={14} />Rollback</button>
        </div>
        <div className="wide-list">
          {deploymentMutations.slice(0, 8).map((mutation) => (
            <div className="wide-row" key={mutation.id} data-status={mutation.state}>
              <span>{mutation.kind} / {mutation.target}</span>
              <small>{mutation.state}</small>
            </div>
          ))}
          {deploymentPlans.map((plan) => (
            <div className="run-row" key={plan.id} data-status={plan.state}>
              <div>
                <strong>{plan.name}</strong>
                <span>{plan.artifactPaths.join(", ")}</span>
              </div>
              <small>{plan.dnsPreview.length} DNS</small>
              {plan.dockerCompose ? <pre>{plan.dockerCompose}</pre> : null}
              <pre>{plan.caddyfile}</pre>
            </div>
          ))}
          {deploymentPlans.length === 0 ? <div className="wide-row"><span>No deployment plans yet</span><small>idle</small></div> : null}
        </div>
      </div>
    </section>
  );
}

function DatabaseView() {
  const { persistence, persistenceEvents } = useAppState();
  return (
    <section className="view">
      <ViewHeader title="Persistence" detail="SQLite database indexed through Drizzle alongside local-first workspace files." />
      <div className="database-grid">
        <div className="sync-summary">
          <strong>{persistence.engine} / {persistence.orm}</strong>
          <span>{persistence.path}</span>
          <small>{persistence.entityCount} entities / {persistence.eventCount} events</small>
          <button className="commit-button" onClick={() => void refreshPersistence()}><Database size={14} />Refresh</button>
        </div>
        <div className="wide-list">
          {persistenceEvents.map((event) => (
            <div className="wide-row" key={event.id}>
              <span>{event.entityType} / {event.entityId}</span>
              <small>{event.operation}</small>
            </div>
          ))}
          {persistenceEvents.length === 0 ? <div className="wide-row"><span>No database events loaded</span><small>empty</small></div> : null}
        </div>
      </div>
    </section>
  );
}

function SecurityView() {
  const { authStatus, authToken, credentialStatus, permissions, permissionChecks } = useAppState();
  return (
    <section className="view">
      <ViewHeader title="Security" detail="Explicit permission modes and the audit trail for actions that read, write, execute, sync, mutate Git, or touch DNS." />
      <div className="security-grid">
        <div className="sync-summary">
          <strong>{authStatus.enabled ? "Token auth enabled" : "Local API open"}</strong>
          <span>{authStatus.enabled ? "Standalone server requests require a bearer token." : "No POLYLAB_AUTH_TOKEN is configured for the local server."}</span>
          <small>{credentialStatus.message} {credentialStatus.available ? `(${credentialStatus.backend})` : ""}</small>
          <input
            className="git-message"
            value={authToken}
            onChange={(event) => updateState((draft) => ({ ...draft, authToken: event.target.value }))}
            aria-label="API token"
            placeholder="Remote API token"
            type="password"
          />
          <button className="commit-button" onClick={() => void hydrate()}><ShieldCheck size={14} />Reconnect</button>
          <button className="commit-button" onClick={() => void saveApiToken()}><ShieldCheck size={14} />Store</button>
          <button className="commit-button" onClick={() => void clearStoredApiToken()}><ShieldCheck size={14} />Clear</button>
        </div>
        <div className="wide-list">
          {permissions.map((permission) => (
            <div className="run-row" key={permission.category} data-status={permission.mode === "deny" ? "failed" : "passed"}>
              <div>
                <strong>{permission.category}</strong>
                <span>{permission.reason}</span>
              </div>
              <small>{permission.mode}</small>
            </div>
          ))}
          {permissions.length === 0 ? <div className="wide-row"><span>No permission policy loaded</span><small>empty</small></div> : null}
        </div>
        <div className="wide-list">
          {permissionChecks.map((check) => (
            <div className="wide-row" key={check.id} data-status={check.allowed ? "passed" : "failed"}>
              <span>{check.action} / {check.resource}</span>
              <small>{check.category} {check.allowed ? "allowed" : "denied"}</small>
            </div>
          ))}
          {permissionChecks.length === 0 ? <div className="wide-row"><span>No permission checks yet</span><small>empty</small></div> : null}
        </div>
      </div>
    </section>
  );
}

function SyncView() {
  const { syncRuns } = useAppState();
  const latest = syncRuns[0];
  return (
    <section className="view">
      <ViewHeader title="Remote Sync" detail="Manifest-based local/remote workspace federation." />
      <div className="sync-grid">
        <div className="sync-summary">
          <strong>{latest ? `${latest.direction} ${latest.state}` : "Not synced yet"}</strong>
          <span>{latest?.message ?? "Push this workspace to the configured remote folder or pull the remote manifest back locally."}</span>
          <small>{latest?.remotePath ?? "Default: .polylab/sync/remote"}</small>
          <div className="git-actions">
            <button onClick={() => void runSync("push")}><Cloud size={14} />Push</button>
            <button onClick={() => void runSync("pull")}><Cloud size={14} />Pull</button>
          </div>
        </div>
        <div className="wide-list">
          {syncRuns.map((run) => (
            <div className="run-row" key={run.id} data-status={run.state}>
              <div>
                <strong>{run.direction} / {run.filesCopied} files</strong>
                <span>{run.remotePath}</span>
              </div>
              <small>{new Date(run.finishedAt).toLocaleTimeString()}</small>
              <pre>{run.manifest.files.slice(0, 8).map((file) => `${file.path} ${file.sha256.slice(0, 8)}`).join("\n") || "No tracked files."}</pre>
            </div>
          ))}
          {syncRuns.length === 0 ? <div className="wide-row"><span>No sync runs yet</span><small>idle</small></div> : null}
        </div>
      </div>
    </section>
  );
}

function SimpleView({ title, body }: { title: string; body: string }) {
  return (
    <section className="view">
      <ViewHeader title={title} detail={body} />
      <pre className="simple-body">{body}</pre>
    </section>
  );
}

function CommandPalette({ commands }: { commands: CommandItem[] }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const filtered = commands.filter((command) => `${command.title} ${command.shortcut}`.toLowerCase().includes(query.toLowerCase().trim()));
  const activeCommand = filtered[Math.min(activeIndex, Math.max(0, filtered.length - 1))];

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  return (
    <div className="palette-backdrop" onMouseDown={() => toggleCommand(false)}>
      <div
        className="palette"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((index) => Math.min(filtered.length - 1, index + 1));
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => Math.max(0, index - 1));
          }
          if (event.key === "Enter" && activeCommand) {
            event.preventDefault();
            activeCommand.run();
            toggleCommand(false);
          }
        }}
      >
        <label className="palette-input">
          <Command size={16} />
          <input autoFocus value={query} placeholder="Type a command" onChange={(event) => setQuery(event.target.value)} />
        </label>
        {filtered.map((command, index) => (
          <button
            key={command.id}
            className={index === activeIndex ? "active" : ""}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => {
              command.run();
              toggleCommand(false);
            }}
          >
            <span>{command.title}</span>
            <small>{command.shortcut}</small>
          </button>
        ))}
        {filtered.length === 0 ? <div className="wide-row"><span>No command found</span><small>empty</small></div> : null}
      </div>
    </div>
  );
}

function ViewHeader({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="view-header">
      <h1>{title}</h1>
      <p>{detail}</p>
    </div>
  );
}

function PanelTitle({ icon, label }: { icon: React.ReactNode; label: string }) {
  return <div className="panel-title">{icon}<span>{label}</span></div>;
}

function NavSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="nav-section">
      <div className="nav-section-label">{label}</div>
      {children}
    </div>
  );
}

function MetaList({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <strong>{label}</strong>
      <ul>{items.length > 0 ? items.map((item) => <li key={item}>{item}</li>) : <li>Not recorded</li>}</ul>
    </div>
  );
}

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function useKeyboard(commands: CommandItem[]) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const alt = event.altKey;
      if (!mod) return;
      const key = event.key.toLowerCase();

      const matched = commands.find((command) => {
        const shortcut = command.shortcut.toLowerCase();
        return shortcut.includes(key) && shortcut.includes("cmd") === mod && shortcut.includes("shift") === event.shiftKey && shortcut.includes("option") === alt;
      });

      if (matched) {
        event.preventDefault();
        matched.run();
      }

      if (event.key === "Escape") toggleCommand(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commands]);
}

function setView(activeView: ViewId) {
  updateState((draft) => ({ ...draft, activeView }));
}

function isViewIn(view: ViewId, views: ViewId[]) {
  return views.includes(view);
}

function setTheme(theme: ThemeMode) {
  updateState((draft) => ({ ...draft, theme }));
}

function applyTheme(theme: ThemeMode) {
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

function selectedProject(state: ClientState): ProjectSummary {
  return state.projects.find((project) => project.id === state.selectedProjectId) ?? state.projects[0] ?? initialState.projects[0]!;
}

function threadOptions(state: ClientState) {
  return [
    { id: "general", label: "General", status: "ready", view: "home" as ViewId },
    ...state.agentSessions.slice(0, 7).map((session) => ({
      id: session.id,
      label: session.title,
      status: session.state,
      view: "diff" as ViewId
    }))
  ];
}

function selectedThreadLabel(state: ClientState): string {
  return threadOptions(state).find((thread) => thread.id === state.selectedThreadId)?.label ?? "General";
}

function toggleCommand(commandOpen: boolean) {
  updateState((draft) => ({ ...draft, commandOpen }));
}

function appendLog(message: string) {
  updateState((draft) => ({
    ...draft,
    logs: [{ id: crypto.randomUUID(), target: "local", level: "info", message, createdAt: new Date().toISOString() }, ...draft.logs]
  }));
}

async function hydrate() {
  try {
    const auth = await api<AuthStatus>("/api/auth/status");
    updateState((draft) => ({ ...draft, authStatus: auth }));
    const snapshot = await api<WorkspaceSnapshot>("/api/workspace");
    const serverFormulas = snapshot.formulas.map(normalizeFormula);
    updateState((draft) => ({
      ...draft,
      projects: snapshot.projects,
      formulas: [
        ...draft.formulas.filter((formula) => formula.id.startsWith("local-") && draft.pendingMutations.some((mutation) => mutation.optimisticId === formula.id)),
        ...serverFormulas
      ],
      tasks: snapshot.tasks,
      logs: snapshot.logs,
      executions: snapshot.executions,
      dependencyPlans: snapshot.dependencyPlans,
      cloudProviders: snapshot.cloudProviders,
      cloudJobs: snapshot.cloudJobs,
      cloudLogs: snapshot.cloudLogs,
      deploymentPlans: snapshot.deploymentPlans,
      deploymentMutations: snapshot.deploymentMutations,
      persistence: snapshot.persistence,
      permissions: snapshot.permissions,
      permissionChecks: snapshot.permissionChecks,
      artifacts: snapshot.artifacts,
      benchmarks: snapshot.benchmarks,
      experiments: snapshot.experiments,
      patches: snapshot.patches,
      agentRuntime: snapshot.agentRuntime,
      codexCommandDraft: draft.codexCommandDraft || (snapshot.agentRuntime.codexCommand ?? ""),
      agentHandoffs: snapshot.agentHandoffs,
      agentSessions: snapshot.agentSessions,
      documents: snapshot.documents.map(normalizeDocument),
      syncRuns: snapshot.syncRuns,
      activityEvents: snapshot.activityEvents,
      selectedProjectId: snapshot.projects.some((project) => project.id === draft.selectedProjectId) ? draft.selectedProjectId : snapshot.projects[0]?.id ?? draft.selectedProjectId,
      selectedFormulaId: serverFormulas.some((formula) => formula.id === draft.selectedFormulaId) || draft.formulas.some((formula) => formula.id === draft.selectedFormulaId && formula.id.startsWith("local-"))
        ? draft.selectedFormulaId
        : serverFormulas[0]?.id ?? draft.selectedFormulaId
    }));
    const events = await api<PersistenceEvent[]>("/api/persistence/events?limit=30");
    updateState((draft) => ({ ...draft, persistenceEvents: events }));
    await refreshEditorPresets();
    await refreshWorkspaceFiles(false);
    await flushPendingMutations();
  } catch {
    appendLog("Server unavailable; using cached local state");
  }
}

async function initializePerformanceRuntime() {
  localStorage.setItem("polylab:shell", JSON.stringify({ theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" }));
  const state = await registerPolylabServiceWorker();
  const status = await collectPerformanceStatus();
  updateState((draft) => ({ ...draft, performanceStatus: { ...status, serviceWorkerState: state === "unsupported" ? status.serviceWorkerState : state } }));
}

async function refreshPerformanceStatus() {
  const status = await collectPerformanceStatus();
  updateState((draft) => ({ ...draft, performanceStatus: status }));
}

async function refreshPersistence() {
  try {
    const [persistence, events] = await Promise.all([
      api<PersistenceStatus>("/api/persistence/status"),
      api<PersistenceEvent[]>("/api/persistence/events?limit=50")
    ]);
    updateState((draft) => ({ ...draft, persistence, persistenceEvents: events }));
  } catch {
    appendLog("Persistence refresh failed because the local server is unavailable");
  }
}

async function refreshWorkspaceFiles(showLog = true) {
  try {
    const [files, symbols, diagnostics] = await Promise.all([
      api<WorkspaceFile[]>("/api/files"),
      api<WorkspaceSymbol[]>("/api/files/symbols"),
      api<WorkspaceDiagnostic[]>("/api/files/diagnostics")
    ]);
    updateState((draft) => ({ ...draft, workspaceFiles: files, workspaceSymbols: symbols, workspaceDiagnostics: diagnostics }));
    if (showLog) appendLog(`Indexed ${files.length} workspace entries`);
  } catch {
    if (showLog) appendLog("Workspace file index failed because the local server is unavailable");
  }
}

async function refreshEditorPresets() {
  try {
    const presets = await api<ExternalEditorPreset[]>("/api/editor/presets");
    updateState((draft) => ({
      ...draft,
      editorPresets: presets,
      selectedEditorPresetId: presets.some((preset) => preset.id === draft.selectedEditorPresetId)
        ? draft.selectedEditorPresetId
        : presets[0]?.id ?? draft.selectedEditorPresetId
    }));
  } catch {
    appendLog("Editor presets failed because the local server is unavailable");
  }
}

async function openExternalEditor() {
  const { editorFile, selectedEditorPresetId } = store.getSnapshot();
  if (!editorFile) return;
  try {
    const launch = await api<ExternalEditorLaunch>("/api/editor/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presetId: selectedEditorPresetId, path: editorFile.path, line: 1, column: 1 })
    });
    appendLog(launch.message);
  } catch {
    appendLog("External editor launch failed. Check that the selected editor command is installed.");
  }
}

async function openWorkspaceRoot() {
  const { selectedEditorPresetId } = store.getSnapshot();
  try {
    const launch = await api<ExternalEditorLaunch>("/api/editor/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presetId: selectedEditorPresetId })
    });
    appendLog(launch.message);
  } catch {
    appendLog("Project open failed. Check the editor preset in Settings.");
  }
}

async function previewArtifact(id: string) {
  setView("artifacts");
  try {
    const preview = await api<ArtifactContent>(`/api/artifacts/${id}/read`);
    updateState((draft) => ({ ...draft, artifactPreview: preview }));
  } catch {
    appendLog("Artifact preview failed because the local server is unavailable or the artifact is not previewable");
  }
}

async function openWorkspaceFile(path: string) {
  try {
    const file = await api<WorkspaceFileContent>(`/api/files/read?path=${encodeURIComponent(path)}`);
    updateState((draft) => ({
      ...draft,
      selectedFilePath: file.path,
      editorFile: file,
      editorTabs: [file, ...draft.editorTabs.filter((tab) => tab.path !== file.path)].slice(0, 8)
    }));
  } catch {
    appendLog(`Could not open ${path}`);
  }
}

function selectEditorTab(path: string) {
  updateState((draft) => {
    const tab = draft.editorTabs.find((item) => item.path === path);
    return tab ? { ...draft, selectedFilePath: tab.path, editorFile: tab } : draft;
  });
}

function updateEditorContent(content: string) {
  updateState((draft) => {
    if (!draft.editorFile) return draft;
    const editorFile = { ...draft.editorFile, content };
    return {
      ...draft,
      editorFile,
      editorTabs: draft.editorTabs.map((tab) => tab.path === editorFile.path ? editorFile : tab)
    };
  });
}

async function saveEditorFile() {
  const file = store.getSnapshot().editorFile;
  if (!file) return;
  try {
    const saved = await api<WorkspaceFileContent>("/api/files/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: file.path, content: file.content })
    });
    updateState((draft) => ({
      ...draft,
      selectedFilePath: saved.path,
      editorFile: saved,
      editorTabs: [saved, ...draft.editorTabs.filter((tab) => tab.path !== saved.path)].slice(0, 8)
    }));
    await refreshWorkspaceFiles(false);
    appendLog(`Saved ${saved.path}`);
  } catch {
    appendLog(`Save failed for ${file.path}`);
  }
}

async function verifyActiveFormula() {
  const { selectedFormulaId } = store.getSnapshot();
  setView("verify");
  appendLog(`Verifying ${selectedFormulaId}`);
  try {
    const updated = await api<FormulaCard>(`/api/formulas/${selectedFormulaId}/verify`, { method: "POST" });
    updateState((draft) => ({
      ...draft,
      formulas: draft.formulas.map((formula) => formula.id === updated.id ? updated : formula)
    }));
  } catch {
    appendLog("Verification failed because the local server is unavailable");
  }
}

async function generatePatch(formulaId?: string) {
  const { selectedFormulaId } = store.getSnapshot();
  const id = formulaId ?? selectedFormulaId;
  setView("diff");
  appendLog(`Generating patch for ${id}`);
  try {
    const patch = await api<PatchReview>(`/api/formulas/${id}/generate`, { method: "POST" });
    updateState((draft) => ({ ...draft, patches: [patch, ...draft.patches.filter((item) => item.id !== patch.id)] }));
  } catch {
    appendLog("Patch generation failed because the local server is unavailable");
  }
}

async function runAgentWorkflow() {
  const { selectedFormulaId } = store.getSnapshot();
  appendLog(`Starting Pi mono workflow for ${selectedFormulaId}`);
  try {
    const session = await api<AgentSession>("/api/agents/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ formulaId: selectedFormulaId, title: "Formula to verified patch" })
    });
    updateState((draft) => ({ ...draft, agentSessions: [session, ...draft.agentSessions.filter((item) => item.id !== session.id)] }));
    const updated = await api<AgentSession>(`/api/agents/sessions/${session.id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ formulaId: selectedFormulaId, message: "Run formula to verified patch workflow" })
    });
    updateState((draft) => ({
      ...draft,
      activeView: "diff",
      agentSessions: [updated, ...draft.agentSessions.filter((item) => item.id !== updated.id)]
    }));
    await hydrate();
  } catch {
    appendLog("Pi mono workflow failed because the local server is unavailable");
  }
}

async function saveAgentRuntimeConfig() {
  const command = store.getSnapshot().codexCommandDraft.trim();
  appendLog(command ? "Saving Codex command for Pi mono" : "Clearing Codex command for Pi mono");
  try {
    const runtime = await api<AgentRuntimeConfig>("/api/agents/runtime", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        codexCommand: command,
        state: command ? "configured" : "not-configured",
        credentialHint: command ? "Codex command configured through PolyLab settings." : initialState.agentRuntime.credentialHint
      })
    });
    updateState((draft) => ({ ...draft, agentRuntime: runtime, codexCommandDraft: runtime.codexCommand ?? "" }));
    await hydrate();
  } catch {
    appendLog("Codex runtime configuration failed because the local server is unavailable");
  }
}

async function exportAgentReplay(sessionId: string) {
  appendLog(`Exporting agent replay ${sessionId}`);
  try {
    const session = await api<AgentSession>(`/api/agents/sessions/${sessionId}/export-replay`, { method: "POST" });
    updateState((draft) => ({
      ...draft,
      agentSessions: [session, ...draft.agentSessions.filter((item) => item.id !== session.id)]
    }));
    await hydrate();
  } catch {
    appendLog("Agent replay export failed because the local server is unavailable");
  }
}

async function dispatchAgentHandoff(sessionId: string) {
  appendLog(`Preparing Codex handoff ${sessionId}`);
  try {
    const handoff = await api<AgentHandoff>(`/api/agents/sessions/${sessionId}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Continue this PolyLab session through Codex." })
    });
    updateState((draft) => ({
      ...draft,
      agentHandoffs: [handoff, ...draft.agentHandoffs.filter((item) => item.id !== handoff.id)]
    }));
    await hydrate();
  } catch {
    appendLog("Codex handoff failed because permissions, command, or the local server are unavailable");
  }
}

async function decideHunk(patchId: string, hunkId: string, decision: "accepted" | "rejected") {
  try {
    const patch = await api<PatchReview>(`/api/patches/${patchId}/hunks/${hunkId}/${decision}`, { method: "POST" });
    updateState((draft) => ({
      ...draft,
      patches: draft.patches.map((item) => item.id === patch.id ? patch : item)
    }));
    await hydrate();
  } catch {
    appendLog(`Patch hunk ${decision} failed`);
  }
}

async function acceptFirstPendingHunk() {
  const patch = store.getSnapshot().patches.find((item) => item.hunks.some((hunk) => hunk.status === "pending"));
  const hunk = patch?.hunks.find((item) => item.status === "pending");
  if (!patch || !hunk) {
    appendLog("No pending patch hunk to apply");
    return;
  }
  await decideHunk(patch.id, hunk.id, "accepted");
}

async function runExperiment() {
  setView("experiment");
  appendLog("Running local experiment");
  try {
    const experiment = await api<ExperimentRun>("/api/experiments/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Local simulation experiment", target: "auto", command: "echo PolyLab local execution ready", estimatedSeconds: 1, memoryMb: 64 })
    });
    updateState((draft) => ({ ...draft, experiments: [experiment, ...draft.experiments.filter((item) => item.id !== experiment.id)] }));
    await hydrate();
  } catch {
    appendLog("Experiment stayed local-only because the server is unavailable");
  }
}

async function runSandboxExperiment() {
  setView("experiment");
  appendLog("Running Docker sandbox experiment");
  try {
    const experiment = await api<ExperimentRun>("/api/experiments/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Docker sandbox simulation", target: "auto", sandbox: "docker", command: "python3 -c 'print(\"PolyLab docker sandbox ready\")'", estimatedSeconds: 1, memoryMb: 128, allowNetwork: false })
    });
    updateState((draft) => ({ ...draft, experiments: [experiment, ...draft.experiments.filter((item) => item.id !== experiment.id)] }));
    await hydrate();
  } catch {
    appendLog("Docker sandbox run failed because the local server is unavailable");
  }
}

async function scanDependencies() {
  setView("logs");
  appendLog("Scanning workspace dependencies");
  try {
    const plan = await api<DependencyPlan>("/api/dependencies/scan", { method: "POST" });
    updateState((draft) => ({ ...draft, dependencyPlans: [plan, ...draft.dependencyPlans.filter((item) => item.id !== plan.id)] }));
    await hydrate();
  } catch {
    appendLog("Dependency scan failed because the local server is unavailable");
  }
}

async function applyDependencyPlan(planId: string) {
  setView("logs");
  appendLog(`Applying dependency plan ${planId}`);
  try {
    const plan = await api<DependencyPlan>(`/api/dependencies/plans/${planId}/apply`, { method: "POST" });
    updateState((draft) => ({ ...draft, dependencyPlans: [plan, ...draft.dependencyPlans.filter((item) => item.id !== plan.id)] }));
    await hydrate();
  } catch {
    appendLog("Dependency install plan failed because permissions, installer, or the local server are unavailable");
  }
}

async function runCloudJob() {
  setView("cloud");
  appendLog("Queueing cloud GPU job");
  try {
    const run = await api<ExecutionRun>("/api/execution/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "auto", command: "python3 experiments/train.py", gpuRequired: true, estimatedSeconds: 1200, memoryMb: 32768 })
    });
    updateState((draft) => ({ ...draft, executions: [run, ...draft.executions.filter((item) => item.id !== run.id)] }));
    await hydrate();
  } catch {
    appendLog("Cloud job queueing failed because the local server is unavailable");
  }
}

async function runNotebookCloudJob() {
  setView("cloud");
  appendLog("Queueing Google notebook job");
  try {
    const run = await api<ExecutionRun>("/api/execution/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "auto", command: "python3 notebooks/lesson.py", notebook: true, estimatedSeconds: 900, memoryMb: 4096 })
    });
    updateState((draft) => ({ ...draft, executions: [run, ...draft.executions.filter((item) => item.id !== run.id)] }));
    await hydrate();
  } catch {
    appendLog("Google notebook queueing failed because the local server is unavailable");
  }
}

async function storeProviderCredential(provider: CloudProviderConfig, value: string, clearDraft: (next: string) => void) {
  const credentials = window.polylabDesktop?.credentials;
  if (!credentials?.saveCredential) {
    appendLog("Protected provider credential storage is unavailable in this session");
    return;
  }
  const name = `provider:${provider.id}`;
  const result = await credentials.saveCredential(name, value);
  const status = await credentials.status();
  if (!result.ok) {
    updateState((draft) => ({
      ...draft,
      credentialStatus: {
        available: status.available,
        backend: status.backend ?? "unknown",
        message: credentialMessage(result.reason, status.available)
      }
    }));
    return;
  }
  clearDraft("");
  try {
    const updated = await api<CloudProviderConfig>("/api/cloud/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: provider.id, state: "configured", credentialHint: `Protected desktop credential: ${name}` })
    });
    updateState((draft) => ({
      ...draft,
      cloudProviders: [updated, ...draft.cloudProviders.filter((item) => item.id !== updated.id)],
      credentialStatus: {
        available: status.available,
        backend: status.backend ?? "unknown",
        message: `Protected ${provider.name} credential stored.`
      }
    }));
    await hydrate();
  } catch {
    updateState((draft) => ({
      ...draft,
      credentialStatus: {
        available: status.available,
        backend: status.backend ?? "unknown",
        message: `Protected ${provider.name} credential stored locally; provider configuration is pending.`
      }
    }));
  }
}

async function clearProviderCredential(provider: CloudProviderConfig) {
  const credentials = window.polylabDesktop?.credentials;
  if (!credentials?.clearCredential) {
    appendLog("Protected provider credential storage is unavailable in this session");
    return;
  }
  const result = await credentials.clearCredential(`provider:${provider.id}`);
  const status = await credentials.status();
  updateState((draft) => ({
    ...draft,
    credentialStatus: {
      available: status.available,
      backend: status.backend ?? "unknown",
      message: result.ok ? `Protected ${provider.name} credential cleared.` : credentialMessage(result.reason, status.available)
    }
  }));
}

async function dispatchCloudJob(jobId: string) {
  setView("cloud");
  appendLog(`Dispatching cloud job ${jobId}`);
  try {
    const result = await api<CloudDispatchResult>(`/api/cloud/jobs/${jobId}/dispatch`, { method: "POST" });
    updateState((draft) => ({
      ...draft,
      cloudJobs: [result.job, ...draft.cloudJobs.filter((job) => job.id !== result.job.id)],
      cloudLogs: [...result.logs, ...draft.cloudLogs.filter((log) => log.jobId !== result.job.id)]
    }));
    await hydrate();
  } catch {
    appendLog("Cloud dispatch failed because the provider command or credentials are unavailable");
  }
}

async function cancelCloudJob(jobId: string) {
  setView("cloud");
  appendLog(`Cancelling cloud job ${jobId}`);
  try {
    const result = await api<CloudDispatchResult>(`/api/cloud/jobs/${jobId}/cancel`, { method: "POST" });
    updateState((draft) => ({
      ...draft,
      cloudJobs: [result.job, ...draft.cloudJobs.filter((job) => job.id !== result.job.id)],
      cloudLogs: [...result.logs, ...draft.cloudLogs]
    }));
    await hydrate();
  } catch {
    appendLog("Cloud cancellation failed because the local server is unavailable");
  }
}

async function createDeploymentPlan() {
  setView("deploy");
  appendLog("Generating deployment plan");
  try {
    const plan = await api<DeploymentPlan>("/api/deployment/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Standalone PolyLab server",
        dnsTarget: "203.0.113.10",
        routes: [
          { host: "studio.example.com", upstream: "127.0.0.1:3917", tls: "auto" },
          { host: "api.example.com", upstream: "127.0.0.1:3917", tls: "auto" }
        ]
      })
    });
    updateState((draft) => ({ ...draft, deploymentPlans: [plan, ...draft.deploymentPlans.filter((item) => item.id !== plan.id)] }));
    await hydrate();
  } catch {
    appendLog("Deployment plan generation failed because the local server is unavailable");
  }
}

async function applyDeploymentPlan(planId: string, applyDns: boolean) {
  setView("deploy");
  appendLog(applyDns ? "Applying deployment plan with DNS" : "Applying deployment plan");
  try {
    const result = await api<DeploymentApplyResult>(`/api/deployment/plans/${planId}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ applyDns })
    });
    updateState((draft) => ({
      ...draft,
      deploymentPlans: [result.plan, ...draft.deploymentPlans.filter((item) => item.id !== result.plan.id)],
      deploymentMutations: [...result.mutations, ...draft.deploymentMutations.filter((item) => item.planId !== result.plan.id || !result.mutations.some((mutation) => mutation.id === item.id))]
    }));
    await hydrate();
  } catch {
    appendLog("Deployment apply failed because the local server is unavailable or infrastructure credentials are missing");
  }
}

async function rollbackDeploymentPlan(planId: string) {
  setView("deploy");
  appendLog("Rolling back deployment plan");
  try {
    const result = await api<DeploymentApplyResult>(`/api/deployment/plans/${planId}/rollback`, { method: "POST" });
    updateState((draft) => ({
      ...draft,
      deploymentPlans: [result.plan, ...draft.deploymentPlans.filter((item) => item.id !== result.plan.id)],
      deploymentMutations: [...result.mutations, ...draft.deploymentMutations]
    }));
    await hydrate();
  } catch {
    appendLog("Deployment rollback failed because no rollback artifact is available");
  }
}

async function runBenchmark() {
  setView("benchmark");
  appendLog("Running local benchmark");
  try {
    const benchmark = await api<BenchmarkRun>("/api/benchmarks/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Local execution benchmark", command: "echo PolyLab benchmark ready", iterations: 3, target: "auto" })
    });
    updateState((draft) => ({ ...draft, benchmarks: [benchmark, ...draft.benchmarks.filter((item) => item.id !== benchmark.id)] }));
    await hydrate();
  } catch {
    appendLog("Benchmark failed because the local server is unavailable");
  }
}

async function runNotebookCell(documentId: string, cellId: string) {
  appendLog("Running notebook cell");
  try {
    const document = await api<ResearchDocument>(`/api/documents/${documentId}/cells/${cellId}/run`, { method: "POST" });
    updateState((draft) => ({ ...draft, documents: draft.documents.map((item) => item.id === document.id ? document : item) }));
    await hydrate();
  } catch {
    appendLog("Notebook cell failed because the local server is unavailable");
  }
}

async function exportNotebook(documentId: string) {
  appendLog("Exporting notebook script");
  try {
    const exported = await api<{ path: string }>(`/api/documents/${documentId}/export-script`, { method: "POST" });
    appendLog(`Exported ${exported.path}`);
  } catch {
    appendLog("Notebook export failed because the local server is unavailable");
  }
}

async function exportDocumentPdf(documentId: string) {
  appendLog("Exporting document PDF");
  try {
    const exported = await api<{ document: ResearchDocument; artifact: ArtifactRecord }>(`/api/documents/${documentId}/export-pdf`, { method: "POST" });
    updateState((draft) => ({
      ...draft,
      documents: draft.documents.map((item) => item.id === exported.document.id ? normalizeDocument(exported.document) : item),
      artifacts: [exported.artifact, ...draft.artifacts.filter((artifact) => artifact.id !== exported.artifact.id)]
    }));
    appendLog(`Exported PDF ${exported.artifact.path}`);
  } catch {
    appendLog("PDF export failed because the local server is unavailable");
  }
}

async function createFormula() {
  const title = `Formula ${new Date().toLocaleTimeString()}`;
  const optimisticId = `local-${crypto.randomUUID()}`;
  const mutationId = crypto.randomUUID();
  const body: Partial<FormulaCard> = {
    title,
    equation: "y = f(x)",
    variables: ["x", "y"],
    assumptions: ["local draft"],
    inputShapes: ["x: scalar"],
    outputShapes: ["y: scalar"],
    constraints: ["x is finite"]
  };
  const optimisticFormula = normalizeFormula({
    ...body,
    id: optimisticId,
    status: "queued"
  });
  const mutation: LocalMutation = {
    id: mutationId,
    type: "create-formula",
    method: "POST",
    path: "/api/formulas",
    body,
    status: "pending",
    attempts: 0,
    createdAt: new Date().toISOString(),
    optimisticId
  };
  appendLog(`Creating ${title}`);
  updateState((draft) => ({
    ...draft,
    activeView: "math",
    selectedFormulaId: optimisticId,
    formulas: [optimisticFormula, ...draft.formulas],
    pendingMutations: enqueueMutation(draft.pendingMutations, mutation)
  }));
  try {
    const created = await api<FormulaCard>(mutation.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    updateState((draft) => ({
      ...draft,
      activeView: "math",
      selectedFormulaId: created.id,
      formulas: reconcileOptimisticFormula(draft.formulas, optimisticId, normalizeFormula(created)),
      pendingMutations: markMutationSynced(draft.pendingMutations, mutationId)
    }));
  } catch {
    updateState((draft) => ({ ...draft, pendingMutations: markMutationFailed(draft.pendingMutations, mutationId, "Server unavailable or permission denied") }));
    appendLog("Formula creation queued locally; it will retry when the server is available");
  }
}

async function flushPendingMutations() {
  const mutations = store.getSnapshot().pendingMutations.filter((mutation) => mutation.type === "create-formula");
  for (const mutation of mutations) {
    try {
      const created = await api<FormulaCard>(mutation.path, {
        method: mutation.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mutation.body)
      });
      updateState((draft) => ({
        ...draft,
        selectedFormulaId: draft.selectedFormulaId === mutation.optimisticId ? created.id : draft.selectedFormulaId,
        formulas: reconcileOptimisticFormula(draft.formulas, mutation.optimisticId ?? created.id, normalizeFormula(created)),
        pendingMutations: markMutationSynced(draft.pendingMutations, mutation.id)
      }));
    } catch (error) {
      updateState((draft) => ({ ...draft, pendingMutations: markMutationFailed(draft.pendingMutations, mutation.id, error instanceof Error ? error.message : "Mutation retry failed") }));
    }
  }
}

function normalizeFormula(formula: Partial<FormulaCard>): FormulaCard {
  return {
    ...formula,
    id: formula.id ?? crypto.randomUUID(),
    title: formula.title ?? "Untitled Formula",
    equation: formula.equation ?? "y = f(x)",
    variables: formula.variables ?? [],
    assumptions: formula.assumptions ?? [],
    inputShapes: formula.inputShapes ?? [],
    outputShapes: formula.outputShapes ?? [],
    constraints: formula.constraints ?? [],
    generatedImplementations: formula.generatedImplementations ?? [],
    verificationHistory: formula.verificationHistory ?? [],
    status: formula.status ?? "queued"
  };
}

function normalizeDocument(document: ResearchDocument): ResearchDocument {
  return {
    ...document,
    cells: document.cells ?? [],
    citationKeys: document.citationKeys ?? [],
    bibliography: document.bibliography ?? []
  };
}

function defaultChecks(formula?: FormulaCard) {
  return ["symbolic", "sympy", "wolfram", "property-based", "metamorphic", "robustness-sweep", "autodiff", "robotics-kinematics", "robotics-dynamics", "reproducibility", "model-evaluation", "distributed-training", "interval-bounds", "smt", "runtime-provider-parity", "numerical", "shape", "dimensional", "gradient", "stability", "runtime-parity", "cross-language-parity", "benchmark-validation"].map((name) => ({
    name: name as VerificationCheck["name"],
    status: formula?.status ?? "queued",
    detail: formula?.lastCheckedAt ? `Last checked ${new Date(formula.lastCheckedAt).toLocaleTimeString()}.` : "Waiting for verification."
  }));
}

async function refreshGit(setStatus: (status: GitStatus) => void, setDiff: (diff: string) => void) {
  try {
    const [status, diff] = await Promise.all([
      api<GitStatus>("/api/git/status"),
      api<{ diff: string }>("/api/git/diff")
    ]);
    setStatus(status);
    setDiff(diff.diff);
  } catch {
    appendLog("Git status failed because the local server is unavailable");
  }
}

async function refreshGitRefs(setRemotes: (remotes: GitRemote[]) => void, setBranches: (branches: string[]) => void) {
  try {
    const [remotes, branches] = await Promise.all([
      api<GitRemote[]>("/api/git/remotes"),
      api<string[]>("/api/git/branches")
    ]);
    setRemotes(remotes);
    setBranches(branches);
  } catch {
    setRemotes([]);
    setBranches([]);
  }
}

async function refreshGitVerification(setVerificationSummary: (summary: GitVerificationSummary) => void) {
  try {
    setVerificationSummary(await api<GitVerificationSummary>("/api/git/verification-summary"));
  } catch {
    appendLog("Git verification summary failed because the local server is unavailable");
  }
}

async function initGit(setStatus: (status: GitStatus) => void, setDiff: (diff: string) => void) {
  try {
    const status = await api<GitStatus>("/api/git/init", { method: "POST" });
    setStatus(status);
    setDiff("");
    appendLog("Initialized Git repository");
  } catch {
    appendLog("Git init failed because the local server is unavailable");
  }
}

async function createGitBranch(branch: string, setStatus: (status: GitStatus) => void, setRemotes: (remotes: GitRemote[]) => void, setBranches: (branches: string[]) => void) {
  try {
    const result = await api<GitOperationResult>("/api/git/branch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: branch })
    });
    if (result.status) setStatus(result.status);
    if (result.branches) setBranches(result.branches);
    await refreshGitRefs(setRemotes, setBranches);
    appendLog(result.message);
  } catch {
    appendLog("Git branch failed because the local server is unavailable");
  }
}

async function addGitRemote(remoteUrl: string, setStatus: (status: GitStatus) => void, setRemotes: (remotes: GitRemote[]) => void, setBranches: (branches: string[]) => void) {
  try {
    const result = await api<GitOperationResult>("/api/git/remote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "origin", url: remoteUrl })
    });
    if (result.status) setStatus(result.status);
    if (result.remotes) setRemotes(result.remotes);
    await refreshGitRefs(setRemotes, setBranches);
    appendLog(result.message);
  } catch {
    appendLog("Git remote failed because the local server is unavailable");
  }
}

async function pushGit(setStatus: (status: GitStatus) => void, setDiff: (diff: string) => void, setRemotes: (remotes: GitRemote[]) => void, setBranches: (branches: string[]) => void) {
  try {
    const result = await api<GitOperationResult>("/api/git/push", { method: "POST" });
    if (result.status) setStatus(result.status);
    setDiff("");
    await refreshGitRefs(setRemotes, setBranches);
    appendLog(result.message);
  } catch {
    appendLog("Git push failed");
  }
}

async function pullGit(setStatus: (status: GitStatus) => void, setDiff: (diff: string) => void, setRemotes: (remotes: GitRemote[]) => void, setBranches: (branches: string[]) => void) {
  try {
    const result = await api<GitOperationResult>("/api/git/pull", { method: "POST" });
    if (result.status) setStatus(result.status);
    const diff = await api<{ diff: string }>("/api/git/diff");
    setDiff(diff.diff);
    await refreshGitRefs(setRemotes, setBranches);
    appendLog(result.message);
  } catch {
    appendLog("Git pull failed");
  }
}

async function resolveGitConflict(conflict: GitConflict, strategy: "ours" | "theirs", setStatus: (status: GitStatus) => void, setDiff: (diff: string) => void) {
  try {
    const result = await api<GitOperationResult>("/api/git/conflicts/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: conflict.path, strategy })
    });
    if (result.status) setStatus(result.status);
    const diff = await api<{ diff: string }>("/api/git/diff");
    setDiff(diff.diff);
    appendLog(result.message);
  } catch {
    appendLog(`Git conflict resolution failed for ${conflict.path}`);
  }
}

async function resolveAllConflicts(setStatus: (status: GitStatus) => void, setDiff: (diff: string) => void, strategy: "ours" | "theirs") {
  const conflicts = (await api<GitConflict[]>("/api/git/conflicts").catch(() => []));
  for (const conflict of conflicts) {
    await resolveGitConflict(conflict, strategy, setStatus, setDiff);
  }
}

async function cloneGit(remoteUrl: string) {
  try {
    const result = await api<GitOperationResult>("/api/git/clone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: remoteUrl, directory: "cloned-project" })
    });
    appendLog(result.message);
  } catch {
    appendLog("Git clone failed");
  }
}

async function stageGit(setStatus: (status: GitStatus) => void, setDiff: (diff: string) => void) {
  try {
    const status = await api<GitStatus>("/api/git/stage", { method: "POST" });
    setStatus(status);
    const diff = await api<{ diff: string }>("/api/git/diff");
    setDiff(diff.diff);
    appendLog("Staged workspace changes");
  } catch {
    appendLog("Git stage failed because the local server is unavailable");
  }
}

async function commitGit(message: string, setStatus: (status: GitStatus) => void, setDiff: (diff: string) => void) {
  try {
    const result = await api<GitCommitResult>("/api/git/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message })
    });
    setStatus(result.status);
    setDiff("");
    appendLog(result.ok ? `Committed ${result.hash}` : result.message);
  } catch {
    appendLog("Git commit failed because the local server is unavailable");
  }
}

async function runSync(direction: "push" | "pull") {
  setView("sync");
  appendLog(`Starting sync ${direction}`);
  try {
    const run = await api<SyncRun>(`/api/sync/${direction}`, { method: "POST" });
    updateState((draft) => ({ ...draft, syncRuns: [run, ...draft.syncRuns.filter((item) => item.id !== run.id)] }));
    await hydrate();
  } catch {
    appendLog(`Sync ${direction} failed because the local server is unavailable`);
  }
}

createRoot(document.getElementById("root")!).render(<App />);
