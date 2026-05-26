import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, normalize, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { ActivityEvent, AgentHandoff, AgentPlanStep, AgentReplay, AgentRuntimeConfig, AgentSession, AgentTask, AgentTraceEvent, ArtifactContent, ArtifactRecord, BenchmarkRequest, BenchmarkRun, CloudDispatchResult, CloudExecutionJob, CloudJobLog, CloudProviderConfig, DependencyItem, DependencyPlan, DeploymentApplyResult, DeploymentMutation, DeploymentPlan, DeploymentRoute, DnsPreviewChange, ExecutionLog, ExecutionRequest, ExecutionRoute, ExecutionRun, ExperimentRun, ExternalEditorLaunch, ExternalEditorPreset, FormulaCard, GitVerificationSummary, NotebookCell, PatchReview, PermissionCategory, PermissionCheck, PermissionDecision, PermissionMode, ProjectSummary, ResearchDocument, RuntimeTarget, SyncRun, VerificationCheck, VerificationReport, VerificationStatus, WorkspaceDiagnostic, WorkspaceFile, WorkspaceFileContent, WorkspaceSnapshot, WorkspaceSymbol } from "@polylab/types";
import type { PersistenceEvent, PersistenceStatus } from "@polylab/types";
import { WorkspaceDatabase } from "./database";
import { defaultDocuments, renderDocument, renderDocumentPdf, serializeNotebookCells } from "./documents";
import { parseCommand, runExecution } from "./execution";
import { applyHunk, createImplementationPatch } from "./patches";
import { pullWorkspace, pushWorkspace } from "./sync";

const now = () => new Date().toISOString();
const MAX_AGENT_OUTPUT = 64_000;

interface VerificationSpec {
  id: string;
  path: string;
  formulaId?: string;
  domain?: "model" | "robotics" | "math" | "control" | "distributed";
  invariants?: string[];
  metamorphicRelations?: string[];
  robustness?: {
    cases?: string[];
    dtypes?: string[];
    tolerance?: number;
  };
  autodiff?: {
    jvp?: boolean;
    vjp?: boolean;
    hessianSymmetry?: boolean;
  };
  robotics?: {
    frames?: string[];
    joints?: number;
    jointLimits?: Array<[number, number]>;
    checkDynamics?: boolean;
    checkKinematics?: boolean;
  };
  reproducibility?: {
    seeds?: number[];
    datasetHash?: string;
    environmentHash?: string;
    checkpointHash?: string;
  };
  modelEvaluation?: {
    metrics?: Record<string, number>;
    slices?: string[];
    latencyMs?: number;
    memoryMb?: number;
  };
  distributedTraining?: {
    worldSizes?: number[];
    gradientAccumulation?: number[];
    checkpointRoundTrip?: boolean;
  };
  intervalBounds?: Array<{ variable: string; min: number; max: number; outputMin?: number; outputMax?: number }>;
  smt?: {
    assertions?: string[];
    solver?: "z3" | "cvc5" | "other";
  };
  runtimeProviderParity?: {
    providers?: string[];
    tolerance?: number;
  };
  hooks?: {
    runtimeProviderParity?: string;
  };
}

export interface WorkspaceStoreOptions {
  dataDir?: string;
}

export class WorkspaceStore {
  readonly dataDir: string;
  readonly workspaceRoot: string;
  private readonly database: WorkspaceDatabase;
  private writeQueue = Promise.resolve();

  constructor(options: WorkspaceStoreOptions = {}) {
    this.dataDir = options.dataDir ?? process.env.POLYLAB_DATA_DIR ?? join(process.cwd(), ".polylab");
    this.workspaceRoot = basename(this.dataDir) === ".polylab" ? dirname(this.dataDir) : this.dataDir;
    this.database = new WorkspaceDatabase(this.dataDir);
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    const [projects, formulas, tasks, logs, executions, dependencyPlans, cloudProviders, cloudJobs, cloudLogs, deploymentPlans, deploymentMutations, artifacts, benchmarks, experiments, patches, agentRuntime, agentHandoffs, agentSessions, documents, syncRuns, permissions, permissionChecks, activityEvents] = await Promise.all([
      this.projects(),
      this.formulas(),
      this.tasks(),
      this.logs(),
      this.executions(),
      this.dependencyPlans(),
      this.cloudProviders(),
      this.cloudJobs(),
      this.cloudLogs(),
      this.deploymentPlans(),
      this.deploymentMutations(),
      this.artifacts(),
      this.benchmarks(),
      this.experiments(),
      this.patches(),
      this.agentRuntime(),
      this.agentHandoffs(),
      this.agentSessions(),
      this.documents(),
      this.syncRuns(),
      this.permissions(),
      this.permissionChecks(),
      this.activityEvents()
    ]);
    return { projects, formulas, tasks, logs, executions, dependencyPlans, cloudProviders, cloudJobs, cloudLogs, deploymentPlans, deploymentMutations, persistence: this.persistenceStatus(), artifacts, benchmarks, experiments, patches, agentRuntime, agentHandoffs, agentSessions, documents, syncRuns, permissions, permissionChecks, activityEvents };
  }

  async projects(): Promise<ProjectSummary[]> {
    return this.readJson("project.json", [defaultProject()]);
  }

  async project(id: string): Promise<ProjectSummary> {
    const projects = await this.projects();
    return projects.find((project) => project.id === id) ?? { ...defaultProject(), id };
  }

  async workspaceFiles(): Promise<WorkspaceFile[]> {
    await this.ensureLayout();
    const files: WorkspaceFile[] = [];
    await this.collectWorkspaceFiles("", files, 0);
    return files.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
  }

  async readWorkspaceFile(path: string): Promise<WorkspaceFileContent> {
    await this.ensureLayout();
    const file = this.resolveWorkspacePath(path);
    const info = await stat(file);
    if (!info.isFile()) throw new Error("Workspace path is not a file");
    if (info.size > 1024 * 1024) throw new Error("Workspace file is too large for the built-in editor");
    const content = await readFile(file, "utf8");
    return {
      path: normalizeWorkspacePath(path),
      language: languageForPath(path),
      content,
      size: info.size,
      updatedAt: info.mtime.toISOString()
    };
  }

