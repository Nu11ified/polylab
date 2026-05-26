import { describe, expect, it } from "bun:test";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "./index";
import { WorkspaceStore } from "./store";

function testApp(name: string) {
  const dataDir = join(import.meta.dir, "..", ".test-data", `${name}-${crypto.randomUUID()}`);
  return {
    app: createApp(new WorkspaceStore({ dataDir })),
    cleanup: () => rm(dataDir, { recursive: true, force: true })
  };
}

async function runGit(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (code !== 0) throw new Error(stderr || stdout || `git ${args.join(" ")} failed`);
  return stdout;
}

describe("PolyLab API", () => {
  it("reports health", async () => {
    const { app, cleanup } = testApp("health");
    const response = await app.handle(new Request("http://local.test/health"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    await cleanup();
  });

  it("requires a bearer token when standalone auth is configured", async () => {
    const previousToken = process.env.POLYLAB_AUTH_TOKEN;
    process.env.POLYLAB_AUTH_TOKEN = "test-token-123456";
    const { app, cleanup } = testApp("auth");
    try {
      const status = await app.handle(new Request("http://local.test/api/auth/status"));
      expect(status.status).toBe(200);
      await expect(status.json()).resolves.toMatchObject({ enabled: true, mode: "token" });

      const health = await app.handle(new Request("http://local.test/health"));
      expect(health.status).toBe(200);

      const denied = await app.handle(new Request("http://local.test/api/workspace"));
      expect(denied.status).toBe(401);
      await expect(denied.json()).resolves.toMatchObject({ error: "Authentication required" });

      const authorized = await app.handle(new Request("http://local.test/api/workspace", {
        headers: { authorization: "Bearer test-token-123456" }
      }));
      expect(authorized.status).toBe(200);
      await expect(authorized.json()).resolves.toMatchObject({ projects: expect.any(Array) });

      const alternateHeader = await app.handle(new Request("http://local.test/api/projects", {
        headers: { "x-polylab-token": "test-token-123456" }
      }));
      expect(alternateHeader.status).toBe(200);
    } finally {
      if (previousToken === undefined) {
        delete process.env.POLYLAB_AUTH_TOKEN;
      } else {
        process.env.POLYLAB_AUTH_TOKEN = previousToken;
      }
      await cleanup();
    }
  });

  it("verifies a formula", async () => {
    const { app, cleanup } = testApp("verify");
    const response = await app.handle(new Request("http://local.test/api/formulas/softmax-jacobian/verify", { method: "POST" }));
    expect(response.status).toBe(200);
    const formula = await response.json() as { id: string; status: string; verificationHistory: Array<{ checks: Array<{ name: string; status: string; detail: string }> }> };
    expect(formula).toMatchObject({ id: "softmax-jacobian", status: "warning" });
    const checks = formula.verificationHistory[0]!.checks;
    expect(checks).toContainEqual(expect.objectContaining({ name: "runtime-parity", status: "passed" }));
    expect(checks).toContainEqual(expect.objectContaining({ name: "cross-language-parity", status: "passed" }));
    expect(checks).toContainEqual(expect.objectContaining({ name: "benchmark-validation", status: "warning" }));
    expect(checks).toContainEqual(expect.objectContaining({ name: "sympy", status: "passed" }));
    expect(checks).toContainEqual(expect.objectContaining({ name: "wolfram", status: "passed" }));
    expect(checks).toContainEqual(expect.objectContaining({ name: "property-based", status: "passed" }));
    expect(checks).toContainEqual(expect.objectContaining({ name: "metamorphic", status: "passed" }));
    expect(checks).toContainEqual(expect.objectContaining({ name: "robustness-sweep", status: "passed" }));
    expect(checks).toContainEqual(expect.objectContaining({ name: "autodiff", status: "passed" }));
    expect(checks).toContainEqual(expect.objectContaining({ name: "runtime-provider-parity", status: "passed" }));
    await cleanup();
  });

  it("runs lab-grade verification specs for models robotics distributed math and parity hooks", async () => {
    const previousParity = process.env.POLYLAB_RUNTIME_PARITY_COMMAND;
    process.env.POLYLAB_RUNTIME_PARITY_COMMAND = "sh -lc 'echo parity-ok:$POLYLAB_FORMULA_ID:$POLYLAB_VERIFICATION_SPECS'";
    const dataDir = join(import.meta.dir, "..", ".test-data", `advanced-verification-${crypto.randomUUID()}`);
    const app = createApp(new WorkspaceStore({ dataDir }));
    try {
      await mkdir(join(dataDir, "verification", "specs"), { recursive: true });
      await writeFile(join(dataDir, "verification", "specs", "softmax.json"), JSON.stringify({
        id: "softmax-lab-gates",
        formulaId: "softmax-jacobian",
        domain: "robotics",
        invariants: ["probability-simplex", "finite-gradient"],
        metamorphicRelations: ["translation-invariance", "batch-permutation-invariance"],
        robustness: { cases: ["near-zero", "large-magnitude", "fp32-fp64-drift"], dtypes: ["fp32", "fp64", "bf16"], tolerance: 1e-5 },
        autodiff: { jvp: true, vjp: true, hessianSymmetry: true },
        robotics: { frames: ["world", "body", "camera"], joints: 2, jointLimits: [[-3.14, 3.14], [-1.57, 1.57]], checkDynamics: true, checkKinematics: true },
        reproducibility: { seeds: [1, 7, 42], datasetHash: "sha256:dataset", environmentHash: "sha256:env", checkpointHash: "sha256:checkpoint" },
        modelEvaluation: { metrics: { accuracy: 0.99, calibration: 0.02 }, slices: ["rare-events", "long-tail"], latencyMs: 1000, memoryMb: 2048 },
        distributedTraining: { worldSizes: [1, 2, 8], gradientAccumulation: [1, 4], checkpointRoundTrip: true },
        intervalBounds: [{ variable: "x", min: -10, max: 10, outputMin: 0, outputMax: 1 }],
        smt: { solver: "z3", assertions: ["probability >= 0", "probability <= 1"] },
        runtimeProviderParity: { providers: ["pytorch", "jax", "onnx", "tensorrt"], tolerance: 1e-5 }
      }, null, 2));

      const response = await app.handle(new Request("http://local.test/api/formulas/softmax-jacobian/verify", { method: "POST" }));
      expect(response.status).toBe(200);
      const formula = await response.json() as { status: string; verificationHistory: Array<{ checks: Array<{ name: string; status: string; detail: string; artifactPaths?: string[] }> }> };
      expect(formula.status).toBe("warning");
      const checks = formula.verificationHistory[0]!.checks;
      for (const name of ["property-based", "metamorphic", "robustness-sweep", "autodiff", "robotics-kinematics", "robotics-dynamics", "reproducibility", "model-evaluation", "distributed-training", "interval-bounds", "smt", "runtime-provider-parity"]) {
        expect(checks).toContainEqual(expect.objectContaining({ name, status: "passed" }));
      }
      const parity = checks.find((check) => check.name === "runtime-provider-parity");
      expect(parity?.detail).toContain("parity-ok:softmax-jacobian");
      const advancedArtifact = checks.find((check) => check.name === "property-based")?.artifactPaths?.[0];
      expect(advancedArtifact).toContain("artifacts/verification/softmax-jacobian/");
      await expect(readFile(join(dataDir, advancedArtifact!), "utf8")).resolves.toContain("softmax-lab-gates");
    } finally {
      if (previousParity === undefined) delete process.env.POLYLAB_RUNTIME_PARITY_COMMAND;
      else process.env.POLYLAB_RUNTIME_PARITY_COMMAND = previousParity;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("runs a configured Wolfram verification hook with artifacts", async () => {
    const previousWolfram = process.env.POLYLAB_WOLFRAM_COMMAND;
    process.env.POLYLAB_WOLFRAM_COMMAND = "sh -lc 'echo wolfram-ok:$POLYLAB_FORMULA_ID:$POLYLAB_FORMULA_EQUATION'";
    const dataDir = join(import.meta.dir, "..", ".test-data", `wolfram-${crypto.randomUUID()}`);
    const app = createApp(new WorkspaceStore({ dataDir }));
    try {
      const response = await app.handle(new Request("http://local.test/api/formulas/softmax-jacobian/verify", { method: "POST" }));
      expect(response.status).toBe(200);
      const formula = await response.json() as { verificationHistory: Array<{ checks: Array<{ name: string; status: string; detail: string; artifactPaths?: string[] }> }> };
      const wolfram = formula.verificationHistory[0]!.checks.find((check) => check.name === "wolfram");
      expect(wolfram).toMatchObject({ status: "passed" });
      expect(wolfram?.detail).toContain("wolfram-ok:softmax-jacobian");
      expect(wolfram?.artifactPaths?.[0]).toContain("artifacts/verification/softmax-jacobian/");
      await expect(readFile(join(dataDir, wolfram!.artifactPaths![0]!), "utf8")).resolves.toContain("\"engine\": \"wolfram\"");
    } finally {
      if (previousWolfram === undefined) delete process.env.POLYLAB_WOLFRAM_COMMAND;
      else process.env.POLYLAB_WOLFRAM_COMMAND = previousWolfram;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("persists created formulas across store instances", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `persist-${crypto.randomUUID()}`);
    const first = createApp(new WorkspaceStore({ dataDir }));
    const createResponse = await first.handle(new Request("http://local.test/api/formulas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "energy-loss",
        title: "Energy Loss",
        equation: "E = m * c",
        variables: ["E", "m", "c"],
        inputShapes: ["m: scalar", "c: scalar"],
        outputShapes: ["E: scalar"],
        constraints: ["m >= 0"]
      })
    }));
    expect(createResponse.status).toBe(200);

    const second = createApp(new WorkspaceStore({ dataDir }));
    const formulasResponse = await second.handle(new Request("http://local.test/api/formulas"));
    const formulas = await formulasResponse.json();
    expect(formulas.some((formula: { id: string }) => formula.id === "energy-loss")).toBe(true);
    await rm(dataDir, { recursive: true, force: true });
  });

  it("mirrors workspace writes into SQLite through Drizzle", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `sqlite-${crypto.randomUUID()}`, ".polylab");
    const app = createApp(new WorkspaceStore({ dataDir }));
    const created = await app.handle(new Request("http://local.test/api/formulas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "sqlite-energy-loss",
        title: "SQLite Energy Loss",
        equation: "E = m * c",
        variables: ["E", "m", "c"],
        inputShapes: ["m: scalar", "c: scalar"],
        outputShapes: ["E: scalar"],
        constraints: ["m >= 0"]
      })
    }));
    expect(created.status).toBe(200);

    const status = await app.handle(new Request("http://local.test/api/persistence/status"));
    const statusJson = await status.json() as { engine: string; orm: string; path: string; entityCount: number; eventCount: number; lastEventAt?: string };
    expect(statusJson.engine).toBe("sqlite");
    expect(statusJson.orm).toBe("drizzle");
    expect(statusJson.path).toBe(join(dataDir, "workspace.db"));
    expect(statusJson.entityCount).toBeGreaterThan(0);
    expect(statusJson.eventCount).toBeGreaterThan(0);
    expect(statusJson.lastEventAt).toBeTruthy();

    const events = await app.handle(new Request("http://local.test/api/persistence/events?limit=10"));
    const eventsJson = await events.json() as Array<{ entityType: string; entityId: string; operation: string }>;
    expect(eventsJson).toContainEqual(expect.objectContaining({ entityType: "formula", entityId: "sqlite-energy-loss", operation: "upsert" }));
    await expect(stat(join(dataDir, "workspace.db"))).resolves.toMatchObject({ size: expect.any(Number) });
    await rm(join(dataDir, ".."), { recursive: true, force: true });
  });

  it("enforces and audits project permission policies", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `security-${crypto.randomUUID()}`, ".polylab");
    const app = createApp(new WorkspaceStore({ dataDir }));

    const permissions = await app.handle(new Request("http://local.test/api/permissions"));
    const permissionsJson = await permissions.json() as Array<{ category: string; mode: string }>;
    expect(permissionsJson).toContainEqual(expect.objectContaining({ category: "run-local-code", mode: "allow-project" }));

    const deniedPolicy = await app.handle(new Request("http://local.test/api/permissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "run-local-code", mode: "deny", reason: "test denial" })
    }));
    expect(deniedPolicy.status).toBe(200);

    const deniedRun = await app.handle(new Request("http://local.test/api/execution/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "echo blocked" })
    }));
    expect(deniedRun.status).toBe(403);
    await expect(deniedRun.json()).resolves.toMatchObject({ error: expect.stringContaining("Permission denied") });

    const allowedPolicy = await app.handle(new Request("http://local.test/api/permissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "run-local-code", mode: "allow-once", reason: "test approval" })
    }));
    expect(allowedPolicy.status).toBe(200);

    const allowedRun = await app.handle(new Request("http://local.test/api/execution/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "echo allowed" })
    }));
    expect(allowedRun.status).toBe(200);
    await expect(allowedRun.json()).resolves.toMatchObject({ stdout: "allowed\n" });

    const checks = await app.handle(new Request("http://local.test/api/permissions/checks"));
    const checksJson = await checks.json() as Array<{ category: string; allowed: boolean; action: string }>;
    expect(checksJson).toContainEqual(expect.objectContaining({ category: "run-local-code", allowed: false, action: "run local command" }));
    expect(checksJson).toContainEqual(expect.objectContaining({ category: "run-local-code", allowed: true, action: "run local command" }));

    const events = await app.handle(new Request("http://local.test/api/activity/events"));
    const eventsJson = await events.json() as Array<{ type: string; title: string }>;
    expect(eventsJson).toContainEqual(expect.objectContaining({ type: "permission", title: "Denied run-local-code" }));
    expect(eventsJson).toContainEqual(expect.objectContaining({ type: "execution", title: "Execution succeeded" }));
    await rm(join(dataDir, ".."), { recursive: true, force: true });
  });

  it("indexes, reads, and writes workspace files safely", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `files-${crypto.randomUUID()}`, ".polylab");
    const workspaceRoot = join(dataDir, "..");
    const app = createApp(new WorkspaceStore({ dataDir }));
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "src", "model.py"), "def model(x):\n    return x\n# TODO tighten validation\n");
    await writeFile(join(workspaceRoot, "src", "bad.json"), "{\n");

    const index = await app.handle(new Request("http://local.test/api/files"));
    expect(index.status).toBe(200);
    const files = await index.json() as Array<{ path: string; kind: string; language?: string }>;
    expect(files).toContainEqual(expect.objectContaining({ path: "src/model.py", kind: "file", language: "python" }));
    expect(files.some((file) => file.path.startsWith(".polylab/"))).toBe(false);

    const read = await app.handle(new Request("http://local.test/api/files/read?path=src%2Fmodel.py"));
    await expect(read.json()).resolves.toMatchObject({ path: "src/model.py", content: "def model(x):\n    return x\n# TODO tighten validation\n", language: "python" });

    const symbols = await app.handle(new Request("http://local.test/api/files/symbols"));
    const symbolsJson = await symbols.json() as Array<{ path: string; name: string; kind: string; line: number }>;
    expect(symbolsJson).toContainEqual(expect.objectContaining({ path: "src/model.py", name: "model", kind: "function", line: 1 }));
    expect(symbolsJson.some((symbol) => symbol.path === "src/model.py" && symbol.kind === "heading")).toBe(false);

    const diagnostics = await app.handle(new Request("http://local.test/api/files/diagnostics"));
    const diagnosticsJson = await diagnostics.json() as Array<{ path: string; severity: string; message: string }>;
    expect(diagnosticsJson).toContainEqual(expect.objectContaining({ path: "src/model.py", severity: "warning", message: "Unresolved TODO/FIXME marker." }));
    expect(diagnosticsJson.some((item) => item.path === "src/bad.json" && item.severity === "error")).toBe(true);

    const write = await app.handle(new Request("http://local.test/api/files/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "src/model.py", content: "print('saved')\n" })
    }));
    expect(write.status).toBe(200);
    await expect(write.json()).resolves.toMatchObject({ path: "src/model.py", content: "print('saved')\n" });
    await expect(readFile(join(workspaceRoot, "src", "model.py"), "utf8")).resolves.toBe("print('saved')\n");

    const escaped = await app.handle(new Request("http://local.test/api/files/read?path=..%2Foutside.txt"));
    expect(escaped.status).toBe(400);
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("manages external editor presets and expands launch commands", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `editor-${crypto.randomUUID()}`, ".polylab");
    const workspaceRoot = join(dataDir, "..");
    const app = createApp(new WorkspaceStore({ dataDir }));
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "src", "open.py"), "print('open')\n");

    const presets = await app.handle(new Request("http://local.test/api/editor/presets"));
    const presetsJson = await presets.json() as Array<{ id: string; command: string }>;
    expect(presetsJson).toContainEqual(expect.objectContaining({ id: "vscode" }));

    const saved = await app.handle(new Request("http://local.test/api/editor/presets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "test", name: "Test Echo", command: "echo {workspace} {file} {line} {column}" })
    }));
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({ id: "test", variables: ["{workspace}", "{file}", "{line}", "{column}"] });

    const launch = await app.handle(new Request("http://local.test/api/editor/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presetId: "test", path: "src/open.py", line: 7, column: 3, dryRun: true })
    }));
    expect(launch.status).toBe(200);
    await expect(launch.json()).resolves.toMatchObject({
      command: "echo",
      args: [workspaceRoot, join(workspaceRoot, "src", "open.py"), "7", "3"],
      line: 7,
      column: 3
    });

    const escaped = await app.handle(new Request("http://local.test/api/editor/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presetId: "test", path: "../outside.py", dryRun: true })
    }));
    expect(escaped.status).toBe(400);
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("creates the PRD workspace folders", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `layout-${crypto.randomUUID()}`, ".polylab");
    const store = new WorkspaceStore({ dataDir });
    await store.snapshot();
    const root = join(dataDir, "..");
    const rootEntries = await readdir(root);
    const polylabEntries = await readdir(dataDir);
    expect(rootEntries).toContain("formulas");
    expect(rootEntries).toContain("experiments");
    expect(rootEntries).toContain("papers");
    expect(polylabEntries).toContain("sessions");
    expect(polylabEntries).toContain("verification");
    expect(polylabEntries).toContain("settings.json");
    await rm(root, { recursive: true, force: true });
  });

  it("initializes and reports Git status", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `git-${crypto.randomUUID()}`, ".polylab");
    const app = createApp(new WorkspaceStore({ dataDir }));
    const before = await app.handle(new Request("http://local.test/api/git/status"));
    await expect(before.json()).resolves.toMatchObject({ initialized: false });

    const init = await app.handle(new Request("http://local.test/api/git/init", { method: "POST" }));
    expect(init.status).toBe(200);
    const initJson = await init.json() as { initialized: boolean; branch: string };
    expect(initJson.initialized).toBe(true);
    expect(["main", "master"]).toContain(initJson.branch);

    const after = await app.handle(new Request("http://local.test/api/git/status"));
    await expect(after.json()).resolves.toMatchObject({ initialized: true });
    await rm(join(dataDir, ".."), { recursive: true, force: true });
  });

  it("stages and commits workspace changes", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `git-commit-${crypto.randomUUID()}`, ".polylab");
    const workspaceRoot = join(dataDir, "..");
    const app = createApp(new WorkspaceStore({ dataDir }));
    await mkdir(join(workspaceRoot, "experiments"), { recursive: true });
    await writeFile(join(workspaceRoot, "experiments", "commit.md"), "# Commit\n");

    const staged = await app.handle(new Request("http://local.test/api/git/stage", { method: "POST" }));
    expect(staged.status).toBe(200);
    const stagedJson = await staged.json() as { initialized: boolean; files: Array<{ index: string; path: string }> };
    expect(stagedJson.initialized).toBe(true);
    expect(stagedJson.files.some((file) => file.index.trim() && file.path === "experiments/commit.md")).toBe(true);

    const committed = await app.handle(new Request("http://local.test/api/git/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Add experiment note" })
    }));
    expect(committed.status).toBe(200);
    const committedJson = await committed.json() as { ok: boolean; hash?: string; filesCommitted: number; status: { summary: string }; verificationSummary: { status: string } };
    expect(committedJson.ok).toBe(true);
    expect(committedJson.hash).toBeTruthy();
    expect(committedJson.filesCommitted).toBeGreaterThan(0);
    expect(committedJson.status.summary).toBe("Working tree clean.");
    expect(committedJson.verificationSummary.status).toBe("warning");
    const commitBody = await runGit(workspaceRoot, ["log", "-1", "--pretty=%B"]);
    expect(commitBody).toContain("PolyLab-Verification:");
    expect(commitBody).toContain("status=warning");
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("manages Git remotes, branches, push, pull, and clone", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `git-remote-${crypto.randomUUID()}`, ".polylab");
    const workspaceRoot = join(dataDir, "..");
    const remoteDir = join(import.meta.dir, "..", ".test-data", `remote-${crypto.randomUUID()}.git`);
    const cloneSeed = join(import.meta.dir, "..", ".test-data", `seed-${crypto.randomUUID()}`);
    const app = createApp(new WorkspaceStore({ dataDir }));

    await mkdir(cloneSeed, { recursive: true });
    await runGit(cloneSeed, ["init"]);
    await writeFile(join(cloneSeed, "README.md"), "# Remote\n");
    await runGit(cloneSeed, ["add", "README.md"]);
    await runGit(cloneSeed, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed"]);
    await runGit(cloneSeed, ["init", "--bare", remoteDir]);
    await runGit(cloneSeed, ["remote", "add", "origin", remoteDir]);
    await runGit(cloneSeed, ["push", "-u", "origin", "HEAD:main"]);
    await runGit(cloneSeed, ["--git-dir", remoteDir, "symbolic-ref", "HEAD", "refs/heads/main"]);

    await mkdir(join(workspaceRoot, "experiments"), { recursive: true });
    await writeFile(join(workspaceRoot, "experiments", "remote.md"), "# Local\n");
    await app.handle(new Request("http://local.test/api/git/init", { method: "POST" }));
    await app.handle(new Request("http://local.test/api/git/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "local commit" })
    }));

    const branch = await app.handle(new Request("http://local.test/api/git/branch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "feature/git-remote" })
    }));
    await expect(branch.json()).resolves.toMatchObject({ ok: true, status: { branch: "feature/git-remote" } });

    const remote = await app.handle(new Request("http://local.test/api/git/remote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "origin", url: remoteDir })
    }));
    await expect(remote.json()).resolves.toMatchObject({ ok: true, remotes: [{ name: "origin", url: remoteDir }] });

    const push = await app.handle(new Request("http://local.test/api/git/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remote: "origin", branch: "feature/git-remote" })
    }));
    expect(push.status).toBe(200);
    await expect(push.json()).resolves.toMatchObject({ ok: true });

    const pull = await app.handle(new Request("http://local.test/api/git/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remote: "origin", branch: "feature/git-remote" })
    }));
    expect(pull.status).toBe(200);
    await expect(pull.json()).resolves.toMatchObject({ ok: true });

    const clone = await app.handle(new Request("http://local.test/api/git/clone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: remoteDir, directory: "cloned-remote" })
    }));
    expect(clone.status).toBe(200);
    await expect(clone.json()).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(workspaceRoot, "cloned-remote", "README.md"), "utf8")).resolves.toContain("Remote");

    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(remoteDir, { recursive: true, force: true });
    await rm(cloneSeed, { recursive: true, force: true });
  });

  it("detects and resolves Git conflicts", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `git-conflict-${crypto.randomUUID()}`, ".polylab");
    const workspaceRoot = join(dataDir, "..");
    const app = createApp(new WorkspaceStore({ dataDir }));

    await mkdir(join(workspaceRoot, "experiments"), { recursive: true });
    await runGit(workspaceRoot, ["init"]);
    await writeFile(join(workspaceRoot, "experiments", "conflict.md"), "base\n");
    await runGit(workspaceRoot, ["add", "experiments/conflict.md"]);
    await runGit(workspaceRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    await runGit(workspaceRoot, ["checkout", "-b", "feature/conflict"]);
    await writeFile(join(workspaceRoot, "experiments", "conflict.md"), "feature\n");
    await runGit(workspaceRoot, ["add", "experiments/conflict.md"]);
    await runGit(workspaceRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "feature"]);
    await runGit(workspaceRoot, ["checkout", "master"]);
    await writeFile(join(workspaceRoot, "experiments", "conflict.md"), "master\n");
    await runGit(workspaceRoot, ["add", "experiments/conflict.md"]);
    await runGit(workspaceRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "master"]);
    const merge = Bun.spawn(["git", "merge", "feature/conflict"], { cwd: workspaceRoot, stdout: "pipe", stderr: "pipe" });
    await merge.exited;

    const status = await app.handle(new Request("http://local.test/api/git/status"));
    const statusJson = await status.json() as { conflicts: Array<{ path: string; ours: string; theirs: string; markerCount: number }>; summary: string };
    expect(statusJson.summary).toContain("conflicted");
    expect(statusJson.conflicts).toContainEqual(expect.objectContaining({ path: "experiments/conflict.md", ours: "master\n", theirs: "feature\n", markerCount: 1 }));

    const conflicts = await app.handle(new Request("http://local.test/api/git/conflicts"));
    await expect(conflicts.json()).resolves.toMatchObject([{ path: "experiments/conflict.md" }]);

    const resolved = await app.handle(new Request("http://local.test/api/git/conflicts/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "experiments/conflict.md", strategy: "theirs" })
    }));
    expect(resolved.status).toBe(200);
    await expect(resolved.json()).resolves.toMatchObject({ ok: true, status: { conflicts: [] } });
    await expect(readFile(join(workspaceRoot, "experiments", "conflict.md"), "utf8")).resolves.toBe("feature\n");
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("routes and runs safe local execution", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `execution-${crypto.randomUUID()}`, ".polylab");
    const app = createApp(new WorkspaceStore({ dataDir }));
    const route = await app.handle(new Request("http://local.test/api/execution/route", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "echo hello" })
    }));
    await expect(route.json()).resolves.toMatchObject({ target: "local" });

    const run = await app.handle(new Request("http://local.test/api/execution/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "echo hello" })
    }));
    expect(run.status).toBe(200);
    await expect(run.json()).resolves.toMatchObject({ state: "succeeded", stdout: "hello\n" });

    const denied = await app.handle(new Request("http://local.test/api/execution/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "rm -rf ." })
    }));
    await expect(denied.json()).resolves.toMatchObject({ state: "failed", exitCode: 126 });

    await Promise.all(["echo one", "echo two"].map((command) => app.handle(new Request("http://local.test/api/execution/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command })
    }))));
    const runs = await app.handle(new Request("http://local.test/api/execution/runs"));
    const runsJson = await runs.json() as Array<{ id: string; command: string }>;
    expect(runsJson.map((run) => run.command)).toContain("echo one");
    expect(runsJson.map((run) => run.command)).toContain("echo two");

    const artifacts = await app.handle(new Request("http://local.test/api/artifacts"));
    const artifactsJson = await artifacts.json() as Array<{ sourceId: string; path: string }>;
    const helloRun = runsJson.find((item) => item.command === "echo hello");
    expect(artifactsJson.some((artifact) => artifact.path.endsWith("/stdout.txt"))).toBe(true);
    if (helloRun?.id) {
      await expect(readFile(join(dataDir, "..", "artifacts", "executions", helloRun.id, "stdout.txt"), "utf8")).resolves.toBe("hello\n");
    }
    await rm(join(dataDir, ".."), { recursive: true, force: true });
  });

  it("routes network-isolated execution to the Docker sandbox", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `docker-route-${crypto.randomUUID()}`, ".polylab");
    const app = createApp(new WorkspaceStore({ dataDir }));

    const route = await app.handle(new Request("http://local.test/api/execution/route", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "python3 -c 'print(1)'", allowNetwork: false })
    }));
    await expect(route.json()).resolves.toMatchObject({ target: "docker" });

    const run = await app.handle(new Request("http://local.test/api/execution/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "python3 -c 'print(1)'", allowNetwork: false, memoryMb: 128 })
    }));
    expect(run.status).toBe(200);
    const runJson = await run.json() as { route: { target: string }; sandbox?: string; state: string; artifactPaths: string[] };
    expect(runJson.route.target).toBe("docker");
    expect(runJson.sandbox).toBe("docker");
    expect(["succeeded", "failed", "skipped"]).toContain(runJson.state);
    expect(runJson.artifactPaths.some((path) => path.endsWith("metadata.json"))).toBe(true);

    await expect(readFile(join(dataDir, "..", runJson.artifactPaths.find((path) => path.endsWith("metadata.json"))!), "utf8")).resolves.toContain("\"sandbox\": \"docker\"");
    await rm(join(dataDir, ".."), { recursive: true, force: true });
  });

  it("scans dependency plans and applies them only after approval", async () => {
    const previousInstall = process.env.POLYLAB_DEPENDENCY_INSTALL_COMMAND;
    delete process.env.POLYLAB_DEPENDENCY_INSTALL_COMMAND;
    const dataDir = join(import.meta.dir, "..", ".test-data", `deps-${crypto.randomUUID()}`, ".polylab");
    const workspaceRoot = join(dataDir, "..");
    const app = createApp(new WorkspaceStore({ dataDir }));
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "requirements.txt"), "numpy==2.0.0\npandas\n");
    await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
    await writeFile(join(workspaceRoot, "src", "analysis.py"), "import numpy as np\nimport pathlib\n");
    try {
      const scan = await app.handle(new Request("http://local.test/api/dependencies/scan", { method: "POST" }));
      expect(scan.status).toBe(200);
      const plan = await scan.json() as { id: string; state: string; installCommand: string; items: Array<{ name: string; manager: string }>; artifactPaths: string[] };
      expect(plan.state).toBe("planned");
      expect(plan.items).toContainEqual(expect.objectContaining({ name: "numpy", manager: "python" }));
      expect(plan.items).toContainEqual(expect.objectContaining({ name: "react", manager: "bun" }));
      expect(plan.installCommand).toContain("python3 -m pip install");
      expect(plan.installCommand).toContain("bun add");
      await expect(readFile(join(workspaceRoot, plan.artifactPaths[0]!), "utf8")).resolves.toContain("numpy");

      const denied = await app.handle(new Request(`http://local.test/api/dependencies/plans/${plan.id}/apply`, { method: "POST" }));
      expect(denied.status).toBe(403);

      const allowedPolicy = await app.handle(new Request("http://local.test/api/permissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category: "install-dependencies", mode: "allow-once", reason: "Approve dependency plan in test." })
      }));
      expect(allowedPolicy.status).toBe(200);

      const skipped = await app.handle(new Request(`http://local.test/api/dependencies/plans/${plan.id}/apply`, { method: "POST" }));
      expect(skipped.status).toBe(200);
      await expect(skipped.json()).resolves.toMatchObject({ id: plan.id, state: "skipped" });

      process.env.POLYLAB_DEPENDENCY_INSTALL_COMMAND = `${process.execPath} -e "console.log('dependency install approved')"`;
      const secondPolicy = await app.handle(new Request("http://local.test/api/permissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category: "install-dependencies", mode: "allow-once", reason: "Approve configured dependency installer in test." })
      }));
      expect(secondPolicy.status).toBe(200);
      const applied = await app.handle(new Request(`http://local.test/api/dependencies/plans/${plan.id}/apply`, { method: "POST" }));
      expect(applied.status).toBe(200);
      const appliedJson = await applied.json() as { state: string; stdout: string; artifactPaths: string[] };
      expect(appliedJson.state).toBe("installed");
      expect(appliedJson.stdout).toContain("dependency install approved");
      expect(appliedJson.artifactPaths.some((path) => path.endsWith("/result.json"))).toBe(true);
    } finally {
      if (previousInstall === undefined) delete process.env.POLYLAB_DEPENDENCY_INSTALL_COMMAND;
      else process.env.POLYLAB_DEPENDENCY_INSTALL_COMMAND = previousInstall;
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("previews tracked artifact contents", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `artifact-${crypto.randomUUID()}`, ".polylab");
    const app = createApp(new WorkspaceStore({ dataDir }));
    const run = await app.handle(new Request("http://local.test/api/execution/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "echo artifact-preview" })
    }));
    expect(run.status).toBe(200);
    const artifacts = await app.handle(new Request("http://local.test/api/artifacts"));
    const artifactsJson = await artifacts.json() as Array<{ id: string; path: string }>;
    const stdout = artifactsJson.find((artifact) => artifact.path.endsWith("/stdout.txt"));
    expect(stdout?.id).toBeTruthy();

    const preview = await app.handle(new Request(`http://local.test/api/artifacts/${stdout!.id}/read`));
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({ content: "artifact-preview\n", previewable: true });

    const missing = await app.handle(new Request("http://local.test/api/artifacts/missing/read"));
    expect(missing.status).toBe(404);
    await rm(join(dataDir, ".."), { recursive: true, force: true });
  });

  it("queues cloud execution jobs with handoff artifacts", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `cloud-${crypto.randomUUID()}`, ".polylab");
    const app = createApp(new WorkspaceStore({ dataDir }));

    const providers = await app.handle(new Request("http://local.test/api/cloud/providers"));
    const providersJson = await providers.json() as Array<{ id: string; name: string }>;
    expect(providersJson).toContainEqual(expect.objectContaining({ id: "google-notebook", name: "Google Notebook" }));

    const configured = await app.handle(new Request("http://local.test/api/cloud/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "modal", state: "configured", credentialHint: "env configured in CI" })
    }));
    await expect(configured.json()).resolves.toMatchObject({ id: "modal", state: "configured" });

    const run = await app.handle(new Request("http://local.test/api/execution/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "python3 train.py", gpuRequired: true, estimatedSeconds: 1200 })
    }));
    expect(run.status).toBe(200);
    const runJson = await run.json() as { state: string; route: { target: string }; cloudJobId?: string };
    expect(runJson.state).toBe("queued");
    expect(runJson.route.target).toBe("modal");
    expect(runJson.cloudJobId).toBeTruthy();

    const jobs = await app.handle(new Request("http://local.test/api/cloud/jobs"));
    const jobsJson = await jobs.json() as Array<{ id: string; provider: string; artifactPaths: string[] }>;
    expect(jobsJson[0]?.provider).toBe("modal");
    expect(jobsJson[0]?.artifactPaths).toHaveLength(1);
    await expect(readFile(join(dataDir, "..", jobsJson[0]!.artifactPaths[0]!), "utf8")).resolves.toContain("python3 train.py");
    await rm(join(dataDir, ".."), { recursive: true, force: true });
  });

  it("routes notebook workloads to Google notebook handoff artifacts", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `google-notebook-${crypto.randomUUID()}`, ".polylab");
    const app = createApp(new WorkspaceStore({ dataDir }));

    const route = await app.handle(new Request("http://local.test/api/execution/route", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "python3 notebooks/lesson.py", notebook: true })
    }));
    await expect(route.json()).resolves.toMatchObject({ target: "google-notebook" });

    const run = await app.handle(new Request("http://local.test/api/execution/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "python3 notebooks/lesson.py", notebook: true, estimatedSeconds: 600, memoryMb: 4096 })
    }));
    expect(run.status).toBe(200);
    const runJson = await run.json() as { route: { target: string }; cloudJobId: string };
    expect(runJson.route.target).toBe("google-notebook");

    const jobs = await app.handle(new Request("http://local.test/api/cloud/jobs"));
    const jobsJson = await jobs.json() as Array<{ id: string; provider: string; artifactPaths: string[]; costEstimate: string }>;
    expect(jobsJson[0]?.provider).toBe("google-notebook");
    expect(jobsJson[0]?.artifactPaths).toHaveLength(2);
    expect(jobsJson[0]?.artifactPaths.some((path) => path.endsWith("-google-notebook.ipynb"))).toBe(true);
    await expect(readFile(join(dataDir, "..", jobsJson[0]!.artifactPaths[0]!), "utf8")).resolves.toContain("\"runtime\": \"google-notebook\"");
    await expect(readFile(join(dataDir, "..", jobsJson[0]!.artifactPaths[1]!), "utf8")).resolves.toContain("python3 notebooks/lesson.py");

    const dispatch = await app.handle(new Request(`http://local.test/api/cloud/jobs/${runJson.cloudJobId}/dispatch`, { method: "POST" }));
    expect(dispatch.status).toBe(200);
    const dispatchJson = await dispatch.json() as { job: { state: string; artifactPaths: string[] }; logs: Array<{ provider: string; message: string }> };
    expect(dispatchJson.job.state).toBe("ready-for-dispatch");
    expect(dispatchJson.job.artifactPaths.some((path) => path.endsWith("-dispatch.json"))).toBe(true);
    expect(dispatchJson.logs.some((log) => log.provider === "google-notebook" && log.message.includes("generated .ipynb"))).toBe(true);
    await rm(join(dataDir, ".."), { recursive: true, force: true });
  });

  it("dispatches cloud jobs through a configured provider command with logs and artifacts", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `cloud-dispatch-${crypto.randomUUID()}`, ".polylab");
    const previousDispatch = process.env.POLYLAB_CLOUD_DISPATCH_COMMAND;
    process.env.POLYLAB_CLOUD_DISPATCH_COMMAND = "echo dispatched:$POLYLAB_CLOUD_JOB_ID:$POLYLAB_CLOUD_PROVIDER:$POLYLAB_CLOUD_COMMAND";
    const app = createApp(new WorkspaceStore({ dataDir }));
    try {
      const run = await app.handle(new Request("http://local.test/api/execution/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "python3 train.py", gpuRequired: true, estimatedSeconds: 1200 })
      }));
      const runJson = await run.json() as { cloudJobId: string };
      expect(runJson.cloudJobId).toBeTruthy();

      const dispatched = await app.handle(new Request(`http://local.test/api/cloud/jobs/${runJson.cloudJobId}/dispatch`, { method: "POST" }));
      expect(dispatched.status).toBe(200);
      const dispatchJson = await dispatched.json() as { job: { state: string; artifactPaths: string[] }; logs: Array<{ level: string; message: string }> };
      expect(dispatchJson.job.state).toBe("succeeded");
      expect(dispatchJson.job.artifactPaths.some((path) => path.endsWith("-dispatch.json"))).toBe(true);
      expect(dispatchJson.job.artifactPaths.some((path) => path.endsWith("-result.json"))).toBe(true);
      expect(dispatchJson.logs.some((log) => log.message.includes("dispatched:"))).toBe(true);

      const logs = await app.handle(new Request(`http://local.test/api/cloud/logs?jobId=${runJson.cloudJobId}`));
      const logsJson = await logs.json() as Array<{ jobId: string; level: string }>;
      expect(logsJson.every((log) => log.jobId === runJson.cloudJobId)).toBe(true);
      await expect(readFile(join(dataDir, "..", "artifacts", "cloud", "jobs", `${runJson.cloudJobId}-result.json`), "utf8")).resolves.toContain("dispatched:");
    } finally {
      if (previousDispatch === undefined) {
        delete process.env.POLYLAB_CLOUD_DISPATCH_COMMAND;
      } else {
        process.env.POLYLAB_CLOUD_DISPATCH_COMMAND = previousDispatch;
      }
      await rm(join(dataDir, ".."), { recursive: true, force: true });
    }
  });

  it("creates deployment plans with Caddy and DNS preview artifacts", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `deployment-${crypto.randomUUID()}`, ".polylab");
    const app = createApp(new WorkspaceStore({ dataDir }));
    const response = await app.handle(new Request("http://local.test/api/deployment/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Preview deploy",
        dnsTarget: "198.51.100.20",
        routes: [
          { host: "studio.example.com", upstream: "127.0.0.1:3917", tls: "auto" },
          { host: "api.example.com", upstream: "127.0.0.1:3917", tls: "internal" }
        ]
      })
    }));
    expect(response.status).toBe(200);
    const plan = await response.json() as { id: string; caddyfile: string; dockerCompose: string; envExample: string; dnsPreview: Array<{ action: string; type: string; name: string; content: string; proxied: boolean }>; artifactPaths: string[] };
    expect(plan.caddyfile).toContain("studio.example.com");
    expect(plan.caddyfile).toContain("reverse_proxy 127.0.0.1:3917");
    expect(plan.dockerCompose).toContain("services:");
    expect(plan.dockerCompose).toContain("polylab-server:");
    expect(plan.envExample).toContain("POLYLAB_PUBLIC_HOSTS=studio.example.com,api.example.com");
    expect(plan.dnsPreview).toContainEqual({ action: "create", type: "A", name: "api.example.com", content: "198.51.100.20", proxied: true });
    expect(plan.artifactPaths).toHaveLength(5);
    await expect(readFile(join(dataDir, "..", plan.artifactPaths[0]!), "utf8")).resolves.toContain("studio.example.com");
    await expect(readFile(join(dataDir, "..", plan.artifactPaths[1]!), "utf8")).resolves.toContain("ghcr.io/polylab/polylab-server:latest");
    await expect(readFile(join(dataDir, "..", plan.artifactPaths[2]!), "utf8")).resolves.toContain("POLYLAB_DNS_TARGET=198.51.100.20");

    const list = await app.handle(new Request("http://local.test/api/deployment/plans"));
    await expect(list.json()).resolves.toMatchObject([{ id: plan.id }]);
    await rm(join(dataDir, ".."), { recursive: true, force: true });
  });

  it("applies and rolls back deployment plans with audited mutations", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `deployment-apply-${crypto.randomUUID()}`, ".polylab");
    const workspaceRoot = join(dataDir, "..");
    const caddyfilePath = join(workspaceRoot, "runtime", "Caddyfile");
    const previousCaddyPath = process.env.POLYLAB_CADDYFILE_PATH;
    const previousReload = process.env.POLYLAB_CADDY_RELOAD_COMMAND;
    process.env.POLYLAB_CADDYFILE_PATH = caddyfilePath;
    process.env.POLYLAB_CADDY_RELOAD_COMMAND = "echo caddy-reloaded";
    const app = createApp(new WorkspaceStore({ dataDir }));
    try {
      await mkdir(join(workspaceRoot, "runtime"), { recursive: true });
      await writeFile(caddyfilePath, "old.example.com {\n  respond ok\n}\n");
      const response = await app.handle(new Request("http://local.test/api/deployment/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Apply deploy",
          routes: [{ host: "studio.example.com", upstream: "127.0.0.1:3917", tls: "auto" }]
        })
      }));
      const plan = await response.json() as { id: string };

      const applied = await app.handle(new Request(`http://local.test/api/deployment/plans/${plan.id}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ applyDns: false })
      }));
      expect(applied.status).toBe(200);
      const appliedJson = await applied.json() as { plan: { state: string }; mutations: Array<{ kind: string; state: string; detail: string; artifactPaths: string[] }> };
      expect(appliedJson.plan.state).toBe("applied");
      expect(appliedJson.mutations).toContainEqual(expect.objectContaining({ kind: "caddy-write", state: "applied" }));
      expect(appliedJson.mutations).toContainEqual(expect.objectContaining({ kind: "caddy-reload", state: "applied", detail: "caddy-reloaded" }));
      expect(appliedJson.mutations).toContainEqual(expect.objectContaining({ kind: "cloudflare-dns", state: "skipped" }));
      await expect(readFile(caddyfilePath, "utf8")).resolves.toContain("studio.example.com");
      await expect(readFile(join(workspaceRoot, "artifacts", "deployment", plan.id, "rollback", "Caddyfile.previous"), "utf8")).resolves.toContain("old.example.com");

      const mutations = await app.handle(new Request("http://local.test/api/deployment/mutations"));
      const mutationsJson = await mutations.json() as Array<{ planId: string; artifactPaths: string[] }>;
      expect(mutationsJson.some((mutation) => mutation.planId === plan.id && mutation.artifactPaths.some((path) => path.includes("/mutations/")))).toBe(true);

      const rollback = await app.handle(new Request(`http://local.test/api/deployment/plans/${plan.id}/rollback`, { method: "POST" }));
      expect(rollback.status).toBe(200);
      await expect(rollback.json()).resolves.toMatchObject({ plan: { state: "rolled-back" }, mutations: [expect.objectContaining({ kind: "rollback", state: "applied" })] });
      await expect(readFile(caddyfilePath, "utf8")).resolves.toContain("old.example.com");
    } finally {
      if (previousCaddyPath === undefined) {
        delete process.env.POLYLAB_CADDYFILE_PATH;
      } else {
        process.env.POLYLAB_CADDYFILE_PATH = previousCaddyPath;
      }
      if (previousReload === undefined) {
        delete process.env.POLYLAB_CADDY_RELOAD_COMMAND;
      } else {
        process.env.POLYLAB_CADDY_RELOAD_COMMAND = previousReload;
      }
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("runs reproducible benchmarks with artifacts", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `benchmark-${crypto.randomUUID()}`, ".polylab");
    const app = createApp(new WorkspaceStore({ dataDir }));
    const response = await app.handle(new Request("http://local.test/api/benchmarks/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Echo benchmark", command: "echo bench", iterations: 2 })
    }));
    expect(response.status).toBe(200);
    const benchmark = await response.json() as { id: string; iterations: number; durationsMs: number[]; meanMs: number; artifactPaths: string[] };
    expect(benchmark.iterations).toBe(2);
    expect(benchmark.durationsMs).toHaveLength(2);
    expect(benchmark.meanMs).toBeGreaterThanOrEqual(0);
    expect(benchmark.artifactPaths).toHaveLength(2);

    const list = await app.handle(new Request("http://local.test/api/benchmarks"));
    await expect(list.json()).resolves.toMatchObject([{ id: benchmark.id }]);
    await expect(readFile(join(dataDir, "..", "benchmarks", `${benchmark.id}.json`), "utf8")).resolves.toContain("Echo benchmark");

    const linked = await app.handle(new Request("http://local.test/api/benchmarks/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Local execution benchmark", command: "echo softmax-jacobian", iterations: 1 })
    }));
    expect(linked.status).toBe(200);
    const verified = await app.handle(new Request("http://local.test/api/formulas/softmax-jacobian/verify", { method: "POST" }));
    const formula = await verified.json() as { status: string; verificationHistory: Array<{ checks: Array<{ name: string; status: string }> }> };
    expect(formula.status).toBe("passed");
    expect(formula.verificationHistory[0]!.checks).toContainEqual(expect.objectContaining({ name: "benchmark-validation", status: "passed" }));
    await rm(join(dataDir, ".."), { recursive: true, force: true });
  });

  it("runs experiments with graph and simulation artifacts", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `experiment-${crypto.randomUUID()}`, ".polylab");
    const app = createApp(new WorkspaceStore({ dataDir }));
    const response = await app.handle(new Request("http://local.test/api/experiments/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Echo experiment", command: "echo experiment", formulaId: "softmax-jacobian" })
    }));
    expect(response.status).toBe(200);
    const experiment = await response.json() as { id: string; state: string; nodes: Array<{ kind: string }>; edges: unknown[]; samples: unknown[]; artifactPaths: string[] };
    expect(experiment.state).toBe("succeeded");
    expect(experiment.nodes).toContainEqual(expect.objectContaining({ kind: "formula" }));
    expect(experiment.edges.length).toBeGreaterThanOrEqual(3);
    expect(experiment.samples).toHaveLength(12);
    expect(experiment.artifactPaths).toContain(`artifacts/experiments/${experiment.id}/graph.json`);

    const list = await app.handle(new Request("http://local.test/api/experiments"));
    await expect(list.json()).resolves.toMatchObject([{ id: experiment.id }]);
    await expect(readFile(join(dataDir, "..", `artifacts/experiments/${experiment.id}/graph.json`), "utf8")).resolves.toContain("Echo experiment");
    await expect(readFile(join(dataDir, "..", `artifacts/experiments/${experiment.id}/samples.json`), "utf8")).resolves.toContain("step 1");
    await rm(join(dataDir, ".."), { recursive: true, force: true });
  });

  it("generates and accepts patch hunks", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `patch-${crypto.randomUUID()}`, ".polylab");
    const app = createApp(new WorkspaceStore({ dataDir }));
    const generated = await app.handle(new Request("http://local.test/api/formulas/softmax-jacobian/generate", { method: "POST" }));
    expect(generated.status).toBe(200);
    const patch = await generated.json() as { id: string; hunks: Array<{ id: string; filePath: string }> };
    expect(patch.hunks).toHaveLength(1);

    const accepted = await app.handle(new Request(`http://local.test/api/patches/${patch.id}/hunks/${patch.hunks[0]!.id}/accepted`, { method: "POST" }));
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ status: "accepted" });

    const generatedFile = await readFile(join(dataDir, "..", patch.hunks[0]!.filePath), "utf8");
    expect(generatedFile).toContain("np.diag(s) - np.outer(s, s)");
    await rm(join(dataDir, ".."), { recursive: true, force: true });
  });

  it("runs a deterministic Pi mono workflow with trace events", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `agent-${crypto.randomUUID()}`, ".polylab");
    const app = createApp(new WorkspaceStore({ dataDir }));
    const created = await app.handle(new Request("http://local.test/api/agents/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ formulaId: "softmax-jacobian" })
    }));
    expect(created.status).toBe(200);
    const session = await created.json() as { id: string };

    const run = await app.handle(new Request(`http://local.test/api/agents/sessions/${session.id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ formulaId: "softmax-jacobian" })
    }));
    expect(run.status).toBe(200);
    const runJson = await run.json() as { id: string; state: string; attempts: number; replayPath?: string; artifactPaths: string[]; plan: Array<{ state: string }>; trace: Array<{ type: string }> };
    expect(runJson.state).toBe("done");
    expect(runJson.attempts).toBe(1);
    expect(runJson.plan.every((step) => step.state === "done")).toBe(true);
    expect(runJson.trace.some((event) => event.type === "patch")).toBe(true);
    expect(runJson.trace.some((event) => event.type === "verification")).toBe(true);
    expect(runJson.trace.some((event) => event.type === "artifact")).toBe(true);
    expect(runJson.replayPath).toBe(`artifacts/agents/${runJson.id}/replay.json`);
    await expect(readFile(join(dataDir, "..", runJson.replayPath!), "utf8")).resolves.toContain("Deterministic workflow completed.");

    const patches = await app.handle(new Request("http://local.test/api/patches"));
    const patchesJson = await patches.json() as unknown[];
    expect(patchesJson.length).toBeGreaterThan(0);

    const replay = await app.handle(new Request(`http://local.test/api/agents/sessions/${runJson.id}/export-replay`, { method: "POST" }));
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ replayPath: runJson.replayPath });
    await rm(join(dataDir, ".."), { recursive: true, force: true });
  });

  it("creates and dispatches Pi mono Codex handoffs", async () => {
    const previousCommand = process.env.POLYLAB_CODEX_COMMAND;
    delete process.env.POLYLAB_CODEX_COMMAND;
    const dataDir = join(import.meta.dir, "..", ".test-data", `agent-handoff-${crypto.randomUUID()}`, ".polylab");
    const app = createApp(new WorkspaceStore({ dataDir }));
    try {
      const created = await app.handle(new Request("http://local.test/api/agents/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ formulaId: "softmax-jacobian" })
      }));
      const session = await created.json() as { id: string };

      const runtime = await app.handle(new Request("http://local.test/api/agents/runtime"));
      expect(runtime.status).toBe(200);
      await expect(runtime.json()).resolves.toMatchObject({ runtime: "pi-mono", provider: "codex" });

      const skipped = await app.handle(new Request(`http://local.test/api/agents/sessions/${session.id}/handoff`, { method: "POST" }));
      expect(skipped.status).toBe(200);
      const skippedJson = await skipped.json() as { state: string; requestPath: string };
      expect(skippedJson.state).toBe("skipped");
      await expect(readFile(join(dataDir, "..", skippedJson.requestPath), "utf8")).resolves.toContain("Continue this PolyLab agent session");

      const command = `${process.execPath} -e "console.log('codex handoff ok')"`;
      const configured = await app.handle(new Request("http://local.test/api/agents/runtime", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codexCommand: command })
      }));
      expect(configured.status).toBe(200);
      await expect(configured.json()).resolves.toMatchObject({ state: "configured", codexCommand: command });

      const dispatched = await app.handle(new Request(`http://local.test/api/agents/sessions/${session.id}/handoff`, { method: "POST" }));
      expect(dispatched.status).toBe(200);
      const dispatchedJson = await dispatched.json() as { state: string; resultPath: string; stdout: string; exitCode: number };
      expect(dispatchedJson.state).toBe("completed");
      expect(dispatchedJson.exitCode).toBe(0);
      expect(dispatchedJson.stdout).toContain("codex handoff ok");
      await expect(readFile(join(dataDir, "..", dispatchedJson.resultPath), "utf8")).resolves.toContain("codex handoff ok");

      const snapshot = await app.handle(new Request("http://local.test/api/workspace"));
      const snapshotJson = await snapshot.json() as { agentHandoffs: unknown[]; artifacts: Array<{ path: string }> };
      expect(snapshotJson.agentHandoffs).toHaveLength(2);
      expect(snapshotJson.artifacts.some((artifact) => artifact.path === dispatchedJson.resultPath)).toBe(true);
    } finally {
      if (previousCommand === undefined) delete process.env.POLYLAB_CODEX_COMMAND;
      else process.env.POLYLAB_CODEX_COMMAND = previousCommand;
      await rm(join(dataDir, ".."), { recursive: true, force: true });
    }
  });

  it("persists and renders markdown and latex documents", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `docs-${crypto.randomUUID()}`, ".polylab");
    const app = createApp(new WorkspaceStore({ dataDir }));
    const markdown = await app.handle(new Request("http://local.test/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "note",
        kind: "markdown",
        title: "Note",
        path: "notebooks/note.md",
        source: "# Note\n\nLinked {{formula:softmax-jacobian}}\n\nArtifact {{artifact:artifacts/executions/run/stdout.txt}}\n\n```mermaid\ngraph TD\n  A --> B\n```\n\n```python\nprint('doc')\n```\n",
        linkedFormulaIds: ["softmax-jacobian"]
      })
    }));
    const markdownJson = await markdown.json() as { previewHtml: string; buildLog: string[] };
    expect(markdownJson.previewHtml).toContain("formula-ref");
    expect(markdownJson.previewHtml).toContain("artifact-ref");
    expect(markdownJson.previewHtml).toContain("mermaid-block");
    expect(markdownJson.previewHtml).toContain("data-executable=\"true\"");
    expect(markdownJson.buildLog).toContain("Rendered 1 Mermaid diagram.");
    expect(markdownJson.buildLog).toContain("Marked 1 executable code block.");

    const latex = await app.handle(new Request("http://local.test/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "paper",
        kind: "latex",
        title: "Paper",
        path: "papers/paper.tex",
        source: "\\begin{equation}\\label{eq:linear}\ny = x\n\\end{equation}\nSee \\ref{eq:linear} and \\cite{smith2024}.\n@smith2024{Linear Systems|Jane Smith|2024|PolyLab}"
      })
    }));
    const latexJson = await latex.json() as { previewHtml: string; buildLog: string[]; citationKeys: string[]; bibliography: Array<{ key: string }> };
    expect(latexJson.previewHtml).toContain("bibliography");
    expect(latexJson.buildLog).toContain("Rendered 1 equation block.");
    expect(latexJson.buildLog).toContain("Indexed 1 equation reference.");
    expect(latexJson.buildLog).toContain("Resolved 1 citation with 1 bibliography entry.");
    expect(latexJson.citationKeys).toEqual(["smith2024"]);
    expect(latexJson.bibliography).toContainEqual(expect.objectContaining({ key: "smith2024" }));
    const paper = await readFile(join(dataDir, "..", "papers", "paper.tex"), "utf8");
    expect(paper).toContain("y = x");

    const pdf = await app.handle(new Request("http://local.test/api/documents/paper/export-pdf", { method: "POST" }));
    expect(pdf.status).toBe(200);
    const pdfJson = await pdf.json() as { document: { pdfArtifactPath: string }; artifact: { mediaType: string; path: string } };
    expect(pdfJson.artifact.mediaType).toBe("application/pdf");
    expect(pdfJson.document.pdfArtifactPath).toBe(pdfJson.artifact.path);
    const pdfBytes = await readFile(join(dataDir, "..", pdfJson.artifact.path));
    expect(pdfBytes.subarray(0, 8).toString()).toStartWith("%PDF-1.");
    await expect(readFile(join(dataDir, "..", "artifacts", "documents", "paper", "bibliography.json"), "utf8")).resolves.toContain("smith2024");
    await rm(join(dataDir, ".."), { recursive: true, force: true });
  });

  it("executes notebook cells and exports scripts", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `notebook-${crypto.randomUUID()}`, ".polylab");
    const app = createApp(new WorkspaceStore({ dataDir }));
    const created = await app.handle(new Request("http://local.test/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "analysis-notebook",
        kind: "notebook",
        title: "Analysis Notebook",
        path: "notebooks/analysis.polybook.md",
        source: "",
        cells: [
          { id: "intro", kind: "markdown", language: "markdown", source: "# Analysis", artifactPaths: [], updatedAt: new Date().toISOString() },
          { id: "run", kind: "code", language: "python", source: "print('cell-output')", artifactPaths: [], updatedAt: new Date().toISOString() }
        ]
      })
    }));
    expect(created.status).toBe(200);

    const executed = await app.handle(new Request("http://local.test/api/documents/analysis-notebook/cells/run/run", { method: "POST" }));
    expect(executed.status).toBe(200);
    const notebook = await executed.json() as { cells: Array<{ id: string; output?: string; executionState?: string; artifactPaths: string[] }> };
    const cell = notebook.cells.find((item) => item.id === "run");
    expect(cell?.output).toContain("cell-output");
    expect(cell?.executionState).toBe("succeeded");
    expect(cell?.artifactPaths.length).toBe(1);

    const exported = await app.handle(new Request("http://local.test/api/documents/analysis-notebook/export-script", { method: "POST" }));
    await expect(exported.json()).resolves.toMatchObject({ path: "notebooks/analysis-notebook.py", source: expect.stringContaining("cell-output") });
    await expect(readFile(join(dataDir, "..", "notebooks", "analysis-notebook.py"), "utf8")).resolves.toContain("print('cell-output')");
    await rm(join(dataDir, ".."), { recursive: true, force: true });
  });

  it("pushes and pulls workspace files through sync manifests", async () => {
    const dataDir = join(import.meta.dir, "..", ".test-data", `sync-${crypto.randomUUID()}`, ".polylab");
    const remotePath = join(import.meta.dir, "..", ".test-data", `remote-${crypto.randomUUID()}`);
    const workspaceRoot = join(dataDir, "..");
    const app = createApp(new WorkspaceStore({ dataDir }));
    await mkdir(join(workspaceRoot, "notebooks"), { recursive: true });
    await writeFile(join(workspaceRoot, "notebooks", "sync.md"), "# Sync\n");

    const push = await app.handle(new Request("http://local.test/api/sync/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remotePath })
    }));
    expect(push.status).toBe(200);
    await expect(push.json()).resolves.toMatchObject({ direction: "push", state: "succeeded", filesCopied: 1 });
    await expect(readFile(join(remotePath, "notebooks", "sync.md"), "utf8")).resolves.toBe("# Sync\n");

    await writeFile(join(remotePath, "notebooks", "sync.md"), "# Pulled\n");
    const pull = await app.handle(new Request("http://local.test/api/sync/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remotePath })
    }));
    await expect(pull.json()).resolves.toMatchObject({ direction: "pull", state: "succeeded", filesCopied: 1 });
    await expect(readFile(join(workspaceRoot, "notebooks", "sync.md"), "utf8")).resolves.toBe("# Pulled\n");

    const status = await app.handle(new Request("http://local.test/api/sync/status"));
    const runs = await status.json() as Array<{ direction: string }>;
    expect(runs.map((run) => run.direction)).toEqual(["pull", "push"]);
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(remotePath, { recursive: true, force: true });
  });
});
