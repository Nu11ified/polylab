import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative, sep } from "node:path";
import type { GitCommitResult, GitConflict, GitFileStatus, GitOperationResult, GitRemote, GitStatus, GitVerificationSummary } from "@polylab/types";

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const result = await runGit(cwd, ["status", "--porcelain=v1", "--branch"]);
  if (!result.ok) {
    return {
      initialized: false,
      branch: "not initialized",
      ahead: 0,
      behind: 0,
      files: [],
      conflicts: [],
      summary: "Git repository has not been initialized."
    };
  }

  const lines = result.stdout.trim().split("\n").filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("##")) ?? "## main";
  const files = lines.filter((line) => !line.startsWith("##")).map(parseStatusLine);
  const conflicts = await Promise.all(files.filter((file) => file.conflicted).map((file) => readConflict(cwd, file.path)));
  const resolvedConflicts = conflicts.filter((conflict): conflict is GitConflict => Boolean(conflict));
  const branch = parseBranch(branchLine);
  const ahead = parseCount(branchLine, "ahead");
  const behind = parseCount(branchLine, "behind");

  return {
    initialized: true,
    branch,
    ahead,
    behind,
    files,
    conflicts: resolvedConflicts,
    summary: resolvedConflicts.length > 0
      ? `${resolvedConflicts.length} conflicted file${resolvedConflicts.length === 1 ? "" : "s"}.`
      : files.length === 0 ? "Working tree clean." : `${files.length} changed file${files.length === 1 ? "" : "s"}.`
  };
}

export async function gitDiff(cwd: string): Promise<{ initialized: boolean; diff: string }> {
  const result = await runGit(cwd, ["diff", "--", "."]);
  return result.ok ? { initialized: true, diff: result.stdout } : { initialized: false, diff: "" };
}

export async function gitConflicts(cwd: string): Promise<GitConflict[]> {
  return (await gitStatus(cwd)).conflicts;
}

export async function gitResolveConflict(cwd: string, path: string, strategy: "ours" | "theirs" | "manual", content?: string): Promise<GitOperationResult> {
  await ensureGit(cwd);
  const file = resolveGitPath(cwd, path);
  if (strategy === "manual") {
    if (typeof content !== "string") throw new Error("Manual conflict resolution requires content");
    await writeFile(file, content);
  } else {
    const result = await runGit(cwd, ["checkout", `--${strategy}`, "--", path]);
    if (!result.ok) throw new Error(result.stderr || `git checkout --${strategy} failed`);
  }
  const add = await runGit(cwd, ["add", "--", path]);
  if (!add.ok) throw new Error(add.stderr || "git add resolved file failed");
  const status = await gitStatus(cwd);
  return {
    ok: true,
    message: `Resolved ${path} using ${strategy}.`,
    status
  };
}

export async function gitInit(cwd: string): Promise<GitStatus> {
  const result = await runGit(cwd, ["init"]);
  if (!result.ok) throw new Error(result.stderr || "git init failed");
  return gitStatus(cwd);
}

export async function gitRemotes(cwd: string): Promise<GitRemote[]> {
  await ensureGit(cwd);
  const result = await runGit(cwd, ["remote", "-v"]);
  if (!result.ok) throw new Error(result.stderr || "git remote failed");
  const byName = new Map<string, string>();
  for (const line of result.stdout.trim().split("\n").filter(Boolean)) {
    const [name, url] = line.split(/\s+/);
    if (name && url && !byName.has(name)) byName.set(name, url);
  }
  return [...byName.entries()].map(([name, url]) => ({ name, url }));
}

export async function gitBranches(cwd: string): Promise<string[]> {
  await ensureGit(cwd);
  const result = await runGit(cwd, ["branch", "--format=%(refname:short)"]);
  if (!result.ok) throw new Error(result.stderr || "git branch failed");
  return result.stdout.trim().split("\n").map((branch) => branch.trim()).filter(Boolean);
}