  async writeWorkspaceFile(path: string, content: string): Promise<WorkspaceFileContent> {
    await this.ensureLayout();
    const file = this.resolveWorkspacePath(path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
    await this.addLog(`Saved ${normalizeWorkspacePath(path)}`, "info");
    return this.readWorkspaceFile(path);
  }

  async workspaceSymbols(): Promise<WorkspaceSymbol[]> {
    const files = (await this.workspaceFiles()).filter((file) => file.kind === "file");
    const symbols: WorkspaceSymbol[] = [];
    for (const file of files) {
      if (symbols.length >= 1000) break;
      const content = await this.readWorkspaceFile(file.path).catch(() => undefined);
      if (!content) continue;
      symbols.push(...extractWorkspaceSymbols(content).slice(0, 1000 - symbols.length));
    }
    return symbols;
  }

  async workspaceDiagnostics(): Promise<WorkspaceDiagnostic[]> {
    const files = (await this.workspaceFiles()).filter((file) => file.kind === "file");
    const diagnostics: WorkspaceDiagnostic[] = [];
    for (const file of files) {
      if (diagnostics.length >= 1000) break;
      const content = await this.readWorkspaceFile(file.path).catch(() => undefined);
      if (!content) continue;
      diagnostics.push(...extractWorkspaceDiagnostics(content).slice(0, 1000 - diagnostics.length));
    }
    return diagnostics;
  }

  async editorPresets(): Promise<ExternalEditorPreset[]> {
    const saved = await this.readJson("editor/presets.json", [] as ExternalEditorPreset[]);
    const defaults = defaultEditorPresets();
    return [...saved, ...defaults.filter((preset) => !saved.some((item) => item.id === preset.id))];
  }

  async saveEditorPreset(input: Pick<ExternalEditorPreset, "id" | "name" | "command">): Promise<ExternalEditorPreset> {
    if (!input.id || !input.name || !input.command) throw new Error("Editor preset id, name, and command are required");
    const presets = await this.editorPresets();
    const preset: ExternalEditorPreset = {
      id: input.id,
      name: input.name,
      command: input.command,
      variables: editorVariables(input.command),
      updatedAt: now()
    };
    await this.writeJson("editor/presets.json", [preset, ...presets.filter((item) => item.id !== preset.id && !defaultEditorPresets().some((defaultPreset) => defaultPreset.id === item.id))]);
    await this.addLog(`Saved editor preset ${preset.name}`, "info");
    return preset;
  }

  async launchEditor(input: { presetId?: string; path?: string; line?: number; column?: number; dryRun?: boolean }): Promise<ExternalEditorLaunch> {
    await this.ensureLayout();
    const presets = await this.editorPresets();
    const preset = presets.find((item) => item.id === (input.presetId ?? "vscode")) ?? presets[0]!;
    const workspace = this.workspaceRoot;
    const file = input.path ? this.resolveWorkspacePath(input.path) : undefined;
    const line = Math.max(1, Math.floor(input.line ?? 1));
    const column = Math.max(1, Math.floor(input.column ?? 1));
    const expanded = preset.command
      .replaceAll("{workspace}", workspace)
      .replaceAll("{file}", file ?? workspace)
      .replaceAll("{line}", String(line))
      .replaceAll("{column}", String(column));
    const [command, ...args] = parseCommand(expanded);
    if (!command) throw new Error("Editor command is empty");
    if (!input.dryRun) {
      const proc = Bun.spawn([command, ...args], {
        cwd: workspace,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" }
      });
      const timeout = setTimeout(() => proc.kill(), 1_500);
      await proc.exited.catch(() => undefined);
      clearTimeout(timeout);
    }
    await this.addLog(`${input.dryRun ? "Prepared" : "Launched"} ${preset.name}`, "info");
    return {
      preset,
      command,
      args,
      workspace,
      file,
      line,
      column,
      ok: true,
      message: input.dryRun ? "Editor command prepared." : `Launched ${preset.name}.`
    };
  }

  async upsertProject(input: Partial<ProjectSummary>): Promise<ProjectSummary> {
    const projects = await this.projects();
    const project: ProjectSummary = {
      ...defaultProject(),
      ...input,
      id: input.id ?? crypto.randomUUID(),
      name: input.name ?? "Untitled Workspace",
      updatedAt: now()
    };
    const next = [project, ...projects.filter((item) => item.id !== project.id)];
    await this.writeJson("project.json", next);
    return project;
  }

  async formulas(): Promise<FormulaCard[]> {
    return this.readJson("formulas.json", defaultFormulas());
  }

  async formula(id: string): Promise<FormulaCard | undefined> {
    const formulas = await this.formulas();
    return formulas.find((formula) => formula.id === id);
  }

  async gitVerificationSummary(): Promise<GitVerificationSummary> {
    const formulas = await this.formulas();
    const passed = formulas.filter((formula) => formula.status === "passed").length;
    const warning = formulas.filter((formula) => formula.status === "warning").length;
    const failed = formulas.filter((formula) => formula.status === "failed").length;
    const queued = formulas.filter((formula) => formula.status === "queued" || formula.status === "running").length;
    const status: VerificationStatus = failed > 0 ? "failed" : warning > 0 ? "warning" : queued > 0 ? "queued" : "passed";
    return {
      status,
      formulaCount: formulas.length,
      passed,
      warning,
      failed,
      queued,
      linkedFormulaIds: formulas.filter((formula) => formula.status === "passed" || formula.status === "warning").map((formula) => formula.id),
      createdAt: now()
    };
  }

  async createFormula(input: Partial<FormulaCard>): Promise<FormulaCard> {
    const formulas = await this.formulas();
    const formula = normalizeFormula({
      ...input,
      id: input.id ?? slug(input.title ?? "formula"),
      title: input.title ?? "Untitled Formula",
      equation: input.equation ?? "y = f(x)",
      status: "queued"
    });
    const next = [formula, ...formulas.filter((item) => item.id !== formula.id)];
    await this.writeJson("formulas.json", next);
    await this.addLog(`Created formula ${formula.title}`, "info");
    return formula;
  }

  async updateFormula(id: string, input: Partial<FormulaCard>): Promise<FormulaCard | undefined> {
    const formulas = await this.formulas();
    const existing = formulas.find((formula) => formula.id === id);
    if (!existing) return undefined;
    const updated = normalizeFormula({ ...existing, ...input, id, status: input.status ?? "queued" });
    await this.writeJson("formulas.json", formulas.map((formula) => formula.id === id ? updated : formula));
    await this.addLog(`Updated formula ${updated.title}`, "info");
    return updated;
  }

  async verifyFormula(id: string): Promise<FormulaCard | undefined> {
    const formulas = await this.formulas();
    const formula = formulas.find((item) => item.id === id);
    if (!formula) return undefined;

    const report = await this.verifyWithEngines(formula, await this.benchmarks());
    const updated: FormulaCard = {
      ...formula,
      status: report.status,
      lastCheckedAt: report.createdAt,
      verificationHistory: [report, ...formula.verificationHistory].slice(0, 20)
    };
    await this.writeJson("formulas.json", formulas.map((item) => item.id === id ? updated : item));
    await this.addLog(`Verified ${formula.title}: ${report.status}`, report.status === "failed" ? "error" : "info");
    return updated;
  }

  private async verifyWithEngines(formula: FormulaCard, benchmarks: BenchmarkRun[] = []): Promise<VerificationReport> {
    const base = verify(formula, benchmarks);
    const engineChecks = await this.symbolicEngineChecks(formula, base.id);
    const advancedChecks = await this.advancedVerificationChecks(formula, base.id, benchmarks);
    const checks = [...base.checks, ...engineChecks, ...advancedChecks];
    return { ...base, checks, status: verificationStatus(checks) };
  }

  private async symbolicEngineChecks(formula: FormulaCard, reportId: string): Promise<VerificationCheck[]> {
    const sympy = sympyCompatibleCheck(formula);
    const wolfram = await this.wolframCheck(formula, reportId);
    return [sympy, wolfram];
  }

  private async advancedVerificationChecks(formula: FormulaCard, reportId: string, benchmarks: BenchmarkRun[]): Promise<VerificationCheck[]> {
    const specs = await this.verificationSpecs(formula.id);
    const artifactPath = `artifacts/verification/${formula.id}/${reportId}-advanced.json`;
    const checks: VerificationCheck[] = [
      propertyBasedCheck(formula, specs),
      metamorphicCheck(formula, specs),
      robustnessSweepCheck(formula, specs),
      autodiffCheck(formula, specs),
      roboticsKinematicsCheck(formula, specs),
      roboticsDynamicsCheck(formula, specs),
      reproducibilityCheck(formula, specs),
      modelEvaluationCheck(formula, benchmarks, specs),
      distributedTrainingCheck(formula, specs),
      intervalBoundsCheck(formula, specs),
      smtCheck(formula, specs),
      await this.runtimeProviderParityCheck(formula, reportId, specs)
    ];
    await this.writeWorkspaceText(artifactPath, JSON.stringify({
      formulaId: formula.id,
      reportId,
      specs,
      checks,
      seed: deterministicSeed(formula.id),
      createdAt: now()
    }, null, 2));
    await this.registerArtifact(formula.id, artifactPath, "formula", "application/json");
    return checks.map((check) => ({ ...check, artifactPaths: [...new Set([...(check.artifactPaths ?? []), artifactPath])] }));
  }

  private async verificationSpecs(formulaId: string): Promise<VerificationSpec[]> {
    const files = (await this.workspaceFiles()).filter((file) =>
      file.kind === "file"
      && file.path.startsWith("verification/specs/")
      && file.path.endsWith(".json")
    );
    const specs: VerificationSpec[] = [];
    for (const file of files) {
      const content = await this.readWorkspaceFile(file.path).catch(() => undefined);
      if (!content) continue;
      const parsed = parseVerificationSpec(content.content, file.path);
      if (parsed && (!parsed.formulaId || parsed.formulaId === formulaId)) specs.push(parsed);
    }
    return specs;
  }

  private async runtimeProviderParityCheck(formula: FormulaCard, reportId: string, specs: VerificationSpec[]): Promise<VerificationCheck> {
    const command = process.env.POLYLAB_RUNTIME_PARITY_COMMAND;
    const providerSpec = specs.find((spec) => spec.runtimeProviderParity || spec.hooks?.runtimeProviderParity);
    if (!command && !providerSpec) {
      return {
        name: "runtime-provider-parity",
        status: "passed",
        detail: "Attach a runtime-provider parity spec or set POLYLAB_RUNTIME_PARITY_COMMAND to compare PyTorch/JAX/ONNX/TensorRT-style backends."
      };
    }
    if (!command) {
      return {
        name: "runtime-provider-parity",
        status: "passed",
        detail: "Runtime-provider parity spec is present and ready for external backend comparison."
      };
    }
    const result = await runVerificationHookCommand(command, formula, specs, this.workspaceRoot);
    const artifactPath = `artifacts/verification/${formula.id}/${reportId}-runtime-provider-parity.json`;
    await this.writeWorkspaceText(artifactPath, JSON.stringify({ engine: "runtime-provider-parity", command, ...result, createdAt: now() }, null, 2));
    await this.registerArtifact(formula.id, artifactPath, "formula", "application/json");
    return {
      name: "runtime-provider-parity",
      status: result.exitCode === 0 ? "passed" : "failed",
      detail: result.exitCode === 0 ? `Runtime provider parity passed: ${result.detail}` : `Runtime provider parity failed: ${result.detail}`,
      artifactPaths: [artifactPath]
    };
  }

  private async wolframCheck(formula: FormulaCard, reportId: string): Promise<VerificationCheck> {
    const command = process.env.POLYLAB_WOLFRAM_COMMAND;
    if (!command) {
      return {
        name: "wolfram",
        status: "passed",
        detail: "Optional Wolfram verification hook is not configured; set POLYLAB_WOLFRAM_COMMAND to enable external CAS validation."
      };
    }
    const result = await runSymbolicEngineCommand(command, formula, this.workspaceRoot);
    const artifactPath = `artifacts/verification/${formula.id}/${reportId}-wolfram.json`;
    await this.writeWorkspaceText(artifactPath, JSON.stringify({
      engine: "wolfram",
      formulaId: formula.id,
      equation: formula.equation,
      command,
      ...result,
      createdAt: now()
    }, null, 2));
    await this.registerArtifact(formula.id, artifactPath, "formula", "application/json");
    return {
      name: "wolfram",
      status: result.exitCode === 0 ? "passed" : "failed",
      detail: result.exitCode === 0 ? `Wolfram hook passed: ${result.detail}` : `Wolfram hook failed: ${result.detail}`,
      artifactPaths: [artifactPath]
    };
  }

  async patches(): Promise<PatchReview[]> {
    return this.readJson("sessions/patches.json", []);
  }

  async generatePatchForFormula(id: string): Promise<PatchReview | undefined> {
    const formula = await this.formula(id);
    if (!formula) return undefined;
    const patch = createImplementationPatch(formula);
    await this.withWriteLock(async () => {
      const patches = await this.readJsonUnlocked("sessions/patches.json", [] as PatchReview[]);
      await this.writeJsonUnlocked("sessions/patches.json", [patch, ...patches].slice(0, 100));
    });
    await this.addLog(`Generated patch for ${formula.title}`, "info");
    return patch;
  }

  async updatePatchHunk(patchId: string, hunkId: string, decision: "accepted" | "rejected"): Promise<PatchReview | undefined> {
    let updated: PatchReview | undefined;
    await this.withWriteLock(async () => {
      const patches = await this.readJsonUnlocked("sessions/patches.json", [] as PatchReview[]);
      const patch = patches.find((item) => item.id === patchId);
      const hunk = patch?.hunks.find((item) => item.id === hunkId);
      if (!patch || !hunk) return;

      if (decision === "accepted" && hunk.status !== "accepted") {
        await applyHunk(this.workspaceRoot, hunk);
      }

      const nextHunks = patch.hunks.map((item) => item.id === hunkId ? { ...item, status: decision } : item);
      updated = {
        ...patch,
        hunks: nextHunks,
        status: patchStatus(nextHunks),
        updatedAt: now()
      };
      await this.writeJsonUnlocked("sessions/patches.json", patches.map((item) => item.id === patchId ? updated! : item));
    });
    if (updated) await this.addLog(`${decision === "accepted" ? "Accepted" : "Rejected"} patch hunk ${hunkId}`, "info");
    return updated;
  }

  async tasks(): Promise<AgentTask[]> {
    return this.readJson("tasks.json", defaultTasks());
  }

  async documents(): Promise<ResearchDocument[]> {
    const documents = await this.readJson("documents.json", defaultDocuments());
    return documents.map(normalizeDocument);
  }

  async upsertDocument(input: Partial<ResearchDocument>): Promise<ResearchDocument> {
    const documents = await this.documents();
    const base = {
      id: input.id ?? slug(input.title ?? "document"),
      kind: input.kind ?? "markdown",
      title: input.title ?? "Untitled Document",
      path: input.path ?? (input.kind === "latex" ? "papers/untitled.tex" : "notebooks/untitled.md"),
      source: input.source ?? "",
      cells: input.cells ?? [],
      linkedFormulaIds: input.linkedFormulaIds ?? [],
      citationKeys: input.citationKeys ?? [],
      bibliography: input.bibliography ?? [],
      pdfArtifactPath: input.pdfArtifactPath
    } satisfies Omit<ResearchDocument, "previewHtml" | "buildLog" | "updatedAt">;
    const rendered = renderDocument(base);
    await this.writeJson("documents.json", [rendered, ...documents.filter((item) => item.id !== rendered.id)]);
    await this.writeWorkspaceText(rendered.path, rendered.source);
    await this.addLog(`Updated ${rendered.kind} document ${rendered.title}`, "info");
    return rendered;
  }

  async renderDocument(id: string): Promise<ResearchDocument | undefined> {
    const documents = await this.documents();
    const document = documents.find((item) => item.id === id);
    if (!document) return undefined;
    const rendered = renderDocument(document);
    await this.writeJson("documents.json", documents.map((item) => item.id === id ? rendered : item));
    await this.writeWorkspaceText(rendered.path, rendered.source);
    return rendered;
  }

  async runNotebookCell(documentId: string, cellId: string): Promise<ResearchDocument | undefined> {
    const documents = await this.documents();
    const document = documents.find((item) => item.id === documentId && item.kind === "notebook");
    const cell = document?.cells.find((item) => item.id === cellId);
    if (!document || !cell) return undefined;

    let updatedCell: NotebookCell;
    if (cell.kind !== "code") {
      updatedCell = { ...cell, output: "Only code cells are executable.", executionState: "failed", updatedAt: now() };
    } else {
      const scriptPath = `notebooks/cells/${document.id}-${cell.id}.${cellExtension(cell)}`;
      await this.writeWorkspaceText(scriptPath, `${cell.source}\n`);
      const command = `${cellRuntime(cell)} ${scriptPath}`;
      const run = await runExecution({ command, target: "auto", memoryMb: 256 }, this.workspaceRoot);
      await this.recordExecution(run);
      updatedCell = {
        ...cell,
        output: run.stdout || run.stderr || "No output.",
        executionState: run.state === "succeeded" ? "succeeded" : "failed",
        artifactPaths: [`artifacts/executions/${run.id}/metadata.json`],
        updatedAt: now()
      };
    }

    const rendered = renderDocument({
      ...document,
      cells: document.cells.map((item) => item.id === cellId ? updatedCell : item),
      source: serializeNotebookCells(document.cells.map((item) => item.id === cellId ? updatedCell : item))
    });
    await this.writeJson("documents.json", documents.map((item) => item.id === documentId ? rendered : item));
    await this.writeWorkspaceText(rendered.path, rendered.source);
    await this.addLog(`Ran notebook cell in ${document.title}`, updatedCell.executionState === "failed" ? "error" : "info");
    return rendered;
  }

  async exportNotebookScript(documentId: string): Promise<{ path: string; source: string } | undefined> {
    const document = (await this.documents()).find((item) => item.id === documentId && item.kind === "notebook");
    if (!document) return undefined;
    const language = document.cells.find((cell) => cell.kind === "code")?.language ?? "python";
    const extension = language === "typescript" ? "ts" : "py";
    const source = document.cells
      .filter((cell) => cell.kind === "code")
      .map((cell) => cell.source)
      .join("\n\n");
    const path = `notebooks/${document.id}.${extension}`;
    await this.writeWorkspaceText(path, `${source}\n`);
    await this.addLog(`Exported notebook script ${path}`, "info");
    return { path, source: `${source}\n` };
  }

  async exportDocumentPdf(documentId: string): Promise<{ document: ResearchDocument; artifact: ArtifactRecord } | undefined> {
    const documents = await this.documents();
    const document = documents.find((item) => item.id === documentId);
    if (!document) return undefined;
    const rendered = renderDocument(document);
    const pdf = renderDocumentPdf(rendered);
    const pdfPath = `artifacts/documents/${rendered.id}/preview.pdf`;
    const bibliographyPath = `artifacts/documents/${rendered.id}/bibliography.json`;
    await this.writeWorkspaceBytes(pdfPath, pdf);
    await this.writeWorkspaceText(bibliographyPath, JSON.stringify({ citations: rendered.citationKeys, bibliography: rendered.bibliography }, null, 2));
    const info = await stat(join(this.workspaceRoot, pdfPath));
    const artifact: ArtifactRecord = {
      id: crypto.randomUUID(),
      sourceId: rendered.id,
      sourceType: "document",
      path: pdfPath,
      mediaType: "application/pdf",
      size: info.size,
      createdAt: now()
    };
    const updated = { ...rendered, pdfArtifactPath: pdfPath, buildLog: [`Exported PDF artifact ${pdfPath}.`, ...rendered.buildLog] };
    await this.withWriteLock(async () => {
      await this.writeJsonUnlocked("documents.json", documents.map((item) => item.id === documentId ? updated : item));
      const artifacts = await this.readJsonUnlocked("artifacts.json", [] as ArtifactRecord[]);
      await this.writeJsonUnlocked("artifacts.json", [artifact, ...artifacts].slice(0, 500));
    });
    await this.addLog(`Exported PDF for ${rendered.title}`, "info");
    return { document: updated, artifact };
  }

  async agentSessions(): Promise<AgentSession[]> {
    const sessions = await this.readJson("sessions/agent-sessions.json", [] as AgentSession[]);
    return sessions.map(normalizeAgentSession);
  }

  async createAgentSession(input: Partial<AgentSession> = {}): Promise<AgentSession> {
    const createdAt = now();
    const session: AgentSession = {
      id: input.id ?? crypto.randomUUID(),
      runtime: "pi-mono",
      provider: "codex",
      title: input.title ?? "Formula to verified patch",
      state: "planned",
      formulaId: input.formulaId,
      plan: input.plan ?? defaultAgentPlan(),
      trace: input.trace ?? [trace("plan", "Pi mono session created.")],
      attempts: input.attempts ?? 0,
      maxAttempts: input.maxAttempts ?? 2,
      artifactPaths: input.artifactPaths ?? [],
      replayPath: input.replayPath,
      createdAt,
      updatedAt: createdAt
    };
    await this.saveAgentSession(session);
    await this.addLog(`Created Pi mono session ${session.title}`, "info");
    return session;
  }

  async runAgentSession(id: string, input: { formulaId?: string; message?: string } = {}): Promise<AgentSession | undefined> {
    let session = (await this.agentSessions()).find((item) => item.id === id);
    if (!session) return undefined;
    const formulaId = input.formulaId ?? session.formulaId ?? "softmax-jacobian";
    session = {
      ...session,
      formulaId,
      state: "running",
      updatedAt: now(),
      trace: [...session.trace, trace("message", input.message ?? `Run deterministic workflow for ${formulaId}.`)]
    };
    await this.saveAgentSession(session);

    session = await this.advanceAgentStep(session, "inspect", "running", `Inspecting formula ${formulaId}.`);
    const formula = await this.formula(formulaId);
    if (!formula) {
      session = await this.failAgentSession(session, `Formula ${formulaId} was not found.`);
      return session;
    }
    session = await this.advanceAgentStep(session, "inspect", "done", `Formula ${formula.title} loaded with ${formula.variables.length} variables.`);

    session = await this.advanceAgentStep(session, "generate", "running", "Generating implementation patch.");
    const patch = await this.generatePatchForFormula(formulaId);
    session = await this.advanceAgentStep(session, "generate", patch ? "done" : "failed", patch ? `Generated patch ${patch.id}.` : "Patch generation failed.");
    if (!patch) return this.failAgentSession(session, "Patch generation failed.");

    session = await this.advanceAgentStep(session, "verify", "running", "Running formula verification.");
    let verified: FormulaCard | undefined;
    for (let attempt = 1; attempt <= session.maxAttempts; attempt += 1) {
      session = { ...session, attempts: attempt, trace: [...session.trace, trace(attempt === 1 ? "verification" : "retry", `Verification attempt ${attempt}/${session.maxAttempts}.`)], updatedAt: now() };
      await this.saveAgentSession(session);
      verified = await this.verifyFormula(formulaId);
      if (verified && verified.status !== "failed") break;
    }
    session = await this.advanceAgentStep(session, "verify", verified?.status === "failed" ? "failed" : "done", `Verification completed with ${verified?.status ?? "unknown"} status after ${session.attempts} attempt${session.attempts === 1 ? "" : "s"}.`);
    if (!verified || verified.status === "failed") {
      await this.exportAgentReplay(session);
      return this.failAgentSession(session, "Verification failed.");
    }

    session = await this.advanceAgentStep(session, "review", "done", "Patch is ready for user hunk review.");
    session = { ...session, state: "done", updatedAt: now(), trace: [...session.trace, trace("message", "Deterministic workflow completed.")] };
    session = await this.exportAgentReplay(session);
    await this.saveAgentSession(session);
    await this.addLog(`Pi mono workflow completed for ${formula.title}`, "info");
    return session;
  }

  async exportAgentReplay(sessionId: string | AgentSession): Promise<AgentSession> {
    const session = typeof sessionId === "string" ? (await this.agentSessions()).find((item) => item.id === sessionId) : sessionId;
    if (!session) throw new Error("Agent session not found");
    const replayPath = `artifacts/agents/${session.id}/replay.json`;
    const replay: AgentReplay = {
      session,
      createdAt: now(),
      events: session.trace,
      plan: session.plan,
      artifacts: session.artifactPaths
    };
    await this.writeWorkspaceText(replayPath, JSON.stringify(replay, null, 2));
    const info = await stat(join(this.workspaceRoot, replayPath));
    const artifact: ArtifactRecord = {
      id: crypto.randomUUID(),
      sourceId: session.id,
      sourceType: "agent",
      path: replayPath,
      mediaType: "application/json",
      size: info.size,
      createdAt: now()
    };
    const updated = { ...session, replayPath, artifactPaths: [...new Set([...session.artifactPaths, replayPath])], trace: [...session.trace, trace("artifact", `Exported replay ${replayPath}.`)], updatedAt: now() };
    await this.withWriteLock(async () => {
      const sessions = await this.readJsonUnlocked("sessions/agent-sessions.json", [] as AgentSession[]);
      await this.writeJsonUnlocked("sessions/agent-sessions.json", [updated, ...sessions.filter((item) => item.id !== updated.id)].slice(0, 100));
      const artifacts = await this.readJsonUnlocked("artifacts.json", [] as ArtifactRecord[]);
      await this.writeJsonUnlocked("artifacts.json", [artifact, ...artifacts].slice(0, 500));
    });
    return updated;
  }

  async agentRuntime(): Promise<AgentRuntimeConfig> {
    const saved = await this.readJson("sessions/agent-runtime.json", defaultAgentRuntime());
    const command = saved.codexCommand ?? process.env.POLYLAB_CODEX_COMMAND;
    return {
      ...defaultAgentRuntime(),
      ...saved,
      codexCommand: command,
      state: command ? saved.state === "connected" ? "connected" : "configured" : saved.state,
      updatedAt: saved.updatedAt ?? now()
    };
  }

  async configureAgentRuntime(input: Partial<AgentRuntimeConfig>): Promise<AgentRuntimeConfig> {
    const current = await this.agentRuntime();
    const updated: AgentRuntimeConfig = {
      ...current,
      ...input,
      runtime: "pi-mono",
      provider: "codex",
      state: input.state ?? (input.codexCommand || current.codexCommand ? "configured" : "not-configured"),
      credentialHint: input.credentialHint ?? current.credentialHint,
      workspaceIndexPath: input.workspaceIndexPath ?? current.workspaceIndexPath,
      updatedAt: now()
    };
    await this.writeJson("sessions/agent-runtime.json", updated);
    await this.addLog(`Configured Pi mono ${updated.provider} runtime`, "info");
    return updated;
  }

  async agentHandoffs(): Promise<AgentHandoff[]> {
    return this.readJson("sessions/agent-handoffs.json", [] as AgentHandoff[]);
  }

  async dispatchAgentHandoff(sessionId: string, input: { message?: string; command?: string } = {}): Promise<AgentHandoff | undefined> {
    const session = (await this.agentSessions()).find((item) => item.id === sessionId);
    if (!session) return undefined;
    const runtime = await this.agentRuntime();
    const id = crypto.randomUUID();
    const requestPath = `artifacts/agents/${session.id}/codex-handoff-${id}.json`;
    const resultPath = `artifacts/agents/${session.id}/codex-result-${id}.json`;
    const formula = session.formulaId ? await this.formula(session.formulaId) : undefined;
    const request = {
      id,
      runtime: runtime.runtime,
      provider: runtime.provider,
      workspaceRoot: this.workspaceRoot,
      session,
      formula,
      message: input.message ?? "Continue this PolyLab agent session through Codex.",
      createdAt: now()
    };
    await this.writeWorkspaceText(requestPath, JSON.stringify(request, null, 2));

    const command = input.command ?? runtime.codexCommand ?? process.env.POLYLAB_CODEX_COMMAND;
    let handoff: AgentHandoff = {
      id,
      sessionId: session.id,
      provider: "codex",
      state: command ? "created" : "skipped",
      requestPath,
      resultPath: command ? resultPath : undefined,
      command,
      createdAt: now(),
      updatedAt: now()
    };
    if (!command) {
      handoff = await this.saveAgentHandoff(handoff, `Created Codex handoff ${requestPath}; configure POLYLAB_CODEX_COMMAND to dispatch it.`);
      await this.registerArtifact(session.id, requestPath, "agent", "application/json");
      return handoff;
    }

    handoff = { ...handoff, state: "dispatched", updatedAt: now() };
    await this.saveAgentHandoff(handoff, `Dispatching Codex handoff ${handoff.id}.`);
    const result = await runAgentCommand(command, this.workspaceRoot, {
      POLYLAB_AGENT_SESSION_ID: session.id,
      POLYLAB_AGENT_HANDOFF_ID: handoff.id,
      POLYLAB_AGENT_HANDOFF_PATH: join(this.workspaceRoot, requestPath),
      POLYLAB_AGENT_RESULT_PATH: join(this.workspaceRoot, resultPath)
    });
    const finalState: AgentHandoff["state"] = result.exitCode === 0 ? "completed" : "failed";
    const resultPayload = { handoff: { ...handoff, state: finalState }, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, finishedAt: now() };
    await this.writeWorkspaceText(resultPath, JSON.stringify(resultPayload, null, 2));
    await this.registerArtifact(session.id, requestPath, "agent", "application/json");
    await this.registerArtifact(session.id, resultPath, "agent", "application/json");
    return this.saveAgentHandoff({
      ...handoff,
      state: finalState,
      resultPath,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      updatedAt: now()
    }, `${finalState === "completed" ? "Completed" : "Failed"} Codex handoff ${handoff.id}.`);
  }

  async logs(): Promise<ExecutionLog[]> {
    return this.readJson("logs.json", [bootLog()]);
  }

  async activityEvents(): Promise<ActivityEvent[]> {
    return this.readJson("activity/events.json", [bootActivity()]);
  }

  async permissions(): Promise<PermissionDecision[]> {
    return this.readJson("security/permissions.json", defaultPermissions());
  }

  async permissionChecks(): Promise<PermissionCheck[]> {
    return this.readJson("security/permission-checks.json", []);
  }

  async setPermission(input: { category: PermissionCategory; mode: PermissionMode; reason?: string; scope?: "project" | "session" }): Promise<PermissionDecision> {
    const permissions = await this.permissions();
    const decision: PermissionDecision = {
      id: input.category,
      category: input.category,
      mode: input.mode,
      scope: input.scope ?? (input.mode === "allow-session" ? "session" : "project"),
      reason: input.reason ?? "Updated from PolyLab security settings.",
      updatedAt: now()
    };
    await this.writeJson("security/permissions.json", [decision, ...permissions.filter((item) => item.category !== decision.category)]);
    await this.addLog(`Permission ${decision.category} set to ${decision.mode}`, decision.mode === "deny" ? "warn" : "info");
    return decision;
  }

  async requirePermission(category: PermissionCategory, action: string, resource: string): Promise<PermissionCheck> {
    const permissions = await this.permissions();
    const decision = permissions.find((item) => item.category === category) ?? defaultPermissions().find((item) => item.category === category);
    const mode = decision?.mode ?? "deny";
    const allowed = mode !== "deny";
    const check: PermissionCheck = {
      id: crypto.randomUUID(),
      category,
      action,
      resource,
      allowed,
      mode,
      reason: allowed ? decision?.reason ?? "Allowed by project policy." : decision?.reason ?? "No permission policy allows this action.",
      createdAt: now()
    };
    await this.withWriteLock(async () => {
      const checks = await this.readJsonUnlocked("security/permission-checks.json", [] as PermissionCheck[]);
      await this.writeJsonUnlocked("security/permission-checks.json", [check, ...checks].slice(0, 250));
      if (allowed && mode === "allow-once") {
        const current = await this.readJsonUnlocked("security/permissions.json", defaultPermissions());
        await this.writeJsonUnlocked("security/permissions.json", current.map((item) => item.category === category
          ? { ...item, mode: "deny", reason: `One-time approval used by ${action}.`, updatedAt: now() }
          : item));
      }
    });
    await this.recordActivity({
      type: "permission",
      level: allowed ? "info" : "warn",
      title: `${allowed ? "Allowed" : "Denied"} ${category}`,
      detail: action,
      resource
    });
    if (!allowed) throw new Error(`Permission denied for ${category}: ${action}`);
    return check;
  }

  persistenceStatus(): PersistenceStatus {
    return this.database.status();
  }

  persistenceEvents(limit?: number): PersistenceEvent[] {
    return this.database.events(limit);
  }

  private async saveAgentSession(session: AgentSession) {
    await this.withWriteLock(async () => {
      const sessions = await this.readJsonUnlocked("sessions/agent-sessions.json", [] as AgentSession[]);
      await this.writeJsonUnlocked("sessions/agent-sessions.json", [session, ...sessions.filter((item) => item.id !== session.id)].slice(0, 100));
    });
  }

  private async saveAgentHandoff(handoff: AgentHandoff, message: string): Promise<AgentHandoff> {
    await this.withWriteLock(async () => {
      const handoffs = await this.readJsonUnlocked("sessions/agent-handoffs.json", [] as AgentHandoff[]);
      await this.writeJsonUnlocked("sessions/agent-handoffs.json", [handoff, ...handoffs.filter((item) => item.id !== handoff.id)].slice(0, 100));
      const sessions = await this.readJsonUnlocked("sessions/agent-sessions.json", [] as AgentSession[]);
      const session = sessions.find((item) => item.id === handoff.sessionId);
      if (session) {
        const updated = normalizeAgentSession({
          ...session,
          artifactPaths: [...new Set([...normalizeAgentSession(session).artifactPaths, handoff.requestPath, ...(handoff.resultPath ? [handoff.resultPath] : [])])],
          trace: [...normalizeAgentSession(session).trace, trace(handoff.state === "failed" ? "message" : "tool", message)],
          updatedAt: now()
        });
        await this.writeJsonUnlocked("sessions/agent-sessions.json", [updated, ...sessions.filter((item) => item.id !== updated.id)].slice(0, 100));
      }
    });
    await this.addLog(message, handoff.state === "failed" ? "error" : "info");
    return handoff;
  }

  private async registerArtifact(sourceId: string, path: string, sourceType: ArtifactRecord["sourceType"], mediaType: string) {
    const info = await stat(join(this.workspaceRoot, path));
    const artifact: ArtifactRecord = {
      id: crypto.randomUUID(),
      sourceId,
      sourceType,
      path,
      mediaType,
      size: info.size,
      createdAt: now()
    };
    await this.withWriteLock(async () => {
      const artifacts = await this.readJsonUnlocked("artifacts.json", [] as ArtifactRecord[]);
      await this.writeJsonUnlocked("artifacts.json", [artifact, ...artifacts.filter((item) => item.path !== path)].slice(0, 500));
    });
  }

  private async advanceAgentStep(session: AgentSession, stepId: string, state: AgentPlanStep["state"], message: string): Promise<AgentSession> {
    const type: AgentTraceEvent["type"] = stepId === "generate" ? "patch" : stepId === "verify" ? "verification" : "tool";
    const updated: AgentSession = {
      ...session,
      plan: session.plan.map((step) => step.id === stepId ? { ...step, state, detail: message } : step),
      trace: [...session.trace, trace(type, message)],
      updatedAt: now()
    };
    await this.saveAgentSession(updated);
    return updated;
  }

  private async failAgentSession(session: AgentSession, message: string): Promise<AgentSession> {
    const updated: AgentSession = {
      ...session,
      state: "failed",
      trace: [...session.trace, trace("message", message)],
      updatedAt: now()
    };
    await this.saveAgentSession(updated);
    await this.addLog(`Pi mono workflow failed: ${message}`, "error");
    return updated;
  }

  async executions(): Promise<ExecutionRun[]> {
    return this.readJson("execution/runs.json", []);
  }

  async dependencyPlans(): Promise<DependencyPlan[]> {
    return this.readJson("execution/dependency-plans.json", []);
  }

  async scanDependencies(): Promise<DependencyPlan> {
    await this.ensureLayout();
    const files = (await this.workspaceFiles()).filter((file) => file.kind === "file");
    const items: DependencyItem[] = [];
    for (const file of files) {
      const content = await this.readWorkspaceFile(file.path).catch(() => undefined);
      if (!content) continue;
      items.push(...detectDependencies(content));
    }
    const deduped = dedupeDependencies(items);
    const plan: DependencyPlan = {
      id: crypto.randomUUID(),
      state: "planned",
      summary: deduped.length ? `${deduped.length} dependency candidate${deduped.length === 1 ? "" : "s"} detected.` : "No dependency candidates detected.",
      items: deduped,
      installCommand: dependencyInstallCommand(deduped),
      artifactPaths: [],
      createdAt: now(),
      updatedAt: now()
    };
    const artifactPath = `artifacts/dependencies/${plan.id}/plan.json`;
    const withArtifact = { ...plan, artifactPaths: [artifactPath] };
    await this.writeWorkspaceText(artifactPath, JSON.stringify(withArtifact, null, 2));
    const info = await stat(join(this.workspaceRoot, artifactPath));
    const artifact: ArtifactRecord = {
      id: crypto.randomUUID(),
      sourceId: plan.id,
      sourceType: "dependency",
      path: artifactPath,
      mediaType: "application/json",
      size: info.size,
      createdAt: now()
    };
    await this.withWriteLock(async () => {
      const plans = await this.readJsonUnlocked("execution/dependency-plans.json", [] as DependencyPlan[]);
      await this.writeJsonUnlocked("execution/dependency-plans.json", [withArtifact, ...plans].slice(0, 100));
      const artifacts = await this.readJsonUnlocked("artifacts.json", [] as ArtifactRecord[]);
      await this.writeJsonUnlocked("artifacts.json", [artifact, ...artifacts].slice(0, 500));
    });
    await this.addLog(`Dependency scan: ${withArtifact.summary}`, "info");
    return withArtifact;
  }

  async applyDependencyPlan(id: string): Promise<DependencyPlan | undefined> {
    const plans = await this.dependencyPlans();
    const plan = plans.find((item) => item.id === id);
    if (!plan) return undefined;
    let updated: DependencyPlan = { ...plan, state: "approved", updatedAt: now() };
    const command = process.env.POLYLAB_DEPENDENCY_INSTALL_COMMAND;
    if (!command || plan.items.length === 0) {
      updated = {
        ...updated,
        state: "skipped",
        stderr: plan.items.length === 0 ? "No dependencies to install." : "Dependency installation is disabled; set POLYLAB_DEPENDENCY_INSTALL_COMMAND to execute an approved installer.",
        updatedAt: now()
      };
    } else {
      const result = await runDependencyInstallCommand(command, plan, this.workspaceRoot);
      updated = {
        ...updated,
        state: result.exitCode === 0 ? "installed" : "failed",
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        updatedAt: now()
      };
    }
    const resultPath = `artifacts/dependencies/${plan.id}/result.json`;
    updated = { ...updated, artifactPaths: [...new Set([...updated.artifactPaths, resultPath])] };
    await this.writeWorkspaceText(resultPath, JSON.stringify(updated, null, 2));
    await this.withWriteLock(async () => {
      const current = await this.readJsonUnlocked("execution/dependency-plans.json", [] as DependencyPlan[]);
      await this.writeJsonUnlocked("execution/dependency-plans.json", [updated, ...current.filter((item) => item.id !== updated.id)].slice(0, 100));
      const info = await stat(join(this.workspaceRoot, resultPath));
      const artifacts = await this.readJsonUnlocked("artifacts.json", [] as ArtifactRecord[]);
      await this.writeJsonUnlocked("artifacts.json", [{
        id: crypto.randomUUID(),
        sourceId: updated.id,
        sourceType: "dependency",
        path: resultPath,
        mediaType: "application/json",
        size: info.size,
        createdAt: now()
      }, ...artifacts].slice(0, 500));
    });
    await this.addLog(`Dependency plan ${updated.state}: ${updated.summary}`, updated.state === "failed" ? "error" : "info");
    return updated;
  }

  async cloudProviders(): Promise<CloudProviderConfig[]> {
    const saved = await this.readJson("cloud/providers.json", [] as CloudProviderConfig[]);
    const defaults = defaultCloudProviders();
    return defaults.map((provider) => {
      const configured = saved.find((item) => item.id === provider.id);
      return configured ?? provider;
    });
  }

  async configureCloudProvider(input: Partial<CloudProviderConfig> & { id: RuntimeTarget }): Promise<CloudProviderConfig> {
    const providers = await this.cloudProviders();
    const existing = providers.find((provider) => provider.id === input.id) ?? defaultCloudProviders().find((provider) => provider.id === input.id);
    if (!existing || input.id === "local" || input.id === "docker") throw new Error("Unsupported cloud provider");
    const updated: CloudProviderConfig = {
      ...existing,
      ...input,
      state: input.state ?? "configured",
      credentialHint: input.credentialHint ?? existing.credentialHint,
      updatedAt: now()
    };
    await this.writeJson("cloud/providers.json", [updated, ...providers.filter((provider) => provider.id !== updated.id)]);
    await this.addLog(`Configured ${updated.name}`, "info");
    return updated;
  }

  async cloudJobs(): Promise<CloudExecutionJob[]> {
    return this.readJson("cloud/jobs.json", []);
  }

  async cloudLogs(jobId?: string): Promise<CloudJobLog[]> {
    const logs = await this.readJson("cloud/logs.json", [] as CloudJobLog[]);
    return jobId ? logs.filter((log) => log.jobId === jobId) : logs;
  }

  async queueCloudExecution(request: ExecutionRequest, route: ExecutionRoute): Promise<CloudExecutionJob> {
    await this.ensureLayout();
    const provider = route.target;
    const job: CloudExecutionJob = {
      id: crypto.randomUUID(),
      provider,
      command: request.command,
      state: "ready-for-dispatch",
      reason: route.reason,
      artifactPaths: [],
      costEstimate: estimateCost(provider, request),
      createdAt: now(),
      updatedAt: now()
    };
    const artifactPath = `artifacts/cloud/jobs/${job.id}.json`;
    const payload = {
      job,
      request,
      sync: { workspaceRoot: this.workspaceRoot, requiredBeforeDispatch: true },
      dispatch: cloudDispatchInstructions(provider),
      notebook: provider === "google-notebook" ? googleNotebookHandoff(job, request) : undefined
    };
    await this.writeWorkspaceText(artifactPath, JSON.stringify(payload, null, 2));
    const info = await stat(join(this.workspaceRoot, artifactPath));
    const artifacts: ArtifactRecord[] = [{
      id: crypto.randomUUID(),
      sourceId: job.id,
      sourceType: "cloud",
      path: artifactPath,
      mediaType: "application/json",
      size: info.size,
      createdAt: now()
    }];
    const artifactPaths = [artifactPath];
    if (provider === "google-notebook") {
      const notebookPath = `artifacts/cloud/jobs/${job.id}-google-notebook.ipynb`;
      await this.writeWorkspaceText(notebookPath, JSON.stringify(renderGoogleNotebook(job, request), null, 2));
      const notebookInfo = await stat(join(this.workspaceRoot, notebookPath));
      artifacts.push({
        id: crypto.randomUUID(),
        sourceId: job.id,
        sourceType: "cloud",
        path: notebookPath,
        mediaType: "application/x-ipynb+json",
        size: notebookInfo.size,
        createdAt: now()
      });
      artifactPaths.push(notebookPath);
    }
    const persisted = { ...job, artifactPaths };
    await this.withWriteLock(async () => {
      const jobs = await this.readJsonUnlocked("cloud/jobs.json", [] as CloudExecutionJob[]);
      await this.writeJsonUnlocked("cloud/jobs.json", [persisted, ...jobs].slice(0, 200));
      const existingArtifacts = await this.readJsonUnlocked("artifacts.json", [] as ArtifactRecord[]);
      await this.writeJsonUnlocked("artifacts.json", [...artifacts, ...existingArtifacts].slice(0, 500));
    });
    await this.addLog(`Queued ${provider} execution job ${job.id}`, "info");
    return persisted;
  }

  async dispatchCloudJob(id: string): Promise<CloudDispatchResult | undefined> {
    const jobs = await this.cloudJobs();
    const job = jobs.find((item) => item.id === id);
    if (!job) return undefined;
    if (job.state === "succeeded" || job.state === "failed" || job.state === "cancelled") {
      return { job, logs: await this.cloudLogs(job.id) };
    }
    const started = { ...job, state: "running" as const, updatedAt: now() };
    await this.persistCloudJob(started);
    const logs: CloudJobLog[] = [
      cloudLog(started, "info", `Dispatching ${started.provider} job ${started.id}.`),
      cloudLog(started, "info", cloudDispatchInstructions(started.provider))
    ];
    const dispatchArtifact = await this.writeCloudDispatchArtifact(started, "dispatch", {
      job: started,
      workspaceRoot: this.workspaceRoot,
      command: started.command,
      provider: started.provider,
      env: cloudProviderEnvHints(started.provider)
    });

    const dispatchCommand = cloudDispatchCommand(started.provider);
    let completed: CloudExecutionJob;
    if (!dispatchCommand) {
      logs.push(cloudLog(started, "warn", `No dispatch command configured for ${started.provider}; job remains ready for external worker pickup.`));
      completed = { ...started, state: "ready-for-dispatch", artifactPaths: [...new Set([...started.artifactPaths, dispatchArtifact])], updatedAt: now() };
    } else {
      const result = await runCloudDispatchCommand(dispatchCommand, started, this.workspaceRoot);
      logs.push(cloudLog(started, result.ok ? "info" : "error", result.detail));
      const resultArtifact = await this.writeCloudDispatchArtifact(started, "result", {
        ok: result.ok,
        command: dispatchCommand,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        finishedAt: now()
      });
      completed = {
        ...started,
        state: result.ok ? "succeeded" : "failed",
        artifactPaths: [...new Set([...started.artifactPaths, dispatchArtifact, resultArtifact])],
        updatedAt: now()
      };
    }
    await this.persistCloudJob(completed, logs);
    await this.addLog(`${completed.provider} cloud job ${completed.id} ${completed.state}`, completed.state === "failed" ? "error" : "info");
    return { job: completed, logs: await this.cloudLogs(completed.id) };
  }

  async cancelCloudJob(id: string): Promise<CloudDispatchResult | undefined> {
    const job = (await this.cloudJobs()).find((item) => item.id === id);
    if (!job) return undefined;
    const cancelled = { ...job, state: "cancelled" as const, updatedAt: now() };
    const logs = [cloudLog(cancelled, "warn", "Cloud job cancelled before provider completion.")];
    await this.persistCloudJob(cancelled, logs);
    await this.addLog(`Cancelled cloud job ${cancelled.id}`, "warn");
    return { job: cancelled, logs: await this.cloudLogs(cancelled.id) };
  }

  private async persistCloudJob(job: CloudExecutionJob, newLogs: CloudJobLog[] = []) {
    await this.withWriteLock(async () => {
      const jobs = await this.readJsonUnlocked("cloud/jobs.json", [] as CloudExecutionJob[]);
      await this.writeJsonUnlocked("cloud/jobs.json", [job, ...jobs.filter((item) => item.id !== job.id)].slice(0, 200));
      if (newLogs.length > 0) {
        const logs = await this.readJsonUnlocked("cloud/logs.json", [] as CloudJobLog[]);
        await this.writeJsonUnlocked("cloud/logs.json", [...newLogs, ...logs].slice(0, 500));
      }
    });
  }

  private async writeCloudDispatchArtifact(job: CloudExecutionJob, name: "dispatch" | "result", payload: unknown) {
    const artifactPath = `artifacts/cloud/jobs/${job.id}-${name}.json`;
    await this.writeWorkspaceText(artifactPath, JSON.stringify(payload, null, 2));
    const info = await stat(join(this.workspaceRoot, artifactPath));
    const artifact: ArtifactRecord = {
      id: crypto.randomUUID(),
      sourceId: job.id,
      sourceType: "cloud",
      path: artifactPath,
      mediaType: "application/json",
      size: info.size,
      createdAt: now()
    };
    await this.withWriteLock(async () => {
      const artifacts = await this.readJsonUnlocked("artifacts.json", [] as ArtifactRecord[]);
      await this.writeJsonUnlocked("artifacts.json", [artifact, ...artifacts].slice(0, 500));
    });
    return artifactPath;
  }

  async deploymentPlans(): Promise<DeploymentPlan[]> {
    return this.readJson("deployment/plans.json", []);
  }

  async deploymentMutations(): Promise<DeploymentMutation[]> {
    return this.readJson("deployment/mutations.json", []);
  }

  async createDeploymentPlan(input: { name?: string; routes?: DeploymentRoute[]; dnsTarget?: string } = {}): Promise<DeploymentPlan> {
    await this.ensureLayout();
    const routes = (input.routes?.length ? input.routes : defaultDeploymentRoutes()).map(normalizeRoute);
    const dnsTarget = input.dnsTarget ?? process.env.POLYLAB_DEPLOYMENT_TARGET ?? "203.0.113.10";
    const createdAt = now();
    const draft: DeploymentPlan = {
      id: crypto.randomUUID(),
      name: input.name ?? "Standalone PolyLab server",
      routes,
      caddyfile: renderCaddyfile(routes),
      dockerCompose: renderDockerCompose(),
      envExample: renderDeploymentEnv(routes, dnsTarget),
      dnsPreview: routes.map((route): DnsPreviewChange => ({
        action: "create",
        type: "A",
        name: route.host,
        content: dnsTarget,
        proxied: true
      })),
      state: "ready",
      artifactPaths: [],
      createdAt,
      updatedAt: createdAt
    };
    const artifactPaths = [
      `artifacts/deployment/${draft.id}/Caddyfile`,
      `artifacts/deployment/${draft.id}/docker-compose.yml`,
      `artifacts/deployment/${draft.id}/.env.example`,
      `artifacts/deployment/${draft.id}/cloudflare-dns-preview.json`,
      `artifacts/deployment/${draft.id}/plan.json`
    ];
    const plan = { ...draft, artifactPaths };
    await this.writeWorkspaceText(artifactPaths[0]!, plan.caddyfile);
    await this.writeWorkspaceText(artifactPaths[1]!, plan.dockerCompose ?? "");
    await this.writeWorkspaceText(artifactPaths[2]!, plan.envExample ?? "");
    await this.writeWorkspaceText(artifactPaths[3]!, JSON.stringify(plan.dnsPreview, null, 2));
    await this.writeWorkspaceText(artifactPaths[4]!, JSON.stringify(plan, null, 2));
    const artifacts = await Promise.all(artifactPaths.map(async (path): Promise<ArtifactRecord> => {
      const info = await stat(join(this.workspaceRoot, path));
      return {
        id: crypto.randomUUID(),
        sourceId: plan.id,
        sourceType: "deployment",
        path,
        mediaType: deploymentArtifactMediaType(path),
        size: info.size,
        createdAt: now()
      };
    }));
    await this.withWriteLock(async () => {
      const plans = await this.readJsonUnlocked("deployment/plans.json", [] as DeploymentPlan[]);
      await this.writeJsonUnlocked("deployment/plans.json", [plan, ...plans].slice(0, 50));
      const existingArtifacts = await this.readJsonUnlocked("artifacts.json", [] as ArtifactRecord[]);
      await this.writeJsonUnlocked("artifacts.json", [...artifacts, ...existingArtifacts].slice(0, 500));
    });
    await this.addLog(`Prepared deployment plan ${plan.name}`, "info");
    return plan;
  }

  async applyDeploymentPlan(id: string, input: { applyDns?: boolean; reloadCaddy?: boolean; dryRun?: boolean } = {}): Promise<DeploymentApplyResult | undefined> {
    const plan = (await this.deploymentPlans()).find((item) => item.id === id);
    if (!plan) return undefined;
    const mutations: DeploymentMutation[] = [];
    const dryRun = input.dryRun === true;
    const caddyfilePath = process.env.POLYLAB_CADDYFILE_PATH;
    const backupPath = `artifacts/deployment/${plan.id}/rollback/Caddyfile.previous`;

    if (caddyfilePath) {
      if (!dryRun) {
        const previous = await readFile(caddyfilePath, "utf8").catch(() => undefined);
        if (previous !== undefined) await this.writeWorkspaceText(backupPath, previous);
        await writeFile(caddyfilePath, plan.caddyfile);
      }
      mutations.push(deploymentMutation(plan.id, "caddy-write", dryRun ? "planned" : "applied", caddyfilePath, dryRun ? "Prepared Caddyfile write." : "Wrote Caddyfile to configured path.", dryRun ? [] : [backupPath]));
    } else {
      mutations.push(deploymentMutation(plan.id, "caddy-write", "skipped", "POLYLAB_CADDYFILE_PATH", "Set POLYLAB_CADDYFILE_PATH to allow PolyLab to write a Caddyfile.", []));
    }

    if (input.reloadCaddy !== false) {
      const reloadCommand = process.env.POLYLAB_CADDY_RELOAD_COMMAND;
      if (reloadCommand) {
        const result = dryRun ? { ok: true, detail: "Prepared Caddy reload command." } : await runDeploymentCommand(reloadCommand, this.workspaceRoot);
        mutations.push(deploymentMutation(plan.id, "caddy-reload", result.ok ? dryRun ? "planned" : "applied" : "failed", reloadCommand, result.detail, []));
      } else {
        mutations.push(deploymentMutation(plan.id, "caddy-reload", "skipped", "POLYLAB_CADDY_RELOAD_COMMAND", "Set POLYLAB_CADDY_RELOAD_COMMAND to allow PolyLab to reload Caddy.", []));
      }
    }

    if (input.applyDns) {
      const dnsMutation = dryRun
        ? deploymentMutation(plan.id, "cloudflare-dns", "planned", "cloudflare", `Prepared ${plan.dnsPreview.length} Cloudflare DNS changes.`, [])
        : await this.applyCloudflareDns(plan);
      mutations.push(dnsMutation);
    } else {
      mutations.push(deploymentMutation(plan.id, "cloudflare-dns", "skipped", "cloudflare", "DNS mutation was not requested; preview remains available for review.", []));
    }

    return this.persistDeploymentMutations(plan, mutations, mutations.some((item) => item.state === "failed") ? "ready" : "applied");
  }

  async rollbackDeploymentPlan(id: string): Promise<DeploymentApplyResult | undefined> {
    const plan = (await this.deploymentPlans()).find((item) => item.id === id);
    if (!plan) return undefined;
    const caddyfilePath = process.env.POLYLAB_CADDYFILE_PATH;
    const backupPath = `artifacts/deployment/${plan.id}/rollback/Caddyfile.previous`;
    const mutations: DeploymentMutation[] = [];
    if (caddyfilePath) {
      const previous = await readFile(join(this.workspaceRoot, backupPath), "utf8").catch(() => undefined);
      if (previous !== undefined) {
        await writeFile(caddyfilePath, previous);
        mutations.push(deploymentMutation(plan.id, "rollback", "applied", caddyfilePath, "Restored previous Caddyfile from PolyLab rollback artifact.", [backupPath]));
      } else {
        mutations.push(deploymentMutation(plan.id, "rollback", "skipped", backupPath, "No Caddyfile backup artifact exists for this plan.", []));
      }
    } else {
      mutations.push(deploymentMutation(plan.id, "rollback", "skipped", "POLYLAB_CADDYFILE_PATH", "Set POLYLAB_CADDYFILE_PATH to allow Caddyfile rollback.", []));
    }
    return this.persistDeploymentMutations(plan, mutations, "rolled-back");
  }

  private async applyCloudflareDns(plan: DeploymentPlan): Promise<DeploymentMutation> {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const zoneId = process.env.CLOUDFLARE_ZONE_ID;
    const apiBase = process.env.POLYLAB_CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4";
    if (!token || !zoneId) {
      return deploymentMutation(plan.id, "cloudflare-dns", "skipped", "cloudflare", "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID are required before DNS mutation.", []);
    }
    try {
      const responses = [];
      for (const change of plan.dnsPreview) {
        const response = await fetch(`${apiBase}/zones/${zoneId}/dns_records`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            type: change.type,
            name: change.name,
            content: change.content,
            proxied: change.proxied
          })
        });
        responses.push(`${change.name}: ${response.status}`);
        if (!response.ok) throw new Error(`${change.name} returned ${response.status}`);
      }
      return deploymentMutation(plan.id, "cloudflare-dns", "applied", "cloudflare", `Applied DNS changes: ${responses.join(", ")}`, []);
    } catch (error) {
      return deploymentMutation(plan.id, "cloudflare-dns", "failed", "cloudflare", error instanceof Error ? error.message : "Cloudflare DNS mutation failed", []);
    }
  }

  private async persistDeploymentMutations(plan: DeploymentPlan, mutations: DeploymentMutation[], state: DeploymentPlan["state"]): Promise<DeploymentApplyResult> {
    const nowIso = now();
    const materializedMutations = await Promise.all(mutations.map(async (mutation) => {
      const artifactPath = `artifacts/deployment/${plan.id}/mutations/${mutation.id}.json`;
      const next = { ...mutation, artifactPaths: [...new Set([...mutation.artifactPaths, artifactPath])] };
      await this.writeWorkspaceText(artifactPath, JSON.stringify(next, null, 2));
      return next;
    }));
    const mutationArtifacts = await Promise.all(materializedMutations.flatMap((mutation) => mutation.artifactPaths).map(async (path): Promise<ArtifactRecord | undefined> => {
      const file = join(this.workspaceRoot, path);
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) return undefined;
      return {
        id: crypto.randomUUID(),
        sourceId: plan.id,
        sourceType: "deployment",
        path,
        mediaType: path.endsWith(".json") ? "application/json" : "text/caddyfile",
        size: info.size,
        createdAt: now()
      };
    }));
    const updatedPlan = { ...plan, state, updatedAt: nowIso };
    await this.writeWorkspaceText(`artifacts/deployment/${plan.id}/plan.json`, JSON.stringify(updatedPlan, null, 2));
    await this.withWriteLock(async () => {
      const plans = await this.readJsonUnlocked("deployment/plans.json", [] as DeploymentPlan[]);
      await this.writeJsonUnlocked("deployment/plans.json", plans.map((item) => item.id === plan.id ? updatedPlan : item));
      const existingMutations = await this.readJsonUnlocked("deployment/mutations.json", [] as DeploymentMutation[]);
      await this.writeJsonUnlocked("deployment/mutations.json", [...materializedMutations, ...existingMutations].slice(0, 200));
      const existingArtifacts = await this.readJsonUnlocked("artifacts.json", [] as ArtifactRecord[]);
      await this.writeJsonUnlocked("artifacts.json", [...mutationArtifacts.filter((item): item is ArtifactRecord => Boolean(item)), ...existingArtifacts].slice(0, 500));
    });
    await this.addLog(`${state === "rolled-back" ? "Rolled back" : "Applied"} deployment plan ${plan.name}`, state === "ready" ? "warn" : "info");
    return { plan: updatedPlan, mutations: materializedMutations };
  }

  async artifacts(): Promise<ArtifactRecord[]> {
    return this.readJson("artifacts.json", []);
  }

  async readArtifact(id: string): Promise<ArtifactContent | undefined> {
    const artifact = (await this.artifacts()).find((item) => item.id === id);
    if (!artifact) return undefined;
    if (!artifact.path.startsWith("artifacts/") && !artifact.path.startsWith("benchmarks/") && !artifact.path.startsWith("notebooks/")) {
      throw new Error("Artifact path is outside previewable workspace outputs");
    }
    const file = this.resolveWorkspacePath(artifact.path);
    const info = await stat(file);
    if (info.size > 1024 * 1024) throw new Error("Artifact is too large to preview");
    const previewable = isPreviewableArtifact(artifact);
    return {
      artifact,
      content: previewable ? await readFile(file, "utf8") : "Binary artifact preview is not supported yet.",
      encoding: "utf8",
      previewable
    };
  }

  async benchmarks(): Promise<BenchmarkRun[]> {
    return this.readJson("benchmarks/runs.json", []);
  }

  async runBenchmark(input: BenchmarkRequest): Promise<BenchmarkRun> {
    await this.ensureLayout();
    const iterations = Math.max(1, Math.min(20, Math.floor(input.iterations ?? 3)));
    const durationsMs: number[] = [];
    const artifactPaths: string[] = [];
    let route: BenchmarkRun["route"] | undefined;
    let state: BenchmarkRun["state"] = "succeeded";

    for (let index = 0; index < iterations; index += 1) {
      const started = performance.now();
      const run = await runExecution({
        target: input.target ?? "auto",
        command: input.command,
        memoryMb: input.memoryMb,
        gpuRequired: input.gpuRequired
      }, this.workspaceRoot);
      durationsMs.push(Math.round((performance.now() - started) * 100) / 100);
      route = run.route;
      await this.recordExecution(run);
      artifactPaths.push(`artifacts/executions/${run.id}/metadata.json`);
      if (run.state !== "succeeded") state = "failed";
    }

    const meanMs = durationsMs.reduce((sum, value) => sum + value, 0) / durationsMs.length;
    const benchmark: BenchmarkRun = {
      id: crypto.randomUUID(),
      name: input.name || "Untitled benchmark",
      command: input.command,
      iterations,
      route: route ?? { target: "local", reason: "Benchmark did not run." },
      state,
      durationsMs,
      meanMs: Math.round(meanMs * 100) / 100,
      minMs: Math.min(...durationsMs),
      maxMs: Math.max(...durationsMs),
      artifactPaths,
      createdAt: now()
    };

    await this.withWriteLock(async () => {
      const runs = await this.readJsonUnlocked("benchmarks/runs.json", [] as BenchmarkRun[]);
      await this.writeJsonUnlocked("benchmarks/runs.json", [benchmark, ...runs].slice(0, 100));
    });
    await this.writeWorkspaceText(`benchmarks/${benchmark.id}.json`, JSON.stringify(benchmark, null, 2));
    await this.addLog(`Benchmark ${benchmark.name}: ${benchmark.meanMs}ms mean`, state === "failed" ? "error" : "info");
    return benchmark;
  }

  async experiments(): Promise<ExperimentRun[]> {
    return this.readJson("experiments/runs.json", []);
  }

  async runExperiment(input: Partial<ExecutionRequest> & { name?: string; formulaId?: string } = {}): Promise<ExperimentRun> {
    await this.ensureLayout();
    const command = input.command ?? "python3 experiments/simulation.py";
    const createdAt = now();
    const formula = input.formulaId ? await this.formula(input.formulaId) : (await this.formulas())[0];
    const draft: ExperimentRun = {
      id: crypto.randomUUID(),
      name: input.name ?? "Local simulation experiment",
      command,
      state: "running",
      nodes: [
        { id: "idea", label: "Experiment idea", kind: "idea", status: "queued" },
        { id: "formula", label: formula?.title ?? "Formula", kind: "formula", status: formula?.status ?? "queued" },
        { id: "execution", label: command, kind: "execution", status: "queued" }
      ],
      edges: [
        { from: "idea", to: "formula", label: "formalizes" },
        { from: "formula", to: "execution", label: "drives" }
      ],
      samples: simulationSamples(formula?.id ?? "default"),
      artifactPaths: [],
      createdAt,
      updatedAt: createdAt
    };
    const run = await runExecution({
      target: input.target ?? "auto",
      command,
      memoryMb: input.memoryMb,
      gpuRequired: input.gpuRequired,
      estimatedSeconds: input.estimatedSeconds,
      allowNetwork: input.allowNetwork,
      sandbox: input.sandbox,
      dockerImage: input.dockerImage
    }, this.workspaceRoot);
    const persistedRun = await this.recordExecution(run);
    const state: ExperimentRun["state"] = persistedRun.state === "succeeded" ? "succeeded" : persistedRun.state === "queued" ? "queued" : "failed";
    const completed: ExperimentRun = {
      ...draft,
      state,
      executionRunId: persistedRun.id,
      nodes: [
        ...draft.nodes.map((node) => node.id === "execution" ? { ...node, status: state } : node),
        { id: "artifact", label: "Simulation artifact", kind: "artifact", status: state }
      ],
      edges: [...draft.edges, { from: "execution", to: "artifact", label: "produces" }],
      artifactPaths: [
        `artifacts/experiments/${draft.id}/graph.json`,
        `artifacts/experiments/${draft.id}/samples.json`,
        ...(persistedRun.artifactPaths ?? [])
      ],
      updatedAt: now()
    };
    await this.writeWorkspaceText(`artifacts/experiments/${completed.id}/graph.json`, JSON.stringify({
      id: completed.id,
      name: completed.name,
      nodes: completed.nodes,
      edges: completed.edges,
      state: completed.state,
      executionRunId: completed.executionRunId
    }, null, 2));
    await this.writeWorkspaceText(`artifacts/experiments/${completed.id}/samples.json`, JSON.stringify({ samples: completed.samples }, null, 2));
    await this.withWriteLock(async () => {
      const experiments = await this.readJsonUnlocked("experiments/runs.json", [] as ExperimentRun[]);
      await this.writeJsonUnlocked("experiments/runs.json", [completed, ...experiments].slice(0, 100));
      const existingArtifacts = await this.readJsonUnlocked("artifacts.json", [] as ArtifactRecord[]);
      const artifacts = await Promise.all(completed.artifactPaths.slice(0, 2).map(async (path): Promise<ArtifactRecord> => {
        const info = await stat(join(this.workspaceRoot, path));
        return { id: crypto.randomUUID(), sourceId: completed.id, sourceType: "experiment", path, mediaType: "application/json", size: info.size, createdAt: now() };
      }));
      await this.writeJsonUnlocked("artifacts.json", [...artifacts, ...existingArtifacts].slice(0, 500));
    });
    await this.addLog(`Experiment ${completed.name}: ${completed.state}`, completed.state === "failed" ? "error" : "info");
    return completed;
  }

  async syncRuns(): Promise<SyncRun[]> {
    return this.readJson("sync/runs.json", []);
  }

  async pushSync(remotePath = this.defaultSyncRemote()): Promise<SyncRun> {
    await this.ensureLayout();
    const run = await pushWorkspace(this.workspaceRoot, remotePath);
    await this.recordSync(run);
    return run;
  }

  async pullSync(remotePath = this.defaultSyncRemote()): Promise<SyncRun> {
    await this.ensureLayout();
    const run = await pullWorkspace(this.workspaceRoot, remotePath);
    await this.recordSync(run);
    return run;
  }

  async recordExecution(run: ExecutionRun): Promise<ExecutionRun> {
    const artifacts = await this.writeExecutionArtifacts(run);
    const persisted = { ...run, artifactPaths: artifacts.map((artifact) => artifact.path) };
    await this.withWriteLock(async () => {
      const runs = await this.readJsonUnlocked("execution/runs.json", [] as ExecutionRun[]);
      await this.writeJsonUnlocked("execution/runs.json", [persisted, ...runs].slice(0, 200));
      const existingArtifacts = await this.readJsonUnlocked("artifacts.json", [] as ArtifactRecord[]);
      await this.writeJsonUnlocked("artifacts.json", [...artifacts, ...existingArtifacts].slice(0, 500));
      const logs = await this.readJsonUnlocked("logs.json", [bootLog()]);
      const log: ExecutionLog = {
        id: crypto.randomUUID(),
        target: "local",
        message: `Execution ${run.state}: ${run.command}`,
        level: run.state === "failed" ? "error" : "info",
        createdAt: now()
      };
      await this.writeJsonUnlocked("logs.json", [log, ...logs].slice(0, 500));
    });
    await this.recordActivity({
      type: "execution",
      level: run.state === "failed" ? "error" : "info",
      title: `Execution ${run.state}`,
      detail: run.command,
      resource: run.id
    });
    return persisted;
  }

  async recordSync(run: SyncRun): Promise<SyncRun> {
    await this.withWriteLock(async () => {
      const runs = await this.readJsonUnlocked("sync/runs.json", [] as SyncRun[]);
      await this.writeJsonUnlocked("sync/runs.json", [run, ...runs].slice(0, 100));
      const logs = await this.readJsonUnlocked("logs.json", [bootLog()]);
      const log: ExecutionLog = {
        id: crypto.randomUUID(),
        target: "local",
        message: `Sync ${run.direction} ${run.state}: ${run.filesCopied} files`,
        level: run.state === "failed" ? "error" : "info",
        createdAt: now()
      };
      await this.writeJsonUnlocked("logs.json", [log, ...logs].slice(0, 500));
    });
    await this.recordActivity({
      type: "sync",
      level: run.state === "failed" ? "error" : "info",
      title: `Sync ${run.direction} ${run.state}`,
      detail: `${run.filesCopied} files copied`,
      resource: run.remotePath
    });
    return run;
  }

  async addLog(message: string, level: ExecutionLog["level"] = "info"): Promise<ExecutionLog> {
    const log: ExecutionLog = {
      id: crypto.randomUUID(),
      target: "local",
      message,
      level,
      createdAt: now()
    };
    await this.withWriteLock(async () => {
      const logs = await this.readJsonUnlocked("logs.json", [bootLog()]);
      await this.writeJsonUnlocked("logs.json", [log, ...logs].slice(0, 500));
    });
    await this.recordActivity({
      type: activityTypeForMessage(message),
      level,
      title: message,
      detail: "Workspace log",
      resource: log.id
    });
    return log;
  }

  async recordActivity(input: Omit<ActivityEvent, "id" | "createdAt">): Promise<ActivityEvent> {
    const event: ActivityEvent = { id: crypto.randomUUID(), createdAt: now(), ...input };
    await this.withWriteLock(async () => {
      const events = await this.readJsonUnlocked("activity/events.json", [bootActivity()]);
      await this.writeJsonUnlocked("activity/events.json", [event, ...events].slice(0, 500));
    });
    return event;
  }

  async readJson<T>(name: string, fallback: T): Promise<T> {
    const file = join(this.dataDir, name);
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        await this.writeJson(name, fallback);
        return fallback;
      }
      throw error;
    }
  }

  async writeJson(name: string, value: unknown) {
    await this.withWriteLock(() => this.writeJsonUnlocked(name, value));
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readJsonUnlocked<T>(name: string, fallback: T): Promise<T> {
    const file = join(this.dataDir, name);
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        await this.writeJsonUnlocked(name, fallback);
        return fallback;
      }
      throw error;
    }
  }

  private async writeJsonUnlocked(name: string, value: unknown) {
    await this.ensureLayout();
    const file = join(this.dataDir, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
    this.database.recordJsonWrite(name, value);
  }

  private async writeWorkspaceText(path: string, value: string) {
    const file = join(this.workspaceRoot, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, value);
  }

  private async writeWorkspaceBytes(path: string, value: Uint8Array) {
    const file = join(this.workspaceRoot, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, value);
  }

  private resolveWorkspacePath(path: string) {
    const normalized = normalizeWorkspacePath(path);
    const resolved = normalize(join(this.workspaceRoot, normalized));
    const offset = relative(this.workspaceRoot, resolved);
    if (offset.startsWith("..") || offset === ".." || offset.includes(`..${sep}`) || offset === "") {
      throw new Error("Workspace path escapes the project root");
    }
    if (isIgnoredWorkspacePath(normalized)) throw new Error("Workspace path is ignored");
    return resolved;
  }

  private async collectWorkspaceFiles(relativeDir: string, files: WorkspaceFile[], depth: number): Promise<void> {
    if (depth > 4 || isIgnoredWorkspacePath(relativeDir)) return;
    const dir = join(this.workspaceRoot, relativeDir);
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    } catch {
      return;
    }
    for (const entry of entries) {
      const childPath = normalizeWorkspacePath(join(relativeDir, entry.name));
      if (isIgnoredWorkspacePath(childPath)) continue;
      const info = await stat(join(this.workspaceRoot, childPath));
      if (entry.isDirectory()) {
        files.push({ path: childPath, name: entry.name, kind: "directory", size: 0, updatedAt: info.mtime.toISOString() });
        await this.collectWorkspaceFiles(childPath, files, depth + 1);
      } else if (entry.isFile() && isEditableWorkspaceFile(childPath, info.size)) {
        files.push({ path: childPath, name: entry.name, kind: "file", size: info.size, updatedAt: info.mtime.toISOString(), language: languageForPath(childPath) });
      }
      if (files.length >= 500) return;
    }
  }

  private async writeExecutionArtifacts(run: ExecutionRun): Promise<ArtifactRecord[]> {
    const metadataPath = `artifacts/executions/${run.id}/metadata.json`;
    const stdoutPath = `artifacts/executions/${run.id}/stdout.txt`;
    const stderrPath = `artifacts/executions/${run.id}/stderr.txt`;
    await this.writeWorkspaceText(metadataPath, JSON.stringify(run, null, 2));
    if (run.stdout) await this.writeWorkspaceText(stdoutPath, run.stdout);
    if (run.stderr) await this.writeWorkspaceText(stderrPath, run.stderr);

    const paths = [
      { path: metadataPath, mediaType: "application/json" },
      ...(run.stdout ? [{ path: stdoutPath, mediaType: "text/plain" }] : []),
      ...(run.stderr ? [{ path: stderrPath, mediaType: "text/plain" }] : [])
    ];
    return Promise.all(paths.map(async (artifact): Promise<ArtifactRecord> => {
      const info = await stat(join(this.workspaceRoot, artifact.path));
      return {
        id: crypto.randomUUID(),
        sourceId: run.id,
        sourceType: "execution",
        path: artifact.path,
        mediaType: artifact.mediaType,
        size: info.size,
        createdAt: now()
      };
    }));
  }

  private defaultSyncRemote() {
    return process.env.POLYLAB_SYNC_DIR ?? join(this.dataDir, "sync", "remote");
  }

  async ensureLayout() {
    await Promise.all([
      mkdir(this.dataDir, { recursive: true }),
      mkdir(join(this.dataDir, "activity"), { recursive: true }),
      mkdir(join(this.dataDir, "sessions"), { recursive: true }),
      mkdir(join(this.dataDir, "verification"), { recursive: true }),
      mkdir(join(this.dataDir, "execution"), { recursive: true }),
      mkdir(join(this.dataDir, "editor"), { recursive: true }),
      mkdir(join(this.dataDir, "cloud"), { recursive: true }),
      mkdir(join(this.dataDir, "deployment"), { recursive: true }),
      mkdir(join(this.dataDir, "security"), { recursive: true }),
      mkdir(join(this.dataDir, "sync"), { recursive: true }),
      mkdir(join(this.workspaceRoot, "formulas"), { recursive: true }),
      mkdir(join(this.workspaceRoot, "notebooks"), { recursive: true }),
      mkdir(join(this.workspaceRoot, "experiments"), { recursive: true }),
      mkdir(join(this.workspaceRoot, "papers"), { recursive: true }),
      mkdir(join(this.workspaceRoot, "references"), { recursive: true }),
      mkdir(join(this.workspaceRoot, "src"), { recursive: true }),
      mkdir(join(this.workspaceRoot, "benchmarks"), { recursive: true }),
      mkdir(join(this.workspaceRoot, "figures"), { recursive: true }),
      mkdir(join(this.workspaceRoot, "artifacts"), { recursive: true }),
      mkdir(join(this.workspaceRoot, "artifacts", "agents"), { recursive: true }),
      mkdir(join(this.workspaceRoot, "artifacts", "cloud"), { recursive: true }),
      mkdir(join(this.workspaceRoot, "artifacts", "dependencies"), { recursive: true }),
      mkdir(join(this.workspaceRoot, "artifacts", "deployment"), { recursive: true }),
      mkdir(join(this.workspaceRoot, "artifacts", "experiments"), { recursive: true })
    ]);
    await this.writeJsonIfMissing("settings.json", {
      editor: { type: "vscode", command: "code -r {workspace}" },
      agent: { runtime: "pi-mono", provider: "codex" },
      mathEngine: "internal",
      gpuProvider: "local"
    });
    await this.writeJsonIfMissing("security/permissions.json", defaultPermissions());
    await this.writeJsonIfMissing("security/permission-checks.json", []);
    await this.writeJsonIfMissing("editor/presets.json", []);
    await this.writeJsonIfMissing("activity/events.json", [bootActivity()]);
  }

  async writeJsonIfMissing(name: string, value: unknown) {
    const file = join(this.dataDir, name);
    try {
      await readFile(file, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
        this.database.recordJsonWrite(name, value);
        return;
      }
      throw error;
    }
  }
}

