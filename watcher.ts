/**
 * Comprehensive Session Watcher for OpenClaw
 *
 * Monitors OpenClaw's per-agent SQLite databases (~/.openclaw/agents/ * /agent/openclaw-agent.sqlite)
 * and workspace memory files, extracting active dialogue turns and syncing them to TencentDB L0.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import childProcess from "node:child_process";
import type { TencentDBClient } from "./client.js";

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug?(msg: string): void;
}

export class OpenClawSessionWatcher {
  private client: TencentDBClient;
  private logger: Logger;
  private intervalTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  // Track max rowid / IDs seen per table in SQLite databases
  private sqliteWatermarks = new Map<string, number>();
  // Track file size / offsets for text files
  private fileOffsets = new Map<string, number>();
  // Deduplicate synced turns
  private processedSignatures = new Set<string>();
  // Pending user messages per session for pairing
  private sessionPendingUser = new Map<string, string>();

  constructor(client: TencentDBClient, logger: Logger) {
    this.client = client;
    this.logger = logger;
  }

  public start(pollIntervalMs = 3000) {
    if (this.isRunning) return;
    this.isRunning = true;

    this.logger.info(`[openclaw-memory-tencentdb] Session & SQLite Watcher started (interval: ${pollIntervalMs}ms)`);

    // First scan baseline
    this.scanAll(true);

    // Periodic scanner
    this.intervalTimer = setInterval(() => {
      if (this.isRunning) {
        this.scanAll(false);
      }
    }, pollIntervalMs);
  }

  public stop() {
    this.isRunning = false;
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.logger.info("[openclaw-memory-tencentdb] Session Watcher stopped");
  }

  private scanAll(isBaseline: boolean) {
    try {
      this.scanSqliteDatabases(isBaseline);
      this.scanTextFiles(isBaseline);
    } catch (err: any) {
      this.logger.debug?.(`[openclaw-memory-tencentdb] Scan error: ${err.message}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 1. SQLite Scanner (OpenClaw 2026+ active state plane)
  // ──────────────────────────────────────────────────────────────────────────

  private scanSqliteDatabases(isBaseline: boolean) {
    const candidatePaths = this.findSqlitePaths();

    for (const dbPath of candidatePaths) {
      if (!fs.existsSync(dbPath)) continue;

      try {
        this.inspectAndSyncSqlite(dbPath, isBaseline);
      } catch (err: any) {
        this.logger.debug?.(`[openclaw-memory-tencentdb] SQLite read error on ${dbPath}: ${err.message}`);
      }
    }
  }

  private findSqlitePaths(): string[] {
    const home = os.homedir();
    const roots = [
      path.join(home, ".openclaw"),
      "/root/.openclaw",
    ];

    const results = new Set<string>();

    for (const root of roots) {
      if (!fs.existsSync(root)) continue;

      // Check agents directory: ~/.openclaw/agents/<agent>/agent/openclaw-agent.sqlite
      const agentsDir = path.join(root, "agents");
      if (fs.existsSync(agentsDir)) {
        try {
          const agents = fs.readdirSync(agentsDir, { withFileTypes: true });
          for (const ag of agents) {
            if (!ag.isDirectory()) continue;
            const agDb = path.join(agentsDir, ag.name, "agent", "openclaw-agent.sqlite");
            if (fs.existsSync(agDb)) results.add(agDb);
            const agDbDirect = path.join(agentsDir, ag.name, "openclaw-agent.sqlite");
            if (fs.existsSync(agDbDirect)) results.add(agDbDirect);
          }
        } catch {}
      }

      // Check state directory
      const stateDb = path.join(root, "state", "openclaw.sqlite");
      if (fs.existsSync(stateDb)) results.add(stateDb);

      // Check memory directory
      const memDir = path.join(root, "memory");
      if (fs.existsSync(memDir)) {
        try {
          const files = fs.readdirSync(memDir, { withFileTypes: true });
          for (const f of files) {
            if (f.isFile() && f.name.endsWith(".sqlite")) {
              results.add(path.join(memDir, f.name));
            }
          }
        } catch {}
      }
    }

    return Array.from(results);
  }

  private inspectAndSyncSqlite(dbPath: string, isBaseline: boolean) {
    let DatabaseSyncClass: any = null;
    try {
      // Try native Node.js 22+ SQLite
      const sqliteModule = require("node:sqlite");
      DatabaseSyncClass = sqliteModule.DatabaseSync;
    } catch {}

    if (DatabaseSyncClass) {
      this.readSqliteWithNode(DatabaseSyncClass, dbPath, isBaseline);
    } else {
      this.readSqliteWithCli(dbPath, isBaseline);
    }
  }

  private readSqliteWithNode(DatabaseSyncClass: any, dbPath: string, isBaseline: boolean) {
    let db: any = null;
    try {
      db = new DatabaseSyncClass(dbPath, { readOnly: true });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();

      for (const t of tables) {
        const tableName = t.name;
        if (tableName.startsWith("sqlite_") || tableName.startsWith("_")) continue;

        const key = `${dbPath}::${tableName}`;
        const lastWatermark = this.sqliteWatermarks.get(key) || 0;

        // Inspect columns
        const colInfo = db.prepare(`PRAGMA table_info("${tableName}")`).all();
        const colNames = colInfo.map((c: any) => c.name.toLowerCase());

        const hasRelevantCols = colNames.some((c: string) =>
          ["content", "text", "message", "payload", "payload_json", "role", "sender", "session_key"].includes(c),
        );
        if (!hasRelevantCols) continue;

        if (isBaseline) {
          try {
            const maxRow = db.prepare(`SELECT MAX(rowid) as maxid FROM "${tableName}"`).get();
            const maxId = Number(maxRow?.maxid || 0);
            this.sqliteWatermarks.set(key, maxId);
          } catch {
            this.sqliteWatermarks.set(key, 0);
          }
          continue;
        }

        // Query new rows
        try {
          const rows = db.prepare(`SELECT rowid as _rowid, * FROM "${tableName}" WHERE rowid > ? ORDER BY rowid ASC`).all(lastWatermark);
          let currentMax = lastWatermark;

          for (const row of rows) {
            const rowId = Number(row._rowid);
            if (rowId > currentMax) currentMax = rowId;
            this.processSqliteRow(row, dbPath, tableName);
          }

          this.sqliteWatermarks.set(key, currentMax);
        } catch (queryErr: any) {
          // Table may not have rowid
        }
      }
    } catch (err: any) {
      this.logger.debug?.(`[openclaw-memory-tencentdb] DatabaseSync error on ${dbPath}: ${err.message}`);
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  private readSqliteWithCli(dbPath: string, isBaseline: boolean) {
    try {
      const getTablesCmd = `sqlite3 "${dbPath}" "SELECT name FROM sqlite_master WHERE type='table';"`;
      const tableOutput = childProcess.execSync(getTablesCmd, { encoding: "utf-8", timeout: 2000 });
      const tableNames = tableOutput.split("\n").map((s) => s.trim()).filter(Boolean);

      for (const tableName of tableNames) {
        if (tableName.startsWith("sqlite_") || tableName.startsWith("_")) continue;
        const key = `${dbPath}::${tableName}`;
        const lastWatermark = this.sqliteWatermarks.get(key) || 0;

        if (isBaseline) {
          try {
            const maxCmd = `sqlite3 "${dbPath}" "SELECT IFNULL(MAX(rowid), 0) FROM \\"${tableName}\\";"`;
            const maxVal = parseInt(childProcess.execSync(maxCmd, { encoding: "utf-8", timeout: 1500 }).trim(), 10) || 0;
            this.sqliteWatermarks.set(key, maxVal);
          } catch {
            this.sqliteWatermarks.set(key, 0);
          }
          continue;
        }

        const queryCmd = `sqlite3 -json "${dbPath}" "SELECT rowid as _rowid, * FROM \\"${tableName}\\" WHERE rowid > ${lastWatermark} ORDER BY rowid ASC;"`;
        const jsonOut = childProcess.execSync(queryCmd, { encoding: "utf-8", timeout: 2500 }).trim();
        if (!jsonOut || jsonOut === "[]") continue;

        const rows = JSON.parse(jsonOut);
        let currentMax = lastWatermark;

        for (const row of rows) {
          const rowId = Number(row._rowid);
          if (rowId > currentMax) currentMax = rowId;
          this.processSqliteRow(row, dbPath, tableName);
        }

        this.sqliteWatermarks.set(key, currentMax);
      }
    } catch {}
  }

  private processSqliteRow(row: any, dbPath: string, tableName: string) {
    const { role, content, sessionKey } = this.extractRoleAndContent(row);
    if (!role || !content) return;

    // Filter memory context injection
    const cleanContent = content.replace(/<tencentdb-memory>[\s\S]*?<\/tencentdb-memory>/g, "").trim();
    if (!cleanContent) return;

    const sKey = sessionKey || "openclaw-default-session";

    if (role === "user" || role === "human") {
      this.sessionPendingUser.set(sKey, cleanContent);
    } else if (role === "assistant" || role === "model" || role === "bot") {
      const pendingUser = this.sessionPendingUser.get(sKey);
      if (pendingUser) {
        this.syncTurn(pendingUser, cleanContent, `sqlite:${path.basename(dbPath)}/${tableName}`);
        this.sessionPendingUser.delete(sKey);
      }
    }
  }

  private extractRoleAndContent(row: Record<string, any>): { role?: string; content?: string; sessionKey?: string } {
    let role: string | undefined;
    let content: string | undefined;
    let sessionKey: string | undefined;

    for (const sk of ["session_key", "session_id", "sessionkey", "sessionid", "session"]) {
      if (row[sk]) {
        sessionKey = String(row[sk]);
        break;
      }
    }

    for (const rk of ["role", "sender", "type", "author", "speaker"]) {
      if (row[rk]) {
        role = String(row[rk]).toLowerCase();
        break;
      }
    }

    for (const ck of ["content", "text", "message", "body", "payload", "payload_json", "val"]) {
      if (row[ck]) {
        const val = row[ck];
        if (typeof val === "string" && (val.trim().startsWith("{") || val.trim().startsWith("["))) {
          try {
            const parsed = JSON.parse(val);
            if (parsed && typeof parsed === "object") {
              if (!role && (parsed.role || parsed.type || parsed.sender)) {
                role = String(parsed.role || parsed.type || parsed.sender).toLowerCase();
              }
              if (!sessionKey && (parsed.session_key || parsed.sessionKey || parsed.sessionId)) {
                sessionKey = String(parsed.session_key || parsed.sessionKey || parsed.sessionId);
              }
              if (parsed.content) content = typeof parsed.content === "string" ? parsed.content : JSON.stringify(parsed.content);
              else if (parsed.text) content = String(parsed.text);
              else if (parsed.message) content = String(parsed.message);
            }
          } catch {
            content = String(val);
          }
        } else {
          content = String(val);
        }
        if (content) break;
      }
    }

    return { role, content, sessionKey };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Text File Scanner (.md and .jsonl files in workspace)
  // ──────────────────────────────────────────────────────────────────────────

  private scanTextFiles(isBaseline: boolean) {
    const homeDir = os.homedir();
    const dirs = [
      path.join(homeDir, ".openclaw", "workspace", "memory"),
      path.join(homeDir, ".openclaw", "workspace"),
      path.join(homeDir, ".openclaw", "sessions"),
      "/root/.openclaw/workspace/memory",
      "/root/.openclaw/workspace",
      "/root/.openclaw/sessions",
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (ext !== ".md" && ext !== ".jsonl") continue;

          const filePath = path.join(dir, entry.name);
          this.processTextFile(filePath, isBaseline);
        }
      } catch {}
    }
  }

  private processTextFile(filePath: string, isBaseline: boolean) {
    try {
      const stats = fs.statSync(filePath);
      const lastOffset = this.fileOffsets.get(filePath) || 0;

      if (isBaseline) {
        this.fileOffsets.set(filePath, stats.size);
        return;
      }

      if (stats.size <= lastOffset) return;

      const content = fs.readFileSync(filePath, "utf-8");
      this.fileOffsets.set(filePath, stats.size);

      const fileName = path.basename(filePath);
      if (fileName.endsWith(".md")) {
        this.parseMarkdown(content, fileName);
      } else if (fileName.endsWith(".jsonl")) {
        this.parseJsonl(content, fileName);
      }
    } catch {}
  }

  private parseMarkdown(content: string, fileName: string) {
    const pattern = /^(user|assistant):\s*([\s\S]+?)(?=(?:^(?:user|assistant):|\Z))/gim;
    const matches: Array<{ role: string; content: string }> = [];

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const role = match[1].toLowerCase();
      const text = match[2].trim();
      if (text) matches.push({ role, content: text });
    }

    let currentUser = "";
    for (const item of matches) {
      if (item.role === "user") {
        currentUser = item.content.replace(/<tencentdb-memory>[\s\S]*?<\/tencentdb-memory>/g, "").trim();
      } else if (item.role === "assistant" && currentUser) {
        this.syncTurn(currentUser, item.content.trim(), fileName);
        currentUser = "";
      }
    }
  }

  private parseJsonl(content: string, fileName: string) {
    const lines = content.split("\n");
    let currentUser = "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const obj = JSON.parse(trimmed);
        const role = String(obj.role || obj.sender || "").toLowerCase();
        const text = String(obj.content || obj.text || obj.message || "").trim();
        if (!text) continue;

        if (role === "user" || role === "human") {
          currentUser = text.replace(/<tencentdb-memory>[\s\S]*?<\/tencentdb-memory>/g, "").trim();
        } else if ((role === "assistant" || role === "model") && currentUser) {
          this.syncTurn(currentUser, text, fileName);
          currentUser = "";
        }
      } catch {}
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Central Turn Dispatcher
  // ──────────────────────────────────────────────────────────────────────────

  private syncTurn(user: string, assistant: string, sourceDesc: string) {
    if (!user || !assistant) return;

    const signature = `${user}:::${assistant}`;
    if (this.processedSignatures.has(signature)) return;
    this.processedSignatures.add(signature);

    const sessionId = `openclaw-${sourceDesc.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

    this.logger.info(
      `[openclaw-memory-tencentdb] [Watcher] Discovered new turn via ${sourceDesc} — syncing to TencentDB (user: "${user.slice(0, 40)}...")`,
    );

    this.client
      .importTurn(sessionId, [
        { role: "user", content: user },
        { role: "assistant", content: assistant },
      ])
      .then(() => {
        this.logger.info(
          `[openclaw-memory-tencentdb] [Watcher] Successfully synced turn from ${sourceDesc} to TencentDB L0!`,
        );
      })
      .catch((err: any) => {
        this.logger.warn(
          `[openclaw-memory-tencentdb] [Watcher] Sync failed for ${sourceDesc}: ${err.message || String(err)}`,
        );
      });
  }
}
