import type { ClientPerformanceStatus } from "@polylab/types";

export const POLYLAB_CACHE_NAME = "polylab-shell-v1";

export const PERFORMANCE_BUDGETS = {
  mainChunkKb: 96,
  vendorChunkKb: 260,
  bootMs: 800,
  heapMb: 256
} as const;

type MemoryInfo = {
  usedJSHeapSize?: number;
  jsHeapSizeLimit?: number;
};

export async function registerPolylabServiceWorker() {
  if (!("serviceWorker" in navigator)) return "unsupported" as const;
  if (location.protocol === "file:") return "unsupported" as const;
  try {
    const registration = await navigator.serviceWorker.register("/polylab-sw.js", { scope: "/" });
    return serviceWorkerState(registration);
  } catch {
    return "error" as const;
  }
}

export async function collectPerformanceStatus(): Promise<ClientPerformanceStatus> {
  const memory = ("memory" in performance ? performance.memory : undefined) as MemoryInfo | undefined;
  const cacheSupported = "caches" in window;
  const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration().catch(() => undefined) : undefined;
  const bootMeasure = measureBoot();
  return {
    bootMs: bootMeasure,
    heapUsedMb: memory?.usedJSHeapSize ? bytesToMb(memory.usedJSHeapSize) : undefined,
    heapLimitMb: memory?.jsHeapSizeLimit ? bytesToMb(memory.jsHeapSizeLimit) : undefined,
    cacheSupported,
    serviceWorkerSupported: "serviceWorker" in navigator && location.protocol !== "file:",
    serviceWorkerState: registration ? serviceWorkerState(registration) : ("serviceWorker" in navigator && location.protocol !== "file:" ? "unregistered" : "unsupported"),
    cacheName: POLYLAB_CACHE_NAME,
    cachedAssetCount: cacheSupported ? await cachedAssetCount().catch(() => undefined) : undefined,
    collectedAt: new Date().toISOString()
  };
}

function measureBoot() {
  const existing = performance.getEntriesByName("polylab:boot-to-react")[0];
  if (existing) return Math.round(existing.duration * 100) / 100;
  const mark = performance.getEntriesByName("polylab:boot")[0];
  if (!mark) return undefined;
  performance.mark("polylab:react-ready");
  performance.measure("polylab:boot-to-react", "polylab:boot", "polylab:react-ready");
  const measure = performance.getEntriesByName("polylab:boot-to-react")[0];
  return measure ? Math.round(measure.duration * 100) / 100 : undefined;
}

function serviceWorkerState(registration: ServiceWorkerRegistration): ClientPerformanceStatus["serviceWorkerState"] {
  const state = registration.active?.state ?? registration.waiting?.state ?? registration.installing?.state;
  if (state === "activated") return "active";
  if (state === "installed") return "waiting";
  if (state === "activating") return "installing";
  if (state === "installing" || state === "redundant") return state;
  return "unregistered";
}

async function cachedAssetCount() {
  const cache = await caches.open(POLYLAB_CACHE_NAME);
  return (await cache.keys()).length;
}

function bytesToMb(value: number) {
  return Math.round((value / 1024 / 1024) * 10) / 10;
}
