import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { SyncEntry, SyncManifest, SyncRun } from "@polylab/types";

const ignoredRoots = new Set([".git", ".polylab", "node_modules", "release", "dist", "server-bin"]);

export async function pushWorkspace(workspaceRoot: string, remotePath: string): Promise<SyncRun> {
  return sync("push", workspaceRoot, remotePath);
}

export async function pullWorkspace(workspaceRoot: string, remotePath: string): Promise<SyncRun> {
  return sync("pull", workspaceRoot, remotePath);
}

async function sync(direction: SyncRun["direction"], workspaceRoot: string, remotePath: string): Promise<SyncRun> {
  const startedAt = new Date().toISOString();
  const sourceRoot = direction === "push" ? workspaceRoot : remotePath;
  const targetRoot = direction === "push" ? remotePath : workspaceRoot;
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });

  try {
    const manifest = await buildManifest(sourceRoot, workspaceRoot);
    let filesCopied = 0;
    for (const file of manifest.files) {
      await copyTrackedFile(sourceRoot, targetRoot, file.path);
      filesCopied += 1;
    }
    await writeManifest(remotePath, direction === "push" ? manifest : await buildManifest(remotePath, workspaceRoot));
    return {
      id: crypto.randomUUID(),
      direction,
      state: "succeeded",
      remotePath,
      filesScanned: manifest.files.length,
      filesCopied,
      manifest,
      message: `${direction === "push" ? "Pushed" : "Pulled"} ${filesCopied} workspace files.`,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  } catch (error) {
    const manifest = await buildManifest(sourceRoot, workspaceRoot).catch(() => emptyManifest(workspaceRoot));
    return {
      id: crypto.randomUUID(),
      direction,
      state: "failed",
      remotePath,
      filesScanned: manifest.files.length,
      filesCopied: 0,
      manifest,
      message: error instanceof Error ? error.message : "Sync failed",
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }
}

async function buildManifest(root: string, workspaceRoot: string): Promise<SyncManifest> {
  const files = await listFiles(root);
  const entries = await Promise.all(files.map(async (path): Promise<SyncEntry> => {
    const absolute = join(root, path);
    const [content, info] = await Promise.all([readFile(absolute), stat(absolute)]);
    return {
      path,
      size: info.size,
      sha256: createHash("sha256").update(content).digest("hex"),
      updatedAt: info.mtime.toISOString()
    };
  }));
  return {
    id: crypto.randomUUID(),
    workspaceRoot,
    files: entries.sort((left, right) => left.path.localeCompare(right.path)),
    createdAt: new Date().toISOString()
  };
}

async function listFiles(root: string, current = root): Promise<string[]> {
  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".polylab-sync-manifest.json") continue;
    const absolute = join(current, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    const rootName = path.split("/")[0] ?? path;
    if (ignoredRoots.has(rootName)) continue;
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

async function copyTrackedFile(sourceRoot: string, targetRoot: string, path: string) {
  const source = join(sourceRoot, path);
  const target = join(targetRoot, path);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

async function writeManifest(remotePath: string, manifest: SyncManifest) {
  await mkdir(remotePath, { recursive: true });
  await writeFile(join(remotePath, ".polylab-sync-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function emptyManifest(workspaceRoot: string): SyncManifest {
  return {
    id: crypto.randomUUID(),
    workspaceRoot,
    files: [],
    createdAt: new Date().toISOString()
  };
}
