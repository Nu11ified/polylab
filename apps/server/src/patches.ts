import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative } from "node:path";
import type { FormulaCard, PatchHunk, PatchReview } from "@polylab/types";

export function createImplementationPatch(formula: FormulaCard): PatchReview {
  const createdAt = new Date().toISOString();
  const functionName = formula.id.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const filePath = `src/generated/${functionName || "formula"}.py`;
  const after = implementationFor(formula, functionName || "formula");
  return {
    id: crypto.randomUUID(),
    formulaId: formula.id,
    title: `Generate ${formula.title} implementation`,
    explanation: `Creates a reference Python implementation for ${formula.title}.`,
    status: "pending",
    hunks: [
      {
        id: crypto.randomUUID(),
        filePath,
        summary: `Create ${filePath}`,
        before: "",
        after,
        status: "pending"
      }
    ],
    createdAt,
    updatedAt: createdAt
  };
}

export async function applyHunk(workspaceRoot: string, hunk: PatchHunk) {
  const file = safeWorkspacePath(workspaceRoot, hunk.filePath);
  await mkdir(dirname(file), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (hunk.before && existing !== hunk.before) {
    throw new Error(`Patch hunk no longer applies cleanly to ${hunk.filePath}`);
  }
  await writeFile(file, hunk.after);
}

function safeWorkspacePath(workspaceRoot: string, filePath: string) {
  const resolved = normalize(join(workspaceRoot, filePath));
  const rel = relative(workspaceRoot, resolved);
  if (rel.startsWith("..") || rel === "" || rel.startsWith("/")) {
    throw new Error("Patch path escapes workspace");
  }
  return resolved;
}

function implementationFor(formula: FormulaCard, functionName: string) {
  if (formula.id === "softmax-jacobian") {
    return `import numpy as np\n\n\ndef ${functionName}(s: np.ndarray) -> np.ndarray:\n    \"\"\"Generated from ${formula.title}: ${formula.equation}.\"\"\"\n    return np.diag(s) - np.outer(s, s)\n`;
  }
  return `def ${functionName}(x):\n    \"\"\"Generated placeholder for ${formula.title}: ${formula.equation}.\"\"\"\n    return x\n`;
}