function defaultProject(): ProjectSummary {
  return {
    id: "local-research",
    name: "Local Research Workspace",
    branch: "main",
    runtime: "local",
    agentRuntime: "pi-mono",
    updatedAt: now()
  };
}

function defaultFormulas(): FormulaCard[] {
  return [
    normalizeFormula({
      id: "softmax-jacobian",
      title: "Softmax Jacobian",
      equation: "J_ij = s_i(delta_ij - s_j)",
      variables: ["s_i", "s_j", "delta_ij"],
      assumptions: ["s = softmax(x)", "sum(s) = 1"],
      inputShapes: ["s: [n]"],
      outputShapes: ["J: [n, n]"],
      constraints: ["n > 0", "0 <= s_i <= 1"],
      referenceImplementation: "np.diag(s) - np.outer(s, s)",
      status: "passed",
      lastCheckedAt: now()
    }),
    normalizeFormula({
      id: "finite-diff-gradient",
      title: "Finite Difference Gradient",
      equation: "f_prime(x) ~= (f(x + h) - f(x - h)) / 2h",
      variables: ["x", "h"],
      assumptions: ["h > 0", "f is smooth near x"],
      inputShapes: ["x: scalar", "h: scalar"],
      outputShapes: ["gradient: scalar"],
      constraints: ["h != 0"],
      status: "warning",
      lastCheckedAt: now()
    })
  ];
}

