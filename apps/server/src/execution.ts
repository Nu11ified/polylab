import type { ExecutionRequest, ExecutionRoute, ExecutionRun } from "@polylab/types";

const LOCAL_ALLOWLIST = new Set(["echo", "python", "python3", "node", "bun"]);
const MAX_OUTPUT = 64_000;

export function routeExecution(request: ExecutionRequest): ExecutionRoute {
  if (request.target && request.target !== "auto") {
    return { target: request.target, reason: "User selected an explicit execution target." };
  }
  if (request.sandbox === "docker") {
    return { target: "docker", reason: "User requested Docker sandbox execution." };
  }
  if (request.allowNetwork === false) {
    return { target: "docker", reason: "Network-isolated workloads run in the Docker sandbox when available." };
  }
  if (request.gpuRequired) {
    return { target: "modal", reason: "GPU workloads are routed to a cloud GPU provider by default." };
  }
  if (request.notebook || request.command.endsWith(".ipynb")) {
    return { target: "google-notebook", reason: "Notebook-native educational workloads are routed to a Google notebook runtime." };
  }
  if ((request.estimatedSeconds ?? 0) > 900 || (request.memoryMb ?? 0) > 16_384) {
    return { target: "vps", reason: "Long-running or high-memory workloads are routed away from the local desktop." };
  }
  return { target: "local", reason: "Small deterministic workload can run locally with low overhead." };
}

export async function runExecution(request: ExecutionRequest, cwd: string): Promise<ExecutionRun> {
  const route = routeExecution(request);
  const startedAt = new Date().toISOString();
  const base: ExecutionRun = {
    id: crypto.randomUUID(),
    command: request.command,
    route,
    state: route.target === "local" || route.target === "docker" ? "running" : "skipped",
    stdout: "",
    stderr: "",
    startedAt,
    sandbox: route.target === "docker" ? "docker" : "none"
  };

  if (route.target === "docker") {
    return runDockerExecution(request, cwd, base);
  }

  if (route.target !== "local") {
    return {
      ...base,
      state: "skipped",
      stderr: `Execution routed to ${route.target}; remote workers are not connected yet.`,
      finishedAt: new Date().toISOString()
    };
  }

  const argv = parseCommand(request.command);
  if (!argv[0] || !LOCAL_ALLOWLIST.has(argv[0])) {
    return {
      ...base,
      state: "failed",
      exitCode: 126,
      stderr: `Command '${argv[0] ?? ""}' is not in the local execution allowlist.`,
      finishedAt: new Date().toISOString()
    };
  }

  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" }
  });

  const timeout = setTimeout(() => proc.kill(), 30_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  clearTimeout(timeout);

  return {
    ...base,
    state: exitCode === 0 ? "succeeded" : "failed",
    exitCode,
    stdout: truncate(stdout),
    stderr: truncate(stderr),
    finishedAt: new Date().toISOString()
  };
}

async function runDockerExecution(request: ExecutionRequest, cwd: string, base: ExecutionRun): Promise<ExecutionRun> {
  const image = request.dockerImage ?? process.env.POLYLAB_DOCKER_IMAGE ?? "python:3.12-slim";
  if (process.env.POLYLAB_ENABLE_DOCKER !== "1") {
    return {
      ...base,
      state: "skipped",
      exitCode: 127,
      stderr: "Docker sandbox execution is disabled; set POLYLAB_ENABLE_DOCKER=1 to run containers.",
      finishedAt: new Date().toISOString()
    };
  }
  const dockerAvailable = await commandAvailable("docker");
  if (!dockerAvailable) {
    return {
      ...base,
      state: "skipped",
      exitCode: 127,
      stderr: "Docker is not available; install Docker or run without sandbox.",
      finishedAt: new Date().toISOString()
    };
  }
  const dockerArgs = [
    "run",
    "--rm",
    "--workdir",
    "/workspace",
    "--volume",
    `${cwd}:/workspace`,
    "--cpus",
    "2",
    "--memory",
    `${Math.max(128, request.memoryMb ?? 512)}m`
  ];
  if (request.allowNetwork === false) dockerArgs.push("--network", "none");
  dockerArgs.push(image, "sh", "-lc", request.command);

  const proc = Bun.spawn(["docker", ...dockerArgs], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" }
  });
  const timeout = setTimeout(() => proc.kill(), 60_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  clearTimeout(timeout);
  return {
    ...base,
    state: exitCode === 0 ? "succeeded" : "failed",
    exitCode,
    stdout: truncate(stdout),
    stderr: truncate(stderr),
    finishedAt: new Date().toISOString()
  };
}

async function commandAvailable(command: string) {
  const proc = Bun.spawn(["timeout", "2", command, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" }
  });
  const code = await proc.exited.catch(() => 1);
  return code === 0;
}

export function parseCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (const char of command.trim()) {
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = undefined;
      continue;
    }
    if (char === " " && !quote) {
      if (current) args.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

function truncate(value: string) {
  return value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n[output truncated]` : value;
}
