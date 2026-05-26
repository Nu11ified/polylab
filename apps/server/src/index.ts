import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import type { AgentRuntimeConfig, BenchmarkRequest, CloudProviderConfig, DeploymentRoute, ExecutionRequest, FormulaCard, PermissionCategory, PermissionMode, ProjectSummary, ResearchDocument } from "@polylab/types";
import { authStatus, isAuthorizedRequest } from "./auth";
import { routeExecution, runExecution } from "./execution";
import { gitAddRemote, gitBranches, gitCheckoutBranch, gitClone, gitCommit, gitConflicts, gitCreateBranch, gitDiff, gitInit, gitPull, gitPush, gitRemotes, gitResolveConflict, gitStageAll, gitStatus } from "./git";
import { WorkspaceStore } from "./store";

const now = () => new Date().toISOString();

export function createApp(store = new WorkspaceStore()) {
  return new Elysia()
  .use(cors())
  .onBeforeHandle(({ request, set }) => {
    if (!isAuthorizedRequest(request)) {
      set.status = 401;
      set.headers["www-authenticate"] = "Bearer";
      return { error: "Authentication required" };
    }
    return undefined;
  })
  .onError(({ error, set }) => {
    if (error instanceof Error && error.message.startsWith("Permission denied")) {
      set.status = 403;
      return { error: error.message };
    }
    throw error;
  })
  .get("/health", () => ({ ok: true, service: "polylab-server", at: now() }))
  .get("/api/auth/status", () => authStatus())
  .get("/api/workspace", () => store.snapshot())
  .get("/api/permissions", () => store.permissions())
  .get("/api/permissions/checks", () => store.permissionChecks())
  .post("/api/permissions", async ({ body, set }) => {
    const payload = body as { category?: PermissionCategory; mode?: PermissionMode; reason?: string; scope?: "project" | "session" };
    if (!payload.category || !payload.mode) {
      set.status = 400;
      return { error: "Permission category and mode are required" };
    }
    return store.setPermission({ category: payload.category, mode: payload.mode, reason: payload.reason, scope: payload.scope });
  })
  .get("/api/persistence/status", () => store.persistenceStatus())
  .get("/api/persistence/events", ({ query }) => store.persistenceEvents(Number(query.limit ?? 50)))
  .get("/api/activity/events", ({ query }) => store.activityEvents().then((events) => events.slice(0, Math.max(1, Math.min(200, Number(query.limit ?? 100))))))
  .get("/api/projects", () => store.projects())
  .post("/api/projects", ({ body }) => store.upsertProject(body as Partial<ProjectSummary>))
  .get("/api/projects/:id", ({ params }) => store.project(params.id))
  .get("/api/files", async () => {
    await store.requirePermission("read-files", "index workspace files", store.workspaceRoot);
    return store.workspaceFiles();
  })
  .get("/api/files/symbols", async () => {
    await store.requirePermission("read-files", "index workspace symbols", store.workspaceRoot);
    return store.workspaceSymbols();
  })
  .get("/api/files/diagnostics", async () => {
    await store.requirePermission("read-files", "index workspace diagnostics", store.workspaceRoot);
    return store.workspaceDiagnostics();
  })
  .get("/api/files/read", async ({ query, set }) => {
    const path = String(query.path ?? "");
    if (!path) {
      set.status = 400;
      return { error: "File path is required" };
    }
    try {
      await store.requirePermission("read-files", "read workspace file", path);
      return await store.readWorkspaceFile(path);
    } catch (error) {
      set.status = error instanceof Error && error.message.startsWith("Permission denied") ? 403 : 400;
      return { error: error instanceof Error ? error.message : "File read failed" };
    }
  })
  .post("/api/files/write", async ({ body, set }) => {
    const payload = body as { path?: string; content?: string };
    if (!payload.path || typeof payload.content !== "string") {
      set.status = 400;
      return { error: "File path and content are required" };
    }
    try {
      await store.requirePermission("write-files", "write workspace file", payload.path);
      return await store.writeWorkspaceFile(payload.path, payload.content);
    } catch (error) {
      set.status = error instanceof Error && error.message.startsWith("Permission denied") ? 403 : 400;
      return { error: error instanceof Error ? error.message : "File write failed" };
    }
  })
  .get("/api/editor/presets", () => store.editorPresets())
  .post("/api/editor/presets", async ({ body, set }) => {
    try {
      const payload = body as { id?: string; name?: string; command?: string };
      if (!payload.id || !payload.name || !payload.command) {
        set.status = 400;
        return { error: "Editor preset id, name, and command are required" };
      }
      await store.requirePermission("write-files", "save editor preset", payload.id);
      return await store.saveEditorPreset({ id: payload.id, name: payload.name, command: payload.command });
    } catch (error) {
      set.status = error instanceof Error && error.message.startsWith("Permission denied") ? 403 : 400;
      return { error: error instanceof Error ? error.message : "Editor preset save failed" };
    }
  })
  .post("/api/editor/open", async ({ body, set }) => {
    try {
      const payload = body as { presetId?: string; path?: string; line?: number; column?: number; dryRun?: boolean };
      await store.requirePermission("read-files", "open external editor", payload.path ?? store.workspaceRoot);
      return await store.launchEditor(payload);
    } catch (error) {
      set.status = error instanceof Error && error.message.startsWith("Permission denied") ? 403 : 400;
      return { error: error instanceof Error ? error.message : "Editor launch failed" };
    }
  })
  .get("/api/formulas", () => store.formulas())
  .post("/api/formulas", async ({ body }) => {
    await store.requirePermission("write-files", "create formula", "formulas.json");
    return store.createFormula(body as Partial<FormulaCard>);
  })
  .patch("/api/formulas/:id", ({ params, body, set }) => store.updateFormula(params.id, body as Partial<FormulaCard>).then((formula) => {
    if (!formula) {
      set.status = 404;
      return { error: "Formula not found" };
    }
    return formula;
  }))
  .post("/api/formulas/:id/verify", async ({ params, set }) => {
    const formula = await store.verifyFormula(params.id);
    if (!formula) {
      set.status = 404;
      return { error: "Formula not found" };
    }
    return formula;
  })
  .get("/api/documents", () => store.documents())
  .post("/api/documents", async ({ body }) => {
    const document = body as Partial<ResearchDocument>;
    await store.requirePermission("write-files", "write document", document.path ?? "documents.json");
    return store.upsertDocument(document);
  })
  .post("/api/documents/:id/render", async ({ params, set }) => {
    const document = await store.renderDocument(params.id);
    if (!document) {
      set.status = 404;
      return { error: "Document not found" };
    }
    return document;
  })
  .post("/api/documents/:id/cells/:cellId/run", async ({ params, set }) => {
    await store.requirePermission("run-local-code", "run notebook cell", `${params.id}/${params.cellId}`);
    const document = await store.runNotebookCell(params.id, params.cellId);
    if (!document) {
      set.status = 404;
      return { error: "Notebook cell not found" };
    }
    return document;
  })
  .post("/api/documents/:id/export-script", async ({ params, set }) => {
    await store.requirePermission("write-files", "export notebook script", params.id);
    const exported = await store.exportNotebookScript(params.id);
    if (!exported) {
      set.status = 404;
      return { error: "Notebook not found" };
    }
    return exported;
  })
  .post("/api/documents/:id/export-pdf", async ({ params, set }) => {
    await store.requirePermission("write-files", "export document PDF", params.id);
    const exported = await store.exportDocumentPdf(params.id);
    if (!exported) {
      set.status = 404;
      return { error: "Document not found" };
    }
    return exported;
  })
  .post("/api/formulas/:id/generate", async ({ params, set }) => {
    const patch = await store.generatePatchForFormula(params.id);
    if (!patch) {
      set.status = 404;
      return { error: "Formula not found" };
    }
    return patch;
  })
  .get("/api/patches", () => store.patches())
  .post("/api/patches/formulas/:id/generate", async ({ params, set }) => {
    const patch = await store.generatePatchForFormula(params.id);
    if (!patch) {
      set.status = 404;
      return { error: "Formula not found" };
    }
    return patch;
  })
  .post("/api/patches/:patchId/hunks/:hunkId/:decision", async ({ params, set }) => {
    if (params.decision !== "accepted" && params.decision !== "rejected") {
      set.status = 400;
      return { error: "Patch decision must be accepted or rejected" };
    }
    try {
      if (params.decision === "accepted") {
        await store.requirePermission("write-files", "accept patch hunk", `${params.patchId}/${params.hunkId}`);
      }
      const patch = await store.updatePatchHunk(params.patchId, params.hunkId, params.decision);
      if (!patch) {
        set.status = 404;
        return { error: "Patch hunk not found" };
      }
      return patch;
    } catch (error) {
      set.status = 409;
      return { error: error instanceof Error ? error.message : "Patch failed" };
    }
  })
  .get("/api/agents/sessions", () => store.agentSessions())
  .get("/api/agents/runtime", () => store.agentRuntime())
  .post("/api/agents/runtime", async ({ body }) => {
    await store.requirePermission("write-files", "configure agent runtime", "sessions/agent-runtime.json");
    return store.configureAgentRuntime(body as Partial<AgentRuntimeConfig>);
  })
  .get("/api/agents/handoffs", () => store.agentHandoffs())
  .post("/api/agents/session", ({ body }) => store.createAgentSession(body as { title?: string; formulaId?: string }))
  .post("/api/agents/sessions/:id/run", async ({ params, body, set }) => {
    const session = await store.runAgentSession(params.id, body as { formulaId?: string; message?: string });
    if (!session) {
      set.status = 404;
      return { error: "Agent session not found" };
    }
    return session;
  })
  .post("/api/agents/sessions/:id/handoff", async ({ params, body, set }) => {
    try {
      await store.requirePermission("run-local-code", "dispatch codex handoff", params.id);
      const handoff = await store.dispatchAgentHandoff(params.id, body as { message?: string; command?: string });
      if (!handoff) {
        set.status = 404;
        return { error: "Agent session not found" };
      }
      return handoff;
    } catch (error) {
      set.status = error instanceof Error && error.message.startsWith("Permission denied") ? 403 : 400;
      return { error: error instanceof Error ? error.message : "Agent handoff failed" };
    }
  })
  .post("/api/agents/sessions/:id/export-replay", async ({ params, set }) => {
    try {
      const session = await store.exportAgentReplay(params.id);
      return session;
    } catch (error) {
      set.status = 404;
      return { error: error instanceof Error ? error.message : "Agent session not found" };
    }
  })
  .post("/api/agents/message", async ({ body }) => {
    const payload = body as { sessionId?: string; formulaId?: string; message?: string };
    const session = payload.sessionId
      ? await store.runAgentSession(payload.sessionId, payload)
      : await store.createAgentSession({ formulaId: payload.formulaId, title: payload.message ?? "Agent task" }).then((created) => store.runAgentSession(created.id, payload));
    return session;
  })
  .get("/api/agents/tasks", () => store.tasks())
  .get("/api/agents/events", async function* () {
    const events = await store.activityEvents();
    yield { event: "ready", data: { runtime: "pi-mono", at: now() } };
    for (const event of events.slice(0, 25)) {
      yield { event: event.type, data: event };
    }
  })
  .post("/api/execution/route", ({ body }) => routeExecution(body as ExecutionRequest))
  .post("/api/execution/run", async ({ body, set }) => {
    const request = body as Partial<ExecutionRequest>;
    if (!request.command) {
      set.status = 400;
      return { error: "Execution command is required" };
    }
    await store.ensureLayout();
    const executionRequest = { target: "auto", ...request, command: request.command } satisfies ExecutionRequest;
    const route = routeExecution(executionRequest);
    if (route.target !== "local" && route.target !== "docker") {
      await store.requirePermission("run-cloud-code", "queue cloud execution", `${route.target}:${executionRequest.command}`);
      const job = await store.queueCloudExecution(executionRequest, route);
      const run = {
        id: crypto.randomUUID(),
        command: executionRequest.command,
        route,
        state: "queued" as const,
        stdout: "",
        stderr: `Queued ${route.target} cloud execution job ${job.id}.`,
        startedAt: job.createdAt,
        finishedAt: job.updatedAt,
        cloudJobId: job.id
      };
      return store.recordExecution(run);
    }
    await store.requirePermission("run-local-code", route.target === "docker" ? "run docker sandbox" : "run local command", executionRequest.command);
    const run = await runExecution(executionRequest, store.workspaceRoot);
    return store.recordExecution(run);
  })
  .get("/api/execution/runs", () => store.executions())
  .get("/api/execution/logs", () => store.logs())
  .get("/api/dependencies/plans", () => store.dependencyPlans())
  .post("/api/dependencies/scan", async () => {
    await store.requirePermission("read-files", "scan dependency manifests", store.workspaceRoot);
    return store.scanDependencies();
  })
  .post("/api/dependencies/plans/:id/apply", async ({ params, set }) => {
    await store.requirePermission("install-dependencies", "apply dependency install plan", params.id);
    const plan = await store.applyDependencyPlan(params.id);
    if (!plan) {
      set.status = 404;
      return { error: "Dependency plan not found" };
    }
    return plan;
  })
  .get("/api/experiments", () => store.experiments())
  .post("/api/experiments/run", async ({ body }) => {
    const request = body as Partial<ExecutionRequest> & { name?: string; formulaId?: string };
    const command = request.command ?? "python3 experiments/simulation.py";
    const route = routeExecution({ target: request.target ?? "auto", command, gpuRequired: request.gpuRequired, estimatedSeconds: request.estimatedSeconds, memoryMb: request.memoryMb, allowNetwork: request.allowNetwork, sandbox: request.sandbox, dockerImage: request.dockerImage });
    await store.requirePermission(route.target === "local" || route.target === "docker" ? "run-local-code" : "run-cloud-code", "run experiment", command);
    return store.runExperiment({ ...request, command });
  })
  .get("/api/cloud/providers", () => store.cloudProviders())
  .post("/api/cloud/providers", async ({ body, set }) => {
    try {
      await store.requirePermission("run-cloud-code", "configure cloud provider", (body as Partial<CloudProviderConfig>).id ?? "unknown");
      return await store.configureCloudProvider(body as Partial<CloudProviderConfig> & { id: CloudProviderConfig["id"] });
    } catch (error) {
      set.status = 400;
      return { error: error instanceof Error ? error.message : "Cloud provider configuration failed" };
    }
  })
  .get("/api/cloud/jobs", () => store.cloudJobs())
  .get("/api/cloud/logs", ({ query }) => store.cloudLogs(query.jobId ? String(query.jobId) : undefined))
  .post("/api/cloud/jobs/:id/dispatch", async ({ params, set }) => {
    await store.requirePermission("run-cloud-code", "dispatch cloud job", params.id);
    const result = await store.dispatchCloudJob(params.id);
    if (!result) {
      set.status = 404;
      return { error: "Cloud job not found" };
    }
    return result;
  })
  .post("/api/cloud/jobs/:id/cancel", async ({ params, set }) => {
    await store.requirePermission("run-cloud-code", "cancel cloud job", params.id);
    const result = await store.cancelCloudJob(params.id);
    if (!result) {
      set.status = 404;
      return { error: "Cloud job not found" };
    }
    return result;
  })
  .get("/api/deployment/plans", () => store.deploymentPlans())
  .get("/api/deployment/mutations", () => store.deploymentMutations())
  .post("/api/deployment/plan", async ({ body }) => {
    const payload = body as { name?: string; routes?: DeploymentRoute[]; dnsTarget?: string } | undefined;
    await store.requirePermission("modify-dns", "preview deployment DNS", payload?.routes?.map((route) => route.host).join(",") ?? "default-routes");
    return store.createDeploymentPlan(payload);
  })
  .post("/api/deployment/plans/:id/apply", async ({ params, body, set }) => {
    const payload = body as { applyDns?: boolean; reloadCaddy?: boolean; dryRun?: boolean } | undefined;
    await store.requirePermission("modify-dns", "apply deployment plan", params.id);
    const result = await store.applyDeploymentPlan(params.id, payload);
    if (!result) {
      set.status = 404;
      return { error: "Deployment plan not found" };
    }
    return result;
  })
  .post("/api/deployment/plans/:id/rollback", async ({ params, set }) => {
    await store.requirePermission("modify-dns", "rollback deployment plan", params.id);
    const result = await store.rollbackDeploymentPlan(params.id);
    if (!result) {
      set.status = 404;
      return { error: "Deployment plan not found" };
    }
    return result;
  })
  .get("/api/artifacts", () => store.artifacts())
  .get("/api/artifacts/:id/read", async ({ params, set }) => {
    try {
      await store.requirePermission("read-files", "read artifact", params.id);
      const artifact = await store.readArtifact(params.id);
      if (!artifact) {
        set.status = 404;
        return { error: "Artifact not found" };
      }
      return artifact;
    } catch (error) {
      set.status = error instanceof Error && error.message.startsWith("Permission denied") ? 403 : 400;
      return { error: error instanceof Error ? error.message : "Artifact read failed" };
    }
  })
  .get("/api/benchmarks", () => store.benchmarks())
  .post("/api/benchmarks/run", async ({ body, set }) => {
    const request = body as Partial<BenchmarkRequest>;
    if (!request.command) {
      set.status = 400;
      return { error: "Benchmark command is required" };
    }
    const route = routeExecution({ target: request.target ?? "auto", command: request.command, memoryMb: request.memoryMb, gpuRequired: request.gpuRequired });
    await store.requirePermission(route.target === "local" ? "run-local-code" : "run-cloud-code", "run benchmark", request.command);
    return store.runBenchmark({
      name: request.name ?? "Workspace benchmark",
      command: request.command,
      iterations: request.iterations,
      target: request.target,
      memoryMb: request.memoryMb,
      gpuRequired: request.gpuRequired
    });
  })
  .get("/api/git/status", async () => {
    await store.ensureLayout();
    return gitStatus(store.workspaceRoot);
  })
  .get("/api/git/diff", async () => {
    await store.ensureLayout();
    return gitDiff(store.workspaceRoot);
  })
  .get("/api/git/conflicts", async () => {
    await store.ensureLayout();
    return gitConflicts(store.workspaceRoot);
  })
  .get("/api/git/verification-summary", () => store.gitVerificationSummary())
  .post("/api/git/init", async () => {
    await store.ensureLayout();
    await store.requirePermission("modify-git-state", "git init", store.workspaceRoot);
    const status = await gitInit(store.workspaceRoot);
    await store.addLog("Initialized Git repository", "info");
    return status;
  })
  .get("/api/git/remotes", async () => {
    await store.ensureLayout();
    return gitRemotes(store.workspaceRoot);
  })
  .get("/api/git/branches", async () => {
    await store.ensureLayout();
    return gitBranches(store.workspaceRoot);
  })
  .post("/api/git/remote", async ({ body, set }) => {
    await store.ensureLayout();
    const payload = body as { name?: string; url?: string };
    if (!payload.url) {
      set.status = 400;
      return { error: "Remote URL is required" };
    }
    try {
      await store.requirePermission("modify-git-state", "git remote", payload.name ?? "origin");
      const result = await gitAddRemote(store.workspaceRoot, payload.name ?? "origin", payload.url);
      await store.addLog(result.message, "info");
      return result;
    } catch (error) {
      set.status = 400;
      return { error: error instanceof Error ? error.message : "Git remote failed" };
    }
  })
  .post("/api/git/branch", async ({ body, set }) => {
    await store.ensureLayout();
    const payload = body as { name?: string; checkout?: boolean };
    if (!payload.name) {
      set.status = 400;
      return { error: "Branch name is required" };
    }
    try {
      await store.requirePermission("modify-git-state", "git branch", payload.name);
      const result = payload.checkout === false
        ? await gitCreateBranch(store.workspaceRoot, payload.name)
        : await gitCreateBranch(store.workspaceRoot, payload.name);
      await store.addLog(result.message, "info");
      return result;
    } catch (error) {
      set.status = 400;
      return { error: error instanceof Error ? error.message : "Git branch failed" };
    }
  })
  .post("/api/git/checkout", async ({ body, set }) => {
    await store.ensureLayout();
    const payload = body as { branch?: string };
    if (!payload.branch) {
      set.status = 400;
      return { error: "Branch name is required" };
    }
    try {
      await store.requirePermission("modify-git-state", "git checkout", payload.branch);
      const result = await gitCheckoutBranch(store.workspaceRoot, payload.branch);
      await store.addLog(result.message, "info");
      return result;
    } catch (error) {
      set.status = 400;
      return { error: error instanceof Error ? error.message : "Git checkout failed" };
    }
  })
  .post("/api/git/push", async ({ body, set }) => {
    await store.ensureLayout();
    const payload = body as { remote?: string; branch?: string };
    try {
      await store.requirePermission("modify-git-state", "git push", `${payload.remote ?? "default"}/${payload.branch ?? "current"}`);
      const result = await gitPush(store.workspaceRoot, payload.remote, payload.branch);
      await store.addLog("Pushed Git branch", "info");
      return result;
    } catch (error) {
      set.status = 409;
      return { error: error instanceof Error ? error.message : "Git push failed" };
    }
  })
  .post("/api/git/pull", async ({ body, set }) => {
    await store.ensureLayout();
    const payload = body as { remote?: string; branch?: string };
    try {
      await store.requirePermission("modify-git-state", "git pull", `${payload.remote ?? "default"}/${payload.branch ?? "current"}`);
      const result = await gitPull(store.workspaceRoot, payload.remote, payload.branch);
      await store.addLog("Pulled Git branch", "info");
      return result;
    } catch (error) {
      set.status = 409;
      return { error: error instanceof Error ? error.message : "Git pull failed" };
    }
  })
  .post("/api/git/conflicts/resolve", async ({ body, set }) => {
    await store.ensureLayout();
    const payload = body as { path?: string; strategy?: "ours" | "theirs" | "manual"; content?: string };
    if (!payload.path || !payload.strategy) {
      set.status = 400;
      return { error: "Conflict path and strategy are required" };
    }
    try {
      await store.requirePermission("modify-git-state", "resolve git conflict", `${payload.path}:${payload.strategy}`);
      const result = await gitResolveConflict(store.workspaceRoot, payload.path, payload.strategy, payload.content);
      await store.addLog(result.message, "info");
      return result;
    } catch (error) {
      set.status = 409;
      return { error: error instanceof Error ? error.message : "Git conflict resolution failed" };
    }
  })
  .post("/api/git/clone", async ({ body, set }) => {
    await store.ensureLayout();
    const payload = body as { url?: string; directory?: string };
    if (!payload.url) {
      set.status = 400;
      return { error: "Clone URL is required" };
    }
    try {
      await store.requirePermission("transfer-artifacts", "git clone", payload.directory ?? "cloned-project");
      const result = await gitClone(store.workspaceRoot, payload.url, payload.directory ?? "cloned-project");
      await store.addLog(result.message, "info");
      return result;
    } catch (error) {
      set.status = 409;
      return { error: error instanceof Error ? error.message : "Git clone failed" };
    }
  })
  .post("/api/git/stage", async () => {
    await store.ensureLayout();
    await store.requirePermission("modify-git-state", "git stage", store.workspaceRoot);
    const status = await gitStageAll(store.workspaceRoot);
    await store.addLog("Staged workspace changes", "info");
    return status;
  })
  .post("/api/git/commit", async ({ body, set }) => {
    await store.ensureLayout();
    const payload = body as { message?: string } | undefined;
    try {
      await store.requirePermission("modify-git-state", "git commit", payload?.message ?? "PolyLab workspace update");
      const verificationSummary = await store.gitVerificationSummary();
      const result = await gitCommit(store.workspaceRoot, payload?.message ?? "PolyLab workspace update", verificationSummary);
      await store.addLog(result.ok ? `Committed ${result.hash} with ${verificationSummary.status} verification` : result.message, result.ok ? "info" : "warn");
      return result;
    } catch (error) {
      set.status = 409;
      return { error: error instanceof Error ? error.message : "Git commit failed" };
    }
  })
  .get("/api/sync/status", () => store.syncRuns())
  .post("/api/sync/push", async ({ body }) => {
    const payload = body as { remotePath?: string } | undefined;
    await store.requirePermission("transfer-artifacts", "sync push", payload?.remotePath ?? "default-sync-remote");
    return store.pushSync(payload?.remotePath);
  })
  .post("/api/sync/pull", async ({ body }) => {
    const payload = body as { remotePath?: string } | undefined;
    await store.requirePermission("transfer-artifacts", "sync pull", payload?.remotePath ?? "default-sync-remote");
    return store.pullSync(payload?.remotePath);
  });
}

export const app = createApp();

if (import.meta.main) {
  const port = Number(process.env.POLYLAB_SERVER_PORT ?? 3917);
  app.listen({ hostname: "127.0.0.1", port });
  console.log(`PolyLab server listening on http://127.0.0.1:${port}`);
}