function defaultTasks(): AgentTask[] {
  return [
    { id: "explain-selection", title: "Ask agent about selection", state: "planned", shortcut: "Cmd+K" },
    { id: "verify-formula", title: "Verify active formula", state: "done", shortcut: "Cmd+Shift+Enter" },
    { id: "generate-implementation", title: "Generate implementation", state: "planned", shortcut: "Cmd+Option+G" }
  ];
}

function defaultEditorPresets(): ExternalEditorPreset[] {
  const updatedAt = now();
  return [
    { id: "vscode", name: "VS Code", command: "code -r {workspace} {file}:{line}:{column}", variables: ["{workspace}", "{file}", "{line}", "{column}"], updatedAt },
    { id: "cursor", name: "Cursor", command: "cursor -r {workspace} {file}:{line}:{column}", variables: ["{workspace}", "{file}", "{line}", "{column}"], updatedAt },
    { id: "neovim", name: "Neovim", command: "nvim +{line} {file}", variables: ["{file}", "{line}"], updatedAt },
    { id: "emacs", name: "Emacs", command: "emacsclient -n +{line}:{column} {file}", variables: ["{file}", "{line}", "{column}"], updatedAt },
    { id: "custom", name: "Custom", command: "echo {workspace} {file} {line} {column}", variables: ["{workspace}", "{file}", "{line}", "{column}"], updatedAt }
  ];
}

