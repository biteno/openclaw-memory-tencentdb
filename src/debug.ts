/**
 * Diagnostic & Debug Script for OpenClaw TencentDB Integration
 *
 * Run with: node /root/.openclaw/extensions/openclaw-memory-tencentdb/dist/debug.js
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import childProcess from "node:child_process";
import { TencentDBClient } from "./client.js";

async function runDiagnostics() {
  console.log("=================================================");
  console.log(" OpenClaw TencentDB Diagnostics & State Inspector");
  console.log("=================================================\n");

  const home = os.homedir();
  const rootDir = fs.existsSync("/root/.openclaw") ? "/root/.openclaw" : path.join(home, ".openclaw");
  console.log(`[1] OpenClaw Root Directory: ${rootDir}`);

  // Load config
  let config: any = {};
  const configPath = path.join(rootDir, "openclaw.json");
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const fullConfig = JSON.parse(raw);
      config =
        fullConfig.plugins?.entries?.["openclaw-memory-tencentdb"]?.config ||
        fullConfig.plugins?.entries?.["openclaw-memory-tencentdb"] ||
        {};
      console.log(`[✓] Loaded openclaw.json:`);
      console.log(`    - coreUrl: ${config.coreUrl || "not set"}`);
      console.log(`    - importUrl: ${config.importUrl || "not set"}`);
      console.log(`    - teamId: ${config.teamId || "not set"}`);
      console.log(`    - agentId: ${config.agentId || "not set"}`);
    } catch (e: any) {
      console.log(`[!] Failed reading openclaw.json: ${e.message}`);
    }
  } else {
    console.log(`[!] No openclaw.json found at ${configPath}`);
  }

  // 2. Test Connection to TencentDB
  console.log("\n[2] Testing TencentDB Connectivity & Import...");
  const client = new TencentDBClient({
    coreUrl: config.coreUrl || "http://tencentdb.itsc.local:8420",
    importUrl: config.importUrl || "http://tencentdb.itsc.local:8125",
    knowledgeUrl: config.knowledgeUrl || "http://tencentdb.itsc.local:8424",
    userKey: config.userKey,
    teamId: config.teamId || "team-thpa5ncu0p",
    agentId: config.agentId || "agt-th8bvq00pv",
  });

  try {
    const convSearch = await client.searchConversation("test", 1);
    console.log(`[✓] Core search (:8420) succeeded. HTTP 200 OK`);
  } catch (err: any) {
    console.log(`[!] Core search (:8420) failed: ${err.message}`);
  }

  try {
    const testTurn = [
      { role: "user", content: "Diagnostics Test User Message" },
      { role: "assistant", content: "Diagnostics Test Assistant Reply" },
    ];
    await client.importTurn("diagnostics-test-session", testTurn);
    console.log(`[✓] Import (:8125) succeeded! Test message written to TencentDB L0!`);
  } catch (err: any) {
    console.log(`[!] Import (:8125) failed: ${err.message}`);
  }

  // 3. Find all SQLite files
  console.log("\n[3] Searching for SQLite Databases in OpenClaw...");
  const sqliteFiles: string[] = [];

  function walk(dir: string, depth = 0) {
    if (depth > 4 || !fs.existsSync(dir)) return;
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          if (item.name !== "node_modules" && item.name !== ".git") {
            walk(full, depth + 1);
          }
        } else if (item.isFile() && (item.name.endsWith(".sqlite") || item.name.endsWith(".db"))) {
          sqliteFiles.push(full);
        }
      }
    } catch {}
  }

  walk(rootDir);
  console.log(`Found ${sqliteFiles.length} SQLite database(s):`);
  for (const f of sqliteFiles) {
    console.log(`  -> ${f}`);
  }

  // 4. Inspect each SQLite database
  console.log("\n[4] Inspecting SQLite Tables & Recent Records...");
  let DatabaseSyncClass: any = null;
  try {
    DatabaseSyncClass = require("node:sqlite").DatabaseSync;
  } catch {}

  for (const dbPath of sqliteFiles) {
    console.log(`\n--- Inspecting: ${dbPath} ---`);
    if (DatabaseSyncClass) {
      try {
        const db = new DatabaseSyncClass(dbPath, { readOnly: true });
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        console.log(`Tables (${tables.length}):`, tables.map((t: any) => t.name).join(", "));

        for (const t of tables) {
          const tName = t.name;
          if (tName.startsWith("sqlite_")) continue;
          try {
            const countRow = db.prepare(`SELECT count(*) as cnt FROM "${tName}"`).get();
            const cols = db.prepare(`PRAGMA table_info("${tName}")`).all().map((c: any) => c.name);
            console.log(`  * Table "${tName}" (rows: ${countRow.cnt}): [${cols.join(", ")}]`);

            if (countRow.cnt > 0) {
              const sample = db.prepare(`SELECT * FROM "${tName}" ORDER BY rowid DESC LIMIT 2`).all();
              console.log(`    Recent sample:`, JSON.stringify(sample, null, 2).slice(0, 300));
            }
          } catch (te: any) {
            console.log(`    Error reading table ${tName}: ${te.message}`);
          }
        }
        db.close();
      } catch (err: any) {
        console.log(`DatabaseSync error on ${dbPath}: ${err.message}`);
      }
    } else {
      console.log(`(node:sqlite not available, trying sqlite3 CLI)`);
      try {
        const tables = childProcess.execSync(`sqlite3 "${dbPath}" ".tables"`, { encoding: "utf-8" }).trim();
        console.log(`Tables: ${tables}`);
      } catch (e: any) {
        console.log(`sqlite3 CLI error: ${e.message}`);
      }
    }
  }

  // 5. Inspect Workspace Memory & Session files
  console.log("\n[5] Inspecting Workspace Memory Files...");
  const memDir = path.join(rootDir, "workspace", "memory");
  if (fs.existsSync(memDir)) {
    const files = fs.readdirSync(memDir);
    console.log(`Found ${files.length} file(s) in ${memDir}:`, files.slice(0, 10).join(", "));
  } else {
    console.log(`Directory ${memDir} does not exist.`);
  }

  console.log("\n=================================================");
  console.log(" Diagnostics complete.");
  console.log("=================================================");
}

runDiagnostics().catch(console.error);
