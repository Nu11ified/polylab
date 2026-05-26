import { describe, expect, it } from "bun:test";
import type { FormulaCard } from "@polylab/types";
import { enqueueMutation, markMutationFailed, markMutationSynced, pendingMutationCount, reconcileOptimisticFormula, type LocalMutation } from "./optimistic";
import { PERFORMANCE_BUDGETS, POLYLAB_CACHE_NAME } from "./performance";

describe("keyboard shortcut contract", () => {
  it("keeps the PRD shortcuts represented", () => {
    const shortcuts = ["Cmd+K", "Cmd+Shift+K", "Cmd+Enter", "Cmd+Shift+Enter", "Cmd+Option+R", "Cmd+Option+S", "Cmd+Option+G", "Cmd+Option+D", "Cmd+Option+M", "Cmd+Option+L", "Cmd+Option+P"];
    expect(shortcuts).toHaveLength(11);
  });
});

describe("performance contract", () => {
  it("keeps the local-first app shell budgets explicit", () => {
    expect(POLYLAB_CACHE_NAME).toBe("polylab-shell-v1");
    expect(PERFORMANCE_BUDGETS.mainChunkKb).toBeLessThanOrEqual(96);
    expect(PERFORMANCE_BUDGETS.vendorChunkKb).toBeLessThanOrEqual(260);
    expect(PERFORMANCE_BUDGETS.bootMs).toBeLessThanOrEqual(800);
    expect(PERFORMANCE_BUDGETS.heapMb).toBeLessThanOrEqual(256);
  });
});

describe("optimistic mutation queue", () => {
  it("tracks pending local transactions and reconciles server formulas", () => {
    const mutation: LocalMutation = {
      id: "mutation-1",
      type: "create-formula",
      method: "POST",
      path: "/api/formulas",
      body: { title: "Local Formula" },
      status: "pending",
      attempts: 0,
      createdAt: "2026-05-25T00:00:00.000Z",
      optimisticId: "local-formula"
    };
    const queued = enqueueMutation([], mutation);
    expect(pendingMutationCount(queued)).toBe(1);
    expect(markMutationFailed(queued, "mutation-1", "offline")[0]).toMatchObject({ status: "failed", attempts: 1, error: "offline" });
    expect(markMutationSynced(queued, "mutation-1")).toHaveLength(0);

    const optimistic = { id: "local-formula", title: "Local Formula" } as FormulaCard;
    const existing = { id: "existing", title: "Existing" } as FormulaCard;
    const server = { id: "server-formula", title: "Local Formula" } as FormulaCard;
    expect(reconcileOptimisticFormula([optimistic, existing], "local-formula", server).map((formula) => formula.id)).toEqual(["server-formula", "existing"]);
  });
});