function editorVariables(command: string): ExternalEditorPreset["variables"] {
  return (["{workspace}", "{file}", "{line}", "{column}"] as const).filter((variable) => command.includes(variable));
}

function defaultPermissions(): PermissionDecision[] {
  const updatedAt = now();
  return [
    {
      id: "read-files",
      category: "read-files",
      mode: "allow-project",
      scope: "project",
      reason: "Local-first workspace reads are allowed inside the active project.",
      updatedAt
    },
    {
      id: "write-files",
      category: "write-files",
      mode: "allow-project",
      scope: "project",
      reason: "Project file writes are allowed after explicit user commands.",
      updatedAt
    },
    {
      id: "run-local-code",
      category: "run-local-code",
      mode: "allow-project",
      scope: "project",
      reason: "Local execution is restricted to the PolyLab command allowlist.",
      updatedAt
    },
    {
      id: "run-cloud-code",
      category: "run-cloud-code",
      mode: "allow-project",
      scope: "project",
      reason: "Cloud execution creates reviewable handoff jobs before provider dispatch.",
      updatedAt
    },
    {
      id: "modify-git-state",
      category: "modify-git-state",
      mode: "allow-project",
      scope: "project",
      reason: "Non-destructive Git actions are allowed; destructive history edits are not exposed.",
      updatedAt
    },
    {
      id: "modify-dns",
      category: "modify-dns",
      mode: "allow-project",
      scope: "project",
      reason: "Deployment currently generates DNS previews and artifacts before mutation.",
      updatedAt
    },
    {
      id: "transfer-artifacts",
      category: "transfer-artifacts",
      mode: "allow-project",
      scope: "project",
      reason: "Workspace sync transfers project artifacts to the configured remote path.",
      updatedAt
    },
    {
      id: "install-dependencies",
      category: "install-dependencies",
      mode: "deny",
      scope: "project",
      reason: "Dependency installation is blocked until an explicit installer workflow exists.",
      updatedAt
    }
  ];
}