export async function gitAddRemote(cwd: string, name: string, url: string): Promise<GitOperationResult> {
  await ensureGit(cwd);
  const safeName = sanitizeRemoteName(name);
  const existing = (await gitRemotes(cwd)).some((remote) => remote.name === safeName);
  const result = existing
    ? await runGit(cwd, ["remote", "set-url", safeName, url])
    : await runGit(cwd, ["remote", "add", safeName, url]);
  if (!result.ok) throw new Error(result.stderr || "git remote add failed");
  return {
    ok: true,
    message: existing ? `Updated remote ${safeName}.` : `Added remote ${safeName}.`,
    remotes: await gitRemotes(cwd),
    status: await gitStatus(cwd)
  };
}

export async function gitCreateBranch(cwd: string, branch: string): Promise<GitOperationResult> {
  await ensureGit(cwd);
  const safeBranch = sanitizeBranchName(branch);
  const result = await runGit(cwd, ["checkout", "-B", safeBranch]);
  if (!result.ok) throw new Error(result.stderr || "git branch create failed");
  return {
    ok: true,
    message: `Checked out ${safeBranch}.`,
    branches: await gitBranches(cwd),
    status: await gitStatus(cwd)
  };
}

export async function gitCheckoutBranch(cwd: string, branch: string): Promise<GitOperationResult> {
  await ensureGit(cwd);
  const safeBranch = sanitizeBranchName(branch);
  const result = await runGit(cwd, ["checkout", safeBranch]);
  if (!result.ok) throw new Error(result.stderr || "git checkout failed");
  return {
    ok: true,
    message: `Checked out ${safeBranch}.`,
    branches: await gitBranches(cwd),
    status: await gitStatus(cwd)
  };
}

export async function gitPush(cwd: string, remote = "origin", branch?: string): Promise<GitOperationResult> {
  await ensureGit(cwd);
  const status = await gitStatus(cwd);
  const result = await runGit(cwd, ["push", "-u", sanitizeRemoteName(remote), sanitizeBranchName(branch ?? status.branch)]);
  if (!result.ok) throw new Error(result.stderr || "git push failed");
  return {
    ok: true,
    message: result.stdout.trim() || result.stderr.trim() || "Pushed branch.",
    remotes: await gitRemotes(cwd),
    status: await gitStatus(cwd)
  };
}

export async function gitPull(cwd: string, remote = "origin", branch?: string): Promise<GitOperationResult> {
  await ensureGit(cwd);
  const status = await gitStatus(cwd);
  const result = await runGit(cwd, ["pull", "--ff-only", sanitizeRemoteName(remote), sanitizeBranchName(branch ?? status.branch)]);
  if (!result.ok) throw new Error(result.stderr || "git pull failed");
  return {
    ok: true,
    message: result.stdout.trim() || "Pulled branch.",
    remotes: await gitRemotes(cwd),
    status: await gitStatus(cwd)
  };
}

export async function gitClone(cwd: string, url: string, directory: string): Promise<GitOperationResult> {
  const safeDirectory = sanitizeDirectoryName(directory);
  const result = await runGit(cwd, ["clone", url, safeDirectory]);
  if (!result.ok) throw new Error(result.stderr || "git clone failed");
  return {
    ok: true,
    message: `Cloned ${url} into ${safeDirectory}.`,
    path: join(cwd, safeDirectory)
  };
}

export async function gitStageAll(cwd: string): Promise<GitStatus> {
  await ensureGit(cwd);
  const result = await runGit(cwd, ["add", "--all", "--", "."]);
  if (!result.ok) throw new Error(result.stderr || "git add failed");
  return gitStatus(cwd);
}

