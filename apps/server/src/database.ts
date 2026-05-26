import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { PersistenceEvent, PersistenceStatus } from "@polylab/types";

const workspaceEntities = sqliteTable("workspace_entities", {
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  jsonPath: text("json_path").notNull(),
  payload: text("payload").notNull(),
  updatedAt: text("updated_at").notNull()
});

const workspaceEvents = sqliteTable("workspace_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  operation: text("operation").notNull(),
  createdAt: text("created_at").notNull()
});

export class WorkspaceDatabase {
  readonly path: string;
  private readonly sqlite: Database;
  private readonly db: ReturnType<typeof drizzle>;

  constructor(dataDir: string) {
    this.path = join(dataDir, "workspace.db");
    mkdirSync(dirname(this.path), { recursive: true });
    this.sqlite = new Database(this.path);
    this.sqlite.exec("pragma journal_mode = WAL; pragma synchronous = NORMAL;");
    this.sqlite.exec(`
      create table if not exists workspace_entities (
        entity_type text not null,
        entity_id text not null,
        json_path text not null,
        payload text not null,
        updated_at text not null,
        primary key (entity_type, entity_id)
      );
      create table if not exists workspace_events (
        id integer primary key autoincrement,
        entity_type text not null,
        entity_id text not null,
        operation text not null,
        created_at text not null
      );
      create index if not exists workspace_events_created_at_idx on workspace_events(created_at);
    `);
    this.db = drizzle(this.sqlite);
  }

  recordJsonWrite(path: string, value: unknown) {
    const now = new Date().toISOString();
    const records = extractRecords(path, value);
    if (records.length === 0) return;
    this.db.transaction((transaction) => {
      for (const record of records) {
        const payload = JSON.stringify(record.payload);
        transaction.insert(workspaceEntities)
          .values({
            entityType: record.entityType,
            entityId: record.entityId,
            jsonPath: path,
            payload,
            updatedAt: now
          })
          .onConflictDoUpdate({
            target: [workspaceEntities.entityType, workspaceEntities.entityId],
            set: {
              jsonPath: path,
              payload,
              updatedAt: now
            }
          })
          .run();
        transaction.insert(workspaceEvents)
          .values({ entityType: record.entityType, entityId: record.entityId, operation: "upsert", createdAt: now })
          .run();
      }
    });
  }

  status(): PersistenceStatus {
    const entityCount = this.sqlite.query<{ count: number }, []>("select count(*) as count from workspace_entities").get()?.count ?? 0;
    const eventCount = this.sqlite.query<{ count: number }, []>("select count(*) as count from workspace_events").get()?.count ?? 0;
    const lastEventAt = this.sqlite.query<{ created_at: string }, []>("select created_at from workspace_events order by created_at desc limit 1").get()?.created_at;
    return {
      engine: "sqlite",
      orm: "drizzle",
      path: this.path,
      entityCount,
      eventCount,
      lastEventAt
    };
  }

  events(limit = 50): PersistenceEvent[] {
    return this.db.select()
      .from(workspaceEvents)
      .orderBy(desc(workspaceEvents.id))
      .limit(Math.max(1, Math.min(200, limit)))
      .all()
      .map((event) => ({
        id: event.id,
        entityType: event.entityType,
        entityId: event.entityId,
        operation: event.operation === "delete" ? "delete" : "upsert",
        createdAt: event.createdAt
      }));
  }

  entityPayload(entityType: string, entityId: string): unknown | undefined {
    const row = this.db.select({ payload: workspaceEntities.payload })
      .from(workspaceEntities)
      .where(sql`${workspaceEntities.entityType} = ${entityType} and ${workspaceEntities.entityId} = ${entityId}`)
      .limit(1)
      .get();
    return row ? JSON.parse(row.payload) : undefined;
  }

  entitiesByType(entityType: string): unknown[] {
    return this.db.select({ payload: workspaceEntities.payload })
      .from(workspaceEntities)
      .where(eq(workspaceEntities.entityType, entityType))
      .all()
      .map((row) => JSON.parse(row.payload));
  }
}

function extractRecords(path: string, value: unknown) {
  const entityType = entityTypeForPath(path);
  if (!entityType) return [];
  if (Array.isArray(value)) {
    return value.map((item, index) => ({
      entityType,
      entityId: extractId(item, `${path}:${index}`),
      payload: item
    }));
  }
  return [{ entityType, entityId: extractId(value, path), payload: value }];
}

function entityTypeForPath(path: string) {
  if (path === "project.json") return "project";
  if (path === "formulas.json") return "formula";
  if (path === "tasks.json") return "task";
  if (path === "documents.json") return "document";
  if (path === "artifacts.json") return "artifact";
  if (path === "logs.json") return "log";
  if (path === "execution/runs.json") return "execution";
  if (path === "benchmarks/runs.json") return "benchmark";
  if (path === "cloud/providers.json") return "cloud-provider";
  if (path === "cloud/jobs.json") return "cloud-job";
  if (path === "deployment/plans.json") return "deployment-plan";
  if (path === "sync/runs.json") return "sync-run";
  if (path === "sessions/patches.json") return "patch";
  if (path === "sessions/agent-sessions.json") return "agent-session";
  if (path === "activity/events.json") return "activity-event";
  if (path === "security/permissions.json") return "permission";
  if (path === "security/permission-checks.json") return "permission-check";
  if (path === "editor/presets.json") return "editor-preset";
  if (path === "settings.json") return "settings";
  return undefined;
}

function extractId(value: unknown, fallback: string) {
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") return value.id;
  if (value && typeof value === "object" && "name" in value && typeof value.name === "string") return value.name;
  return fallback;
}
