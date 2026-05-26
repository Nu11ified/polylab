import type { FormulaCard } from "@polylab/types";

export type LocalMutationStatus = "pending" | "failed";

export interface LocalMutation {
  id: string;
  type: "create-formula";
  method: "POST";
  path: string;
  body: Partial<FormulaCard>;
  status: LocalMutationStatus;
  attempts: number;
  createdAt: string;
  error?: string;
  optimisticId?: string;
}

export function enqueueMutation(queue: LocalMutation[], mutation: LocalMutation): LocalMutation[] {
  return [mutation, ...queue.filter((item) => item.id !== mutation.id)];
}

export function markMutationFailed(queue: LocalMutation[], id: string, error: string): LocalMutation[] {
  return queue.map((item) => item.id === id ? { ...item, status: "failed", attempts: item.attempts + 1, error } : item);
}

export function markMutationSynced(queue: LocalMutation[], id: string): LocalMutation[] {
  return queue.filter((item) => item.id !== id);
}

export function reconcileOptimisticFormula(formulas: FormulaCard[], optimisticId: string, serverFormula: FormulaCard): FormulaCard[] {
  return [serverFormula, ...formulas.filter((formula) => formula.id !== optimisticId && formula.id !== serverFormula.id)];
}

export function pendingMutationCount(queue: LocalMutation[]): number {
  return queue.filter((item) => item.status === "pending").length;
}