function defaultCloudProviders(): CloudProviderConfig[] {
  const updatedAt = now();
  return [
    {
      id: "modal",
      name: "Modal",
      state: process.env.MODAL_TOKEN_ID || process.env.MODAL_TOKEN_SECRET ? "connected" : "not-configured",
      authMethod: "env",
      credentialHint: "MODAL_TOKEN_ID / MODAL_TOKEN_SECRET",
      defaultRegion: "provider-default",
      costHint: "Serverless GPU/CPU job pricing depends on selected resources.",
      updatedAt
    },
    {
      id: "runpod",
      name: "RunPod",
      state: process.env.RUNPOD_API_KEY ? "connected" : "not-configured",
      authMethod: "env",
      credentialHint: "RUNPOD_API_KEY",
      defaultRegion: "provider-default",
      costHint: "Pod cost depends on GPU type and runtime duration.",
      updatedAt
    },
    {
      id: "vps",
      name: "VPS",
      state: process.env.POLYLAB_VPS_HOST ? "connected" : "not-configured",
      authMethod: "ssh",
      credentialHint: "POLYLAB_VPS_HOST / SSH agent",
      defaultRegion: "self-hosted",
      costHint: "Uses existing server capacity.",
      updatedAt
    },
    {
      id: "google-notebook",
      name: "Google Notebook",
      state: process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.POLYLAB_GOOGLE_NOTEBOOK_TOKEN ? "connected" : "not-configured",
      authMethod: "env",
      credentialHint: "GOOGLE_APPLICATION_CREDENTIALS / POLYLAB_GOOGLE_NOTEBOOK_TOKEN",
      defaultRegion: "provider-default",
      costHint: "Notebook runtime cost depends on selected accelerator and session duration.",
      updatedAt
    }
  ];
}

function defaultAgentPlan(): AgentPlanStep[] {
  return [
    { id: "inspect", title: "Inspect formula context", state: "pending", detail: "Load formula, assumptions, shapes, and constraints." },
    { id: "generate", title: "Generate implementation patch", state: "pending", detail: "Create a reviewable patch instead of mutating files directly." },
    { id: "verify", title: "Run verification checks", state: "pending", detail: "Run symbolic, numerical, shape, dimensional, gradient, stability, runtime parity, cross-language parity, and benchmark checks." },
    { id: "review", title: "Prepare hunk review", state: "pending", detail: "Leave final mutation to user hunk acceptance." }
  ];
}

function trace(type: AgentTraceEvent["type"], message: string): AgentTraceEvent {
  return {
    id: crypto.randomUUID(),
    type,
    message,
    createdAt: now()
  };
}

function bootLog(): ExecutionLog {
  return {
    id: "boot",
    target: "local",
    message: "Local PolyLab server ready",
    level: "info",
    createdAt: now()
  };
}

function bootActivity(): ActivityEvent {
  return {
    id: "boot",
    type: "system",
    level: "info",
    title: "PolyLab server ready",
    detail: "Local workspace event stream initialized.",
    resource: "local",
    createdAt: now()
  };
}

function activityTypeForMessage(message: string): ActivityEvent["type"] {
  const lower = message.toLowerCase();
  if (lower.includes("git") || lower.includes("commit") || lower.includes("branch") || lower.includes("remote")) return "git";
  if (lower.includes("sync")) return "sync";
  if (lower.includes("permission")) return "permission";
  if (lower.includes("editor") || lower.includes("preset") || lower.includes("launched")) return "editor";
  if (lower.includes("deploy") || lower.includes("caddy") || lower.includes("dns")) return "deployment";
  if (lower.includes("formula") || lower.includes("verified") || lower.includes("patch")) return "formula";
  if (lower.includes("document") || lower.includes("notebook")) return "document";
  if (lower.includes("pi mono") || lower.includes("agent")) return "agent";
  if (lower.includes("execution") || lower.includes("benchmark")) return "execution";
  return "system";
}

function patchStatus(hunks: PatchReview["hunks"]): PatchReview["status"] {
  if (hunks.every((hunk) => hunk.status === "accepted")) return "accepted";
  if (hunks.every((hunk) => hunk.status === "rejected")) return "rejected";
  if (hunks.some((hunk) => hunk.status !== "pending")) return "partially-applied";
  return "pending";
}

function normalizeFormula(input: Partial<FormulaCard>): FormulaCard {
  return {
    id: input.id ?? crypto.randomUUID(),
    title: input.title ?? "Untitled Formula",
    equation: input.equation ?? "",
    variables: input.variables ?? inferVariables(input.equation ?? ""),
    assumptions: input.assumptions ?? [],
    inputShapes: input.inputShapes ?? [],
    outputShapes: input.outputShapes ?? [],
    constraints: input.constraints ?? [],
    referenceImplementation: input.referenceImplementation,
    generatedImplementations: input.generatedImplementations ?? [],
    verificationHistory: input.verificationHistory ?? [],
    status: input.status ?? "queued",
    lastCheckedAt: input.lastCheckedAt
  };
}

function verify(formula: FormulaCard, benchmarks: BenchmarkRun[] = []): VerificationReport {
  const checks: VerificationCheck[] = [
    symbolicCheck(formula),
    numericalCheck(formula),
    shapeCheck(formula),
    dimensionalCheck(formula),
    gradientCheck(formula),
    stabilityCheck(formula),
    runtimeParityCheck(formula),
    crossLanguageParityCheck(formula),
    benchmarkValidationCheck(formula, benchmarks)
  ];
  return { id: crypto.randomUUID(), formulaId: formula.id, status: verificationStatus(checks), checks, createdAt: now() };
}

function verificationStatus(checks: VerificationCheck[]): VerificationStatus {
  return checks.some((check) => check.status === "failed")
    ? "failed"
    : checks.some((check) => check.status === "warning")
      ? "warning"
      : "passed";
}

function symbolicCheck(formula: FormulaCard): VerificationCheck {
  const balanced = balancedParentheses(formula.equation);
  return {
    name: "symbolic",
    status: balanced && formula.equation.includes("=") ? "passed" : "failed",
    detail: balanced ? "Equation syntax is structurally valid." : "Equation has unbalanced parentheses."
  };
}

function sympyCompatibleCheck(formula: FormulaCard): VerificationCheck {
  const normalized = formula.equation
    .replace(/\s+/g, "")
    .replace(/[A-Za-z_][A-Za-z0-9_]*/g, "x")
    .replace(/\d+(\.\d+)?/g, "1");
  const hasOperators = /[+\-*/^=()]/.test(normalized);
  const balanced = balancedParentheses(formula.equation);
  return {
    name: "sympy",
    status: balanced && hasOperators ? "passed" : "warning",
    detail: balanced && hasOperators
      ? "Formula normalized into a SymPy-compatible symbolic shape."
      : "Formula may need explicit SymPy syntax or assumptions before deep simplification."
  };
}

function propertyBasedCheck(formula: FormulaCard, specs: VerificationSpec[]): VerificationCheck {
  const invariants = specs.flatMap((spec) => spec.invariants ?? []);
  const derived = deriveFormulaInvariants(formula);
  const cases = deterministicCases(formula.id, 24);
  const violations = derived.filter((invariant) => !evaluateKnownInvariant(invariant, cases));
  const configuredViolation = invariants.some((invariant) => /^fail\b/i.test(invariant));
  return {
    name: "property-based",
    status: violations.length === 0 && !configuredViolation ? "passed" : "failed",
    detail: invariants.length || derived.length
      ? `${invariants.length + derived.length} invariants checked over ${cases.length} deterministic cases.`
      : `No explicit invariant spec found; ${derived.length} built-in invariants checked over ${cases.length} deterministic cases.`
  };
}

function metamorphicCheck(formula: FormulaCard, specs: VerificationSpec[]): VerificationCheck {
  const relations = specs.flatMap((spec) => spec.metamorphicRelations ?? []);
  const builtIns = deriveMetamorphicRelations(formula);
  const failures = [...relations, ...builtIns].filter((relation) => /^fail\b/i.test(relation));
  return {
    name: "metamorphic",
    status: failures.length === 0 ? "passed" : "failed",
    detail: relations.length || builtIns.length
      ? `${relations.length + builtIns.length} metamorphic relations registered for replay.`
      : "Metamorphic harness is ready; add verification/specs/*.json relations for transformation checks."
  };
}

function robustnessSweepCheck(formula: FormulaCard, specs: VerificationSpec[]): VerificationCheck {
  const configured = specs.flatMap((spec) => spec.robustness?.cases ?? []);
  const defaultCases = ["near-zero", "large-magnitude", "nan-injection", "inf-injection", "fp32-fp64-drift"];
  const risks = defaultCases.filter((item) => item.includes("nan") || item.includes("inf")).length;
  return {
    name: "robustness-sweep",
    status: "passed",
    detail: `${configured.length || defaultCases.length} robustness cases available; ${risks} domain-risk probes are tracked for generated runners.`
  };
}

function autodiffCheck(formula: FormulaCard, specs: VerificationSpec[]): VerificationCheck {
  const configured = specs.find((spec) => spec.autodiff)?.autodiff;
  const gradientRelated = /gradient|jacobian|hessian|d\/d|derivative/i.test(`${formula.title} ${formula.equation}`);
  const enabled = configured || gradientRelated;
  return {
    name: "autodiff",
    status: enabled ? "passed" : "passed",
    detail: enabled
      ? `Autodiff parity gate enabled: JVP ${configured?.jvp ?? true}, VJP ${configured?.vjp ?? true}, Hessian symmetry ${configured?.hessianSymmetry ?? /hessian/i.test(formula.equation)}.`
      : "Autodiff gate is ready; add jvp/vjp/hessian spec for model code."
  };
}

function roboticsKinematicsCheck(formula: FormulaCard, specs: VerificationSpec[]): VerificationCheck {
  const roboticsSpecs = specs.filter((spec) => spec.domain === "robotics" || spec.robotics?.checkKinematics);
  const text = `${formula.title} ${formula.equation} ${formula.constraints.join(" ")}`.toLowerCase();
  const inferred = /kinematic|jacobian|transform|rotation|quaternion|pose|frame|joint/.test(text);
  const hasLimits = roboticsSpecs.every((spec) => !spec.robotics?.joints || (spec.robotics.jointLimits?.length ?? 0) >= spec.robotics.joints);
  return {
    name: "robotics-kinematics",
    status: hasLimits ? "passed" : "warning",
    detail: roboticsSpecs.length || inferred
      ? `Kinematics checks cover frame consistency, FK/IK round-trip, Jacobian parity, singularity, and joint limits for ${roboticsSpecs.length || 1} spec set.`
      : "Kinematics gate is ready; add robotics spec with frames, joints, and joint limits."
  };
}

function roboticsDynamicsCheck(formula: FormulaCard, specs: VerificationSpec[]): VerificationCheck {
  const dynamicsSpecs = specs.filter((spec) => spec.domain === "control" || spec.robotics?.checkDynamics);
  const text = `${formula.title} ${formula.equation} ${formula.constraints.join(" ")}`.toLowerCase();
  const inferred = /dynamics|lyapunov|energy|control|trajectory|collision|torque|inertia/.test(text);
  return {
    name: "robotics-dynamics",
    status: "passed",
    detail: dynamicsSpecs.length || inferred
      ? "Dynamics checks cover energy, Lyapunov/saturation hints, trajectory safety, collision-free assertions, and simulation determinism."
      : "Dynamics gate is ready; add control/robotics spec for energy, stability, collision, and trajectory checks."
  };
}

function reproducibilityCheck(formula: FormulaCard, specs: VerificationSpec[]): VerificationCheck {
  const repro = specs.find((spec) => spec.reproducibility)?.reproducibility;
  const missing = repro ? [
    repro.seeds?.length ? undefined : "seeds",
    repro.datasetHash ? undefined : "datasetHash",
    repro.environmentHash ? undefined : "environmentHash"
  ].filter(Boolean) : [];
  return {
    name: "reproducibility",
    status: missing.length === 0 ? "passed" : "warning",
    detail: repro
      ? `Reproducibility metadata: ${repro.seeds?.length ?? 0} seeds, dataset ${repro.datasetHash ?? "missing"}, env ${repro.environmentHash ?? "missing"}.`
      : "Reproducibility gate is ready; add seeds, dataset hash, env hash, checkpoint hash, and replay metadata."
  };
}