export async function gitCommit(cwd: string, message: string, verificationSummary?: GitVerificationSummary): Promise<GitCommitResult> {
  await ensureGit(cwd);
  const statusBefore = await gitStatus(cwd);
  const filesCommitted = statusBefore.files.filter((file) => file.index.trim() || file.worktree.trim()).length;
  if (filesCommitted === 0) {
    return {
      ok: false,
      branch: statusBefore.branch,
      message: "No changes to commit.",
      filesCommitted: 0,
      status: statusBefore
    };
  }

  const stage = await runGit(cwd, ["add", "--all", "--", "."]);
  if (!stage.ok) throw new Error(stage.stderr || "git add failed");

  const commitArgs = [
    "-c", "user.name=PolyLab",
    "-c", "user.email=polylab@local",
    "commit",
    "-m", sanitizeCommitMessage(message)
  ];
  if (verificationSummary) {
    commitArgs.push("-m", renderVerificationCommitBody(verificationSummary));
  }
  const commit = await runGit(cwd, commitArgs);
  if (!commit.ok) throw new Error(commit.stderr || "git commit failed");

  const hash = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
  const status = await gitStatus(cwd);
  return {
    ok: true,
    hash: hash.stdout.trim(),
    branch: status.branch,
    message: commit.stdout.trim() || "Committed workspace changes.",
    filesCommitted,
    status,
    verificationSummary
  };
}

async function runGit(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd) },
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  return { ok: code === 0, stdout, stderr };
}

async function ensureGit(cwd: string) {
  const status = await gitStatus(cwd);
  if (!status.initialized) await gitInit(cwd);
}

function parseStatusLine(line: string): GitFileStatus {
  const index = line[0] ?? " ";
  const worktree = line[1] ?? " ";
  const path = line.slice(3).trim();
  return { index, worktree, path, conflicted: isConflictStatus(index, worktree) };
}

function isConflictStatus(index: string, worktree: string) {
  const code = `${index}${worktree}`;
  return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code);
}

async function readConflict(cwd: string, path: string): Promise<GitConflict | undefined> {
  const file = resolveGitPath(cwd, path);
  const content = await readFile(file, "utf8").catch(() => "");
  const ours = await readStage(cwd, "2", path);
  const theirs = await readStage(cwd, "3", path);
  const base = await readStage(cwd, "1", path);
  return {
    path,
    ours,
    theirs,
    base,
    markerCount: (content.match(/^<<<<<<< /gm) ?? []).length
  };
}

async function readStage(cwd: string, stage: "1" | "2" | "3", path: string) {
  const result = await runGit(cwd, ["show", `:${stage}:${path}`]);
  return result.ok ? result.stdout : "";
}

function resolveGitPath(cwd: string, path: string) {
  const normalized = normalize(path);
  const resolved = normalize(join(cwd, normalized));
  const offset = relative(cwd, resolved);
  if (offset.startsWith("..") || offset === ".." || offset.includes(`..${sep}`) || offset === "") {
    throw new Error("Git path escapes the repository root");
  }
  return resolved;
}

function parseBranch(line: string) {
  const clean = line.replace(/^##\s*/, "");
  if (clean.startsWith("No commits yet on ")) return clean.replace("No commits yet on ", "");
  return clean.split("...")[0]?.split(" ")[0] ?? "main";
}

function parseCount(line: string, kind: "ahead" | "behind") {
  const match = line.match(new RegExp(`${kind} (\\d+)`));
  return match?.[1] ? Number(match[1]) : 0;
}

function sanitizeCommitMessage(message: string) {
  const firstLine = message.split(/\r?\n/)[0]?.trim() ?? "";
  return firstLine.slice(0, 120) || "PolyLab workspace update";
}

function renderVerificationCommitBody(summary: GitVerificationSummary) {
  return [
    "PolyLab-Verification:",
    `status=${summary.status}`,
    `formulas=${summary.formulaCount}`,
    `passed=${summary.passed}`,
    `warning=${summary.warning}`,
    `failed=${summary.failed}`,
    `queued=${summary.queued}`,
    `linked=${summary.linkedFormulaIds.join(",") || "none"}`,
    `createdAt=${summary.createdAt}`
  ].join("\n");
}

function sanitizeRemoteName(name: string) {
  const clean = name.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(clean)) throw new Error("Invalid Git remote name");
  return clean;
}

function sanitizeBranchName(branch: string) {
  const clean = branch.trim();
  if (!clean || clean.startsWith("-") || clean.includes("..") || /[\s~^:?*[\\]/.test(clean)) throw new Error("Invalid Git branch name");
  return clean;
}

function sanitizeDirectoryName(directory: string) {
  const clean = directory.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(clean) || clean === "." || clean === "..") throw new Error("Invalid clone directory");
  return clean;
}