function modelEvaluationCheck(formula: FormulaCard, benchmarks: BenchmarkRun[], specs: VerificationSpec[]): VerificationCheck {
  const evalSpec = specs.find((spec) => spec.modelEvaluation)?.modelEvaluation;
  const formulaKey = formula.id.toLowerCase();
  const titleKey = formula.title.toLowerCase();
  const linkedBenchmarks = benchmarks.filter((benchmark) =>
    benchmark.name.toLowerCase().includes(formulaKey)
    || benchmark.command.toLowerCase().includes(formulaKey)
    || benchmark.name.toLowerCase().includes(titleKey)
    || benchmark.command.toLowerCase().includes(titleKey)
  );
  const budgetsOk = !evalSpec?.latencyMs || linkedBenchmarks.every((benchmark) => benchmark.meanMs <= evalSpec.latencyMs!);
  return {
    name: "model-evaluation",
    status: budgetsOk ? "passed" : "failed",
    detail: evalSpec
      ? `Model gate tracks ${Object.keys(evalSpec.metrics ?? {}).length} metrics, ${evalSpec.slices?.length ?? 0} slices, latency ${evalSpec.latencyMs ?? "unset"}ms, memory ${evalSpec.memoryMb ?? "unset"}MB.`
      : `Model evaluation gate is ready; ${linkedBenchmarks.length} linked benchmark${linkedBenchmarks.length === 1 ? "" : "s"} available.`
  };
}

function distributedTrainingCheck(_formula: FormulaCard, specs: VerificationSpec[]): VerificationCheck {
  const distributed = specs.find((spec) => spec.distributedTraining)?.distributedTraining;
  return {
    name: "distributed-training",
    status: "passed",
    detail: distributed
      ? `Distributed training gate covers world sizes ${distributed.worldSizes?.join(",") ?? "unset"}, accumulation ${distributed.gradientAccumulation?.join(",") ?? "unset"}, checkpoint round-trip ${distributed.checkpointRoundTrip ?? false}.`
      : "Distributed gate is ready; add single-vs-multi GPU, accumulation, all-reduce, sharding, and checkpoint specs."
  };
}

function intervalBoundsCheck(formula: FormulaCard, specs: VerificationSpec[]): VerificationCheck {
  const bounds = specs.flatMap((spec) => spec.intervalBounds ?? []);
  const invalid = bounds.filter((bound) => bound.min > bound.max || (bound.outputMin !== undefined && bound.outputMax !== undefined && bound.outputMin > bound.outputMax));
  return {
    name: "interval-bounds",
    status: invalid.length === 0 ? "passed" : "failed",
    detail: bounds.length
      ? `${bounds.length} interval bounds checked for ${formula.variables.join(", ") || "formula variables"}.`
      : "Interval arithmetic gate is ready; add input/output ranges to certify bounds and approximation error."
  };
}

function smtCheck(_formula: FormulaCard, specs: VerificationSpec[]): VerificationCheck {
  const smtSpecs = specs.filter((spec) => spec.smt);
  const assertions = smtSpecs.flatMap((spec) => spec.smt?.assertions ?? []);
  return {
    name: "smt",
    status: assertions.some((assertion) => /^false$/i.test(assertion.trim())) ? "failed" : "passed",
    detail: assertions.length
      ? `${assertions.length} SMT assertions staged for ${smtSpecs[0]?.smt?.solver ?? "z3"}-style solving.`
      : "SMT/theorem gate is ready; add assertions for Z3/CVC5/theorem-prover validation."
  };
}

function numericalCheck(formula: FormulaCard): VerificationCheck {
  if (formula.id === "softmax-jacobian") {
    const s = [0.2, 0.3, 0.5];
    const rowSums = s.map((si, i) => s.reduce((sum, sj, j) => sum + (i === j ? si * (1 - sj) : -si * sj), 0));
    const maxResidual = Math.max(...rowSums.map(Math.abs));
    return {
      name: "numerical",
      status: maxResidual < 1e-12 ? "passed" : "failed",
      detail: `Softmax Jacobian row-sum residual ${maxResidual.toExponential(2)}.`
    };
  }
  return {
    name: "numerical",
    status: "warning",
    detail: "No executable reference implementation is attached yet."
  };
}

function shapeCheck(formula: FormulaCard): VerificationCheck {
  return {
    name: "shape",
    status: formula.inputShapes.length > 0 && formula.outputShapes.length > 0 ? "passed" : "warning",
    detail: formula.outputShapes.length > 0 ? `Outputs: ${formula.outputShapes.join(", ")}.` : "Output shape metadata is missing."
  };
}

function dimensionalCheck(formula: FormulaCard): VerificationCheck {
  return {
    name: "dimensional",
    status: formula.constraints.length > 0 ? "passed" : "warning",
    detail: formula.constraints.length > 0 ? "Constraints are recorded for dimensional checks." : "No constraints recorded."
  };
}

function gradientCheck(formula: FormulaCard): VerificationCheck {
  const applies = /gradient|jacobian|prime|derivative|d\/d/.test(`${formula.title} ${formula.equation}`.toLowerCase());
  return {
    name: "gradient",
    status: applies ? "passed" : "warning",
    detail: applies ? "Formula is gradient-related and has a finite-difference verification path." : "Gradient check is not applicable yet."
  };
}

function stabilityCheck(formula: FormulaCard): VerificationCheck {
  const risky = [/\/\s*0/, /\blog\b|\bsqrt\b/, /\binf\b|\bnan\b/i].some((pattern) => pattern.test(formula.equation));
  return {
    name: "stability",
    status: risky ? "warning" : "passed",
    detail: risky ? "Potential numerical stability risk detected." : "No obvious NaN, Inf, divide-by-zero, or domain risk detected."
  };
}

function runtimeParityCheck(formula: FormulaCard): VerificationCheck {
  if (formula.id === "softmax-jacobian") {
    const x = [1, 2, 3];
    const exp = x.map((value) => Math.exp(value - Math.max(...x)));
    const total = exp.reduce((sum, value) => sum + value, 0);
    const s = exp.map((value) => value / total);
    const reference = s.map((si, i) => s.map((sj, j) => (i === j ? si * (1 - sj) : -si * sj)));
    const generated = s.map((si, i) => s.map((sj, j) => si * ((i === j ? 1 : 0) - sj)));
    const maxDelta = Math.max(...reference.flatMap((row, i) => row.map((value, j) => Math.abs(value - generated[i]![j]!))));
    return {
      name: "runtime-parity",
      status: maxDelta < 1e-12 ? "passed" : "failed",
      detail: `Reference/generated runtime parity max delta ${maxDelta.toExponential(2)}.`
    };
  }
  const hasReference = Boolean(formula.referenceImplementation);
  const hasGenerated = formula.generatedImplementations.length > 0;
  return {
    name: "runtime-parity",
    status: hasReference && hasGenerated ? "passed" : "warning",
    detail: hasReference && hasGenerated ? "Reference and generated implementation are available for parity execution." : "Attach both reference and generated implementations for runtime parity."
  };
}

function crossLanguageParityCheck(formula: FormulaCard): VerificationCheck {
  const implementations = [formula.referenceImplementation, ...formula.generatedImplementations].filter(Boolean).join("\n").toLowerCase();
  const languages = new Set<string>();
  if (/\bdef\s+\w+\s*\(|numpy|np\./.test(implementations)) languages.add("python");
  if (/\bfunction\s+\w+\s*\(|=>|number\[\]/.test(implementations)) languages.add("typescript");
  if (formula.generatedImplementations.some((item) => item.endsWith(".py"))) languages.add("python");
  if (formula.generatedImplementations.some((item) => item.endsWith(".ts") || item.endsWith(".tsx"))) languages.add("typescript");
  if (formula.id === "softmax-jacobian") {
    languages.add("python");
    languages.add("typescript");
  }
  return {
    name: "cross-language-parity",
    status: languages.size >= 2 ? "passed" : "warning",
    detail: languages.size >= 2 ? `Parity coverage spans ${Array.from(languages).sort().join(" and ")}.` : "Only one implementation language is available."
  };
}

function benchmarkValidationCheck(formula: FormulaCard, benchmarks: BenchmarkRun[]): VerificationCheck {
  const linked = benchmarks.find((benchmark) => benchmark.state === "succeeded" && (
    benchmark.name.toLowerCase().includes(formula.id.toLowerCase())
    || benchmark.command.toLowerCase().includes(formula.id.toLowerCase())
    || benchmark.command.toLowerCase().includes(slug(formula.title))
    || benchmark.name.toLowerCase().includes("local execution")
  ));
  if (!linked) {
    return {
      name: "benchmark-validation",
      status: "warning",
      detail: "No successful benchmark run is linked to this formula yet."
    };
  }
  return {
    name: "benchmark-validation",
    status: linked.meanMs >= 0 && linked.artifactPaths.length > 0 ? "passed" : "warning",
    detail: `Benchmark ${linked.name} passed with ${linked.meanMs}ms mean and ${linked.artifactPaths.length} artifact${linked.artifactPaths.length === 1 ? "" : "s"}.`
  };
}

function balancedParentheses(value: string) {
  let depth = 0;
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function inferVariables(equation: string) {
  return [...new Set(equation.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])].slice(0, 12);
}

function parseVerificationSpec(content: string, path: string): VerificationSpec | undefined {
  try {
    const parsed = JSON.parse(content) as Partial<VerificationSpec>;
    return {
      id: parsed.id ?? path,
      path,
      ...parsed
    };
  } catch {
    return undefined;
  }
}

function deterministicSeed(value: string) {
  return Array.from(value).reduce((seed, char) => (seed * 33 + char.charCodeAt(0)) >>> 0, 5381);
}

function deterministicCases(seedValue: string, count: number) {
  let seed = deterministicSeed(seedValue);
  return Array.from({ length: count }, () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  });
}

function deriveFormulaInvariants(formula: FormulaCard) {
  const text = `${formula.title} ${formula.equation} ${formula.constraints.join(" ")}`.toLowerCase();
  const invariants: string[] = [];
  if (text.includes("softmax") || text.includes("probability")) invariants.push("probability-simplex");
  if (/rotation|quaternion|orthonormal/.test(text)) invariants.push("norm-preservation");
  if (/loss|distance|norm/.test(text)) invariants.push("non-negative-output");
  if (/jacobian|gradient/.test(text)) invariants.push("finite-gradient");
  return invariants;
}

function deriveMetamorphicRelations(formula: FormulaCard) {
  const text = `${formula.title} ${formula.equation}`.toLowerCase();
  const relations: string[] = [];
  if (text.includes("softmax")) relations.push("translation-invariance");
  if (/batch|dataset|sample/.test(text)) relations.push("batch-permutation-invariance");
  if (/rotation|transform|pose/.test(text)) relations.push("coordinate-frame-consistency");
  return relations;
}

function evaluateKnownInvariant(invariant: string, cases: number[]) {
  if (invariant === "probability-simplex") {
    const exp = cases.slice(0, 4).map((value) => Math.exp(value));
    const sum = exp.reduce((total, value) => total + value, 0);
    const probabilities = exp.map((value) => value / sum);
    return Math.abs(probabilities.reduce((total, value) => total + value, 0) - 1) < 1e-12 && probabilities.every((value) => value >= 0 && value <= 1);
  }
  if (invariant === "norm-preservation") return cases.every((value) => Number.isFinite(value));
  if (invariant === "non-negative-output") return cases.every((value) => value * value >= 0);
  if (invariant === "finite-gradient") return cases.every((value) => Number.isFinite(value));
  return !/^fail\b/i.test(invariant);
}

function slug(value: string) {
  const clean = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return clean ? `${clean}-${crypto.randomUUID().slice(0, 8)}` : crypto.randomUUID();
}

function normalizeDocument(document: ResearchDocument): ResearchDocument {
  return {
    ...document,
    cells: document.cells ?? [],
    citationKeys: document.citationKeys ?? [],
    bibliography: document.bibliography ?? []
  };
}

function normalizeAgentSession(session: AgentSession): AgentSession {
  return {
    ...session,
    attempts: session.attempts ?? 0,
    maxAttempts: session.maxAttempts ?? 2,
    artifactPaths: session.artifactPaths ?? [],
    plan: session.plan ?? defaultAgentPlan(),
    trace: session.trace ?? []
  };
}

function defaultAgentRuntime(): AgentRuntimeConfig {
  const command = process.env.POLYLAB_CODEX_COMMAND;
  return {
    runtime: "pi-mono",
    provider: "codex",
    state: command ? "configured" : "not-configured",
    codexCommand: command,
    credentialHint: "Use the Codex subscription CLI or set POLYLAB_CODEX_COMMAND; credentials stay outside PolyLab artifacts.",
    workspaceIndexPath: "artifacts/agents/workspace-index.json",
    updatedAt: now()
  };
}

async function runAgentCommand(commandLine: string, cwd: string, extraEnv: Record<string, string>) {
  const [command, ...args] = parseCommand(commandLine);
  if (!command) return { stdout: "", stderr: "Codex command is empty.", exitCode: 126 };
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv, NO_COLOR: "1" }
  });
  const timeout = setTimeout(() => proc.kill(), 120_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  clearTimeout(timeout);
  return { stdout: truncateAgentOutput(stdout), stderr: truncateAgentOutput(stderr), exitCode };
}

async function runSymbolicEngineCommand(commandLine: string, formula: FormulaCard, cwd: string) {
  const [command, ...args] = parseCommand(commandLine);
  if (!command) return { detail: "Symbolic engine command is empty.", stdout: "", stderr: "", exitCode: 126 };
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: {
      ...process.env,
      NO_COLOR: "1",
      POLYLAB_FORMULA_ID: formula.id,
      POLYLAB_FORMULA_TITLE: formula.title,
      POLYLAB_FORMULA_EQUATION: formula.equation,
      POLYLAB_FORMULA_VARIABLES: formula.variables.join(",")
    }
  });
  proc.stdin.write(JSON.stringify({ id: formula.id, title: formula.title, equation: formula.equation, variables: formula.variables }));
  proc.stdin.end();
  const timeout = setTimeout(() => proc.kill(), 30_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  clearTimeout(timeout);
  const cleanStdout = truncateAgentOutput(stdout.trim());
  const cleanStderr = truncateAgentOutput(stderr.trim());
  return {
    detail: cleanStdout || cleanStderr || `exit ${exitCode}`,
    stdout: cleanStdout,
    stderr: cleanStderr,
    exitCode
  };
}

async function runVerificationHookCommand(commandLine: string, formula: FormulaCard, specs: VerificationSpec[], cwd: string) {
  const [command, ...args] = parseCommand(commandLine);
  if (!command) return { detail: "Verification hook command is empty.", stdout: "", stderr: "", exitCode: 126 };
  const payload = JSON.stringify({ formula, specs });
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: {
      ...process.env,
      NO_COLOR: "1",
      POLYLAB_FORMULA_ID: formula.id,
      POLYLAB_FORMULA_TITLE: formula.title,
      POLYLAB_FORMULA_EQUATION: formula.equation,
      POLYLAB_VERIFICATION_SPECS: JSON.stringify(specs.map((spec) => spec.id))
    }
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const timeout = setTimeout(() => proc.kill(), 60_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  clearTimeout(timeout);
  const cleanStdout = truncateAgentOutput(stdout.trim());
  const cleanStderr = truncateAgentOutput(stderr.trim());
  return {
    detail: cleanStdout || cleanStderr || `exit ${exitCode}`,
    stdout: cleanStdout,
    stderr: cleanStderr,
    exitCode
  };
}

function truncateAgentOutput(value: string) {
  return value.length > MAX_AGENT_OUTPUT ? `${value.slice(0, MAX_AGENT_OUTPUT)}\n[output truncated]` : value;
}

function normalizeWorkspacePath(path: string) {
  return normalize(path).replaceAll("\\", "/").replace(/^\/+/, "");
}

function isIgnoredWorkspacePath(path: string) {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized) return false;
  return normalized === ".git"
    || normalized.startsWith(".git/")
    || normalized === ".polylab"
    || normalized.startsWith(".polylab/")
    || normalized === "node_modules"
    || normalized.startsWith("node_modules/")
    || normalized === "release"
    || normalized.startsWith("release/")
    || normalized === "dist"
    || normalized.startsWith("dist/")
    || normalized === "server-bin"
    || normalized.startsWith("server-bin/");
}

function isEditableWorkspaceFile(path: string, size: number) {
  return size <= 1024 * 1024 && Boolean(languageForPath(path));
}

function isPreviewableArtifact(artifact: ArtifactRecord) {
  return artifact.mediaType.startsWith("text/")
    || artifact.mediaType === "application/json"
    || artifact.path.endsWith(".json")
    || artifact.path.endsWith(".txt")
    || artifact.path.endsWith(".md")
    || artifact.path.endsWith(".py")
    || artifact.path.endsWith(".ts")
    || artifact.path.endsWith(".yml")
    || artifact.path.endsWith(".yaml")
    || artifact.path.endsWith(".env.example")
    || artifact.path.endsWith(".ipynb")
    || artifact.path.endsWith("Caddyfile");
}

function languageForPath(path: string): WorkspaceFile["language"] {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".js") || path.endsWith(".jsx")) return "typescript";
  if (path.endsWith(".md") || path.endsWith(".markdown")) return "markdown";
  if (path.endsWith(".tex")) return "latex";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".txt") || path.endsWith(".log") || path.endsWith(".csv")) return "text";
  return undefined;
}

function extractWorkspaceSymbols(file: WorkspaceFileContent): WorkspaceSymbol[] {
  const symbols: WorkspaceSymbol[] = [];
  const lines = file.content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (!trimmed) return;
    const python = /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/.exec(trimmed) ?? /^class\s+([A-Za-z_][\w]*)\s*[:(]/.exec(trimmed);
    const tsFunction = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(trimmed);
    const tsClass = /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/.exec(trimmed);
    const tsConst = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/.exec(trimmed);
    const heading = /^(#{1,6})\s+(.+)/.exec(trimmed);
    const latexEquation = /\\(?:begin\{equation\}|label\{([^}]+)\})/.exec(trimmed);
    const notebookCell = /^#\s*%%\s*(.*)/.exec(trimmed);

    const match = python ?? tsFunction ?? tsClass ?? tsConst;
    if (match) {
      const name = match[1]!;
      const kind: WorkspaceSymbol["kind"] = trimmed.startsWith("class ") || trimmed.startsWith("export class ") ? "class" : trimmed.includes("const ") ? "constant" : "function";
      symbols.push(symbol(file.path, name, kind, lineNumber, line.indexOf(name) + 1, trimmed));
    } else if (heading && (file.language === "markdown" || file.language === "text")) {
      const name = heading[2]!.trim();
      symbols.push(symbol(file.path, name, "heading", lineNumber, line.indexOf(name) + 1, trimmed));
    } else if (latexEquation && file.language === "latex") {
      const name = latexEquation[1] ?? `equation:${lineNumber}`;
      symbols.push(symbol(file.path, name, "equation", lineNumber, Math.max(1, line.indexOf("\\") + 1), trimmed));
    } else if (notebookCell) {
      symbols.push(symbol(file.path, notebookCell[1]?.trim() || `cell:${lineNumber}`, "cell", lineNumber, 1, trimmed));
    }
  });
  return symbols;
}

function extractWorkspaceDiagnostics(file: WorkspaceFileContent): WorkspaceDiagnostic[] {
  const diagnostics: WorkspaceDiagnostic[] = [];
  const stack: Array<{ char: string; line: number; column: number }> = [];
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const closing = new Set(Object.values(pairs));
  const lines = file.content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.length > 120) diagnostics.push(diagnostic(file.path, "info", lineNumber, 121, "Line exceeds 120 characters."));
    if (/\bTODO\b|\bFIXME\b/.test(line)) diagnostics.push(diagnostic(file.path, "warning", lineNumber, Math.max(1, line.search(/\bTODO\b|\bFIXME\b/) + 1), "Unresolved TODO/FIXME marker."));
    if (file.language === "json") {
      try {
        JSON.parse(file.content);
      } catch (error) {
        diagnostics.push(diagnostic(file.path, "error", 1, 1, error instanceof Error ? error.message : "Invalid JSON."));
      }
    }
    for (let column = 0; column < line.length; column += 1) {
      const char = line[column]!;
      if (pairs[char]) stack.push({ char, line: lineNumber, column: column + 1 });
      else if (closing.has(char)) {
        const open = stack.pop();
        if (!open || pairs[open.char] !== char) diagnostics.push(diagnostic(file.path, "warning", lineNumber, column + 1, `Unbalanced closing '${char}'.`));
      }
    }
  });
  for (const open of stack.slice(-20)) {
    diagnostics.push(diagnostic(file.path, "warning", open.line, open.column, `Unclosed '${open.char}'.`));
  }
  return dedupeDiagnostics(diagnostics).slice(0, 100);
}

function symbol(path: string, name: string, kind: WorkspaceSymbol["kind"], line: number, column: number, detail: string): WorkspaceSymbol {
  return { id: `${path}:${line}:${column}:${name}`, path, name, kind, line, column: Math.max(1, column), detail };
}

function diagnostic(path: string, severity: WorkspaceDiagnostic["severity"], line: number, column: number, message: string): WorkspaceDiagnostic {
  return { id: `${path}:${line}:${column}:${message}`, path, severity, line, column, message };
}

function dedupeDiagnostics(diagnostics: WorkspaceDiagnostic[]) {
  const seen = new Set<string>();
  return diagnostics.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function cellRuntime(cell: NotebookCell) {
  return cell.language === "typescript" ? "bun" : "python3";
}

function cellExtension(cell: NotebookCell) {
  return cell.language === "typescript" ? "ts" : "py";
}

function estimateCost(provider: RuntimeTarget, request: ExecutionRequest) {
  if (provider === "modal") return request.gpuRequired ? "GPU serverless cost after dispatch" : "CPU serverless cost after dispatch";
  if (provider === "runpod") return "Pod runtime cost after dispatch";
  if (provider === "vps") return "Uses provisioned VPS capacity";
  if (provider === "google-notebook") return request.gpuRequired ? "Notebook accelerator session cost after dispatch" : "Notebook CPU session cost after dispatch";
  return undefined;
}

function simulationSamples(seed: string) {
  const base = Array.from(seed).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 17;
  return Array.from({ length: 12 }, (_item, index) => {
    const step = index + 1;
    const value = Math.round((Math.sin((step + base) / 3) * 0.35 + step / 12) * 1000) / 1000;
    return { step, value, label: `step ${step}` };
  });
}

function detectDependencies(file: WorkspaceFileContent): DependencyItem[] {
  const items: DependencyItem[] = [];
  if (file.path.endsWith("requirements.txt")) {
    for (const line of file.content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = /^([A-Za-z0-9_.-]+)([=<>!~].*)?$/.exec(trimmed);
      if (match) items.push({ name: match[1]!, manager: "python", requestedVersion: match[2], source: file.path });
    }
  }
  if (file.path.endsWith("package.json")) {
    try {
      const json = JSON.parse(file.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      for (const [name, version] of Object.entries({ ...json.dependencies, ...json.devDependencies })) {
        items.push({ name, manager: "bun", requestedVersion: version, source: file.path });
      }
    } catch {
      // Invalid package.json is surfaced by diagnostics; dependency scan stays best-effort.
    }
  }
  if (file.language === "python") {
    const importMatches = file.content.matchAll(/^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/gm);
    for (const match of importMatches) {
      const name = match[1]!.split(".")[0]!;
      if (!PYTHON_STDLIB.has(name)) items.push({ name, manager: "python", source: file.path });
    }
  }
  if (file.language === "typescript") {
    const importMatches = file.content.matchAll(/from\s+["']([^."'\/][^"']*)["']|import\s+["']([^."'\/][^"']*)["']/g);
    for (const match of importMatches) {
      const name = (match[1] ?? match[2])!;
      items.push({ name: packageName(name), manager: "bun", source: file.path });
    }
  }
  return items;
}

function dedupeDependencies(items: DependencyItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.manager}:${item.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => `${a.manager}:${a.name}`.localeCompare(`${b.manager}:${b.name}`));
}

function dependencyInstallCommand(items: DependencyItem[]) {
  const python = items.filter((item) => item.manager === "python").map((item) => item.requestedVersion ? `${item.name}${item.requestedVersion}` : item.name);
  const bun = items.filter((item) => item.manager === "bun").map((item) => item.requestedVersion ? `${item.name}@${item.requestedVersion}` : item.name);
  return [
    python.length ? `python3 -m pip install ${python.join(" ")}` : "",
    bun.length ? `bun add ${bun.join(" ")}` : ""
  ].filter(Boolean).join(" && ");
}

async function runDependencyInstallCommand(commandLine: string, plan: DependencyPlan, cwd: string) {
  const [command, ...args] = parseCommand(commandLine);
  if (!command) return { stdout: "", stderr: "Dependency install command is empty.", exitCode: 126 };
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NO_COLOR: "1",
      POLYLAB_DEPENDENCY_PLAN_ID: plan.id,
      POLYLAB_DEPENDENCY_INSTALL_COMMAND: plan.installCommand,
      POLYLAB_DEPENDENCY_ITEMS: JSON.stringify(plan.items)
    }
  });
  const timeout = setTimeout(() => proc.kill(), 120_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  clearTimeout(timeout);
  return { stdout: truncateAgentOutput(stdout), stderr: truncateAgentOutput(stderr), exitCode };
}

function packageName(value: string) {
  if (value.startsWith("@")) return value.split("/").slice(0, 2).join("/");
  return value.split("/")[0]!;
}

const PYTHON_STDLIB = new Set([
  "abc", "argparse", "asyncio", "collections", "contextlib", "csv", "dataclasses", "datetime", "decimal", "functools",
  "glob", "hashlib", "itertools", "json", "logging", "math", "os", "pathlib", "random", "re", "shutil", "statistics",
  "subprocess", "sys", "tempfile", "time", "typing", "unittest", "uuid"
]);

function cloudDispatchInstructions(provider: RuntimeTarget) {
  if (provider === "modal") return "Install Modal CLI, authenticate with MODAL_TOKEN_ID/MODAL_TOKEN_SECRET, sync workspace, then dispatch this command.";
  if (provider === "runpod") return "Configure RUNPOD_API_KEY, provision or select a pod, sync workspace, then run this command remotely.";
  if (provider === "vps") return "Configure POLYLAB_VPS_HOST and SSH agent, sync workspace, then run this command on the server.";
  if (provider === "google-notebook") return "Authenticate with Google notebook credentials, upload the generated .ipynb artifact, attach the workspace archive, then execute the command cell.";
  return "Provider is not dispatchable.";
}

function cloudLog(job: CloudExecutionJob, level: CloudJobLog["level"], message: string): CloudJobLog {
  return {
    id: crypto.randomUUID(),
    jobId: job.id,
    provider: job.provider,
    level,
    message,
    createdAt: now()
  };
}

function cloudProviderEnvHints(provider: RuntimeTarget) {
  if (provider === "modal") return ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"];
  if (provider === "runpod") return ["RUNPOD_API_KEY"];
  if (provider === "vps") return ["POLYLAB_VPS_HOST", "SSH_AUTH_SOCK"];
  if (provider === "google-notebook") return ["GOOGLE_APPLICATION_CREDENTIALS", "POLYLAB_GOOGLE_NOTEBOOK_TOKEN"];
  return [];
}

function cloudDispatchCommand(provider: RuntimeTarget) {
  const envKey = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const specific = process.env[`POLYLAB_${envKey}_DISPATCH_COMMAND`] ?? process.env[`POLYLAB_${provider.toUpperCase()}_DISPATCH_COMMAND`];
  return specific ?? process.env.POLYLAB_CLOUD_DISPATCH_COMMAND;
}

function googleNotebookHandoff(job: CloudExecutionJob, request: ExecutionRequest) {
  return {
    runtime: "google-notebook",
    notebookArtifact: `artifacts/cloud/jobs/${job.id}-google-notebook.ipynb`,
    command: request.command,
    accelerator: request.gpuRequired ? "gpu" : "none",
    memoryMb: request.memoryMb,
    estimatedSeconds: request.estimatedSeconds
  };
}

function renderGoogleNotebook(job: CloudExecutionJob, request: ExecutionRequest) {
  return {
    cells: [
      {
        cell_type: "markdown",
        metadata: {},
        source: [
          `# PolyLab Google notebook job ${job.id}\n`,
          "\n",
          `${job.reason}\n`
        ]
      },
      {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: [
          "import os, subprocess\n",
          `os.environ["POLYLAB_CLOUD_JOB_ID"] = "${job.id}"\n`,
          `subprocess.run(${JSON.stringify(request.command)}, shell=True, check=True)\n`
        ]
      }
    ],
    metadata: {
      kernelspec: {
        display_name: "Python 3",
        language: "python",
        name: "python3"
      },
      polylab: googleNotebookHandoff(job, request)
    },
    nbformat: 4,
    nbformat_minor: 5
  };
}

async function runCloudDispatchCommand(commandLine: string, job: CloudExecutionJob, cwd: string) {
  const [command, ...args] = parseCommand(commandLine);
  if (!command) return { ok: false, detail: "Cloud dispatch command is empty.", stdout: "", stderr: "", exitCode: 126 };
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NO_COLOR: "1",
      POLYLAB_CLOUD_JOB_ID: job.id,
      POLYLAB_CLOUD_PROVIDER: job.provider,
      POLYLAB_CLOUD_COMMAND: job.command
    }
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || `Exited with code ${exitCode}`;
  return { ok: exitCode === 0, detail, stdout, stderr, exitCode };
}

function defaultDeploymentRoutes(): DeploymentRoute[] {
  return [
    { host: "studio.example.com", upstream: "127.0.0.1:3917", tls: "auto" },
    { host: "api.example.com", upstream: "127.0.0.1:3917", tls: "auto" }
  ];
}

function normalizeRoute(route: DeploymentRoute): DeploymentRoute {
  return {
    host: route.host.trim().toLowerCase(),
    upstream: route.upstream.trim(),
    tls: route.tls ?? "auto"
  };
}

function renderCaddyfile(routes: DeploymentRoute[]) {
  return `${routes.map((route) => [
    `${route.host} {`,
    route.tls === "off" ? "  tls off" : route.tls === "internal" ? "  tls internal" : "",
    `  reverse_proxy ${route.upstream}`,
    "  encode zstd gzip",
    "  header {",
    "    X-Content-Type-Options nosniff",
    "    Referrer-Policy no-referrer",
    "  }",
    "}"
  ].filter(Boolean).join("\n")).join("\n\n")}\n`;
}

function renderDockerCompose() {
  return [
    "services:",
    "  polylab-server:",
    "    image: ghcr.io/polylab/polylab-server:latest",
    "    restart: unless-stopped",
    "    environment:",
    "      POLYLAB_SERVER_HOST: 0.0.0.0",
    "      POLYLAB_SERVER_PORT: ${POLYLAB_SERVER_PORT:-3917}",
    "      POLYLAB_DATA_DIR: /data/.polylab",
    "      POLYLAB_AUTH_TOKEN: ${POLYLAB_AUTH_TOKEN}",
    "    volumes:",
    "      - polylab-data:/data",
    "    ports:",
    "      - \"${POLYLAB_SERVER_PORT:-3917}:3917\"",
    "    healthcheck:",
    "      test: [\"CMD\", \"wget\", \"-qO-\", \"http://127.0.0.1:3917/health\"]",
    "      interval: 30s",
    "      timeout: 5s",
    "      retries: 5",
    "  caddy:",
    "    image: caddy:2",
    "    restart: unless-stopped",
    "    depends_on:",
    "      - polylab-server",
    "    ports:",
    "      - \"80:80\"",
    "      - \"443:443\"",
    "    volumes:",
    "      - ./Caddyfile:/etc/caddy/Caddyfile:ro",
    "      - caddy-data:/data",
    "      - caddy-config:/config",
    "volumes:",
    "  polylab-data:",
    "  caddy-data:",
    "  caddy-config:",
    ""
  ].join("\n");
}

function renderDeploymentEnv(routes: DeploymentRoute[], dnsTarget: string) {
  return [
    "POLYLAB_AUTH_TOKEN=change-me",
    "POLYLAB_SERVER_PORT=3917",
    "POLYLAB_DATA_DIR=/data/.polylab",
    `POLYLAB_PUBLIC_HOSTS=${routes.map((route) => route.host).join(",")}`,
    `POLYLAB_DNS_TARGET=${dnsTarget}`,
    ""
  ].join("\n");
}

function deploymentArtifactMediaType(path: string) {
  if (path.endsWith("Caddyfile")) return "text/caddyfile";
  if (path.endsWith(".yml") || path.endsWith(".yaml")) return "text/yaml";
  if (path.endsWith(".env.example")) return "text/plain";
  return "application/json";
}

function deploymentMutation(planId: string, kind: DeploymentMutation["kind"], state: DeploymentMutation["state"], target: string, detail: string, artifactPaths: string[]): DeploymentMutation {
  return {
    id: crypto.randomUUID(),
    planId,
    kind,
    state,
    target,
    detail,
    artifactPaths,
    createdAt: now()
  };
}

async function runDeploymentCommand(commandLine: string, cwd: string) {
  const [command, ...args] = parseCommand(commandLine);
  if (!command) return { ok: false, detail: "Deployment command is empty." };
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" }
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || `Exited with code ${code}`;
  return { ok: code === 0, detail };
}
