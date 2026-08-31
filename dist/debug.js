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
function querySqliteWithPython(dbPath, query) {
    const pyCode = `
import sqlite3, json, sys
try:
    conn = sqlite3.connect(f'file:{sys.argv[1]}?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    rows = [dict(r) for r in c.execute(sys.argv[2]).fetchall()]
    print(json.dumps(rows))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;
    try {
        const res = childProcess.execFileSync("python3", ["-c", pyCode, dbPath, query], {
            encoding: "utf-8",
            timeout: 3000,
        });
        const parsed = JSON.parse(res.trim());
        if (parsed && !Array.isArray(parsed) && parsed.error) {
            console.log(`    Python SQLite error: ${parsed.error}`);
            return [];
        }
        return Array.isArray(parsed) ? parsed : [];
    }
    catch (e) {
        console.log(`    Python invocation failed: ${e.message}`);
        return [];
    }
}
async function runDiagnostics() {
    console.log("=================================================");
    console.log(" OpenClaw TencentDB Diagnostics & State Inspector");
    console.log("=================================================\n");
    const home = os.homedir();
    const rootDir = fs.existsSync("/root/.openclaw") ? "/root/.openclaw" : path.join(home, ".openclaw");
    console.log(`[1] OpenClaw Root Directory: ${rootDir}`);
    // Load config
    let config = {};
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
        }
        catch (e) {
            console.log(`[!] Failed reading openclaw.json: ${e.message}`);
        }
    }
    else {
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
    }
    catch (err) {
        console.log(`[!] Core search (:8420) failed: ${err.message}`);
    }
    try {
        const testTurn = [
            { role: "user", content: "Diagnostics Test User Message" },
            { role: "assistant", content: "Diagnostics Test Assistant Reply" },
        ];
        await client.importTurn("diagnostics-test-session", testTurn);
        console.log(`[✓] Import (:8125) succeeded! Test message written to TencentDB L0!`);
    }
    catch (err) {
        console.log(`[!] Import (:8125) failed: ${err.message}`);
    }
    // 3. Find all SQLite files
    console.log("\n[3] Searching for SQLite Databases in OpenClaw...");
    const sqliteFiles = [];
    function walk(dir, depth = 0) {
        if (depth > 4 || !fs.existsSync(dir))
            return;
        try {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
                const full = path.join(dir, item.name);
                if (item.isDirectory()) {
                    if (item.name !== "node_modules" && item.name !== ".git") {
                        walk(full, depth + 1);
                    }
                }
                else if (item.isFile() && (item.name.endsWith(".sqlite") || item.name.endsWith(".db"))) {
                    if (!item.name.includes("-wal") && !item.name.includes("-shm") && !item.name.includes("-lock")) {
                        sqliteFiles.push(full);
                    }
                }
            }
        }
        catch { }
    }
    walk(rootDir);
    console.log(`Found ${sqliteFiles.length} SQLite database(s):`);
    for (const f of sqliteFiles) {
        console.log(`  -> ${f}`);
    }
    // 4. Inspect each SQLite database using Python
    console.log("\n[4] Inspecting SQLite Tables & Recent Records via Python3...");
    for (const dbPath of sqliteFiles) {
        console.log(`\n--- Inspecting: ${dbPath} ---`);
        const tables = querySqliteWithPython(dbPath, "SELECT name FROM sqlite_master WHERE type='table'");
        console.log(`Tables (${tables.length}):`, tables.map((t) => t.name).join(", "));
        for (const t of tables) {
            const tName = t.name;
            if (tName.startsWith("sqlite_") || tName.startsWith("_"))
                continue;
            const countRows = querySqliteWithPython(dbPath, `SELECT count(*) as cnt FROM "${tName}"`);
            const rowCount = countRows[0]?.cnt || 0;
            const cols = querySqliteWithPython(dbPath, `PRAGMA table_info("${tName}")`);
            const colNames = cols.map((c) => c.name);
            console.log(`  * Table "${tName}" (rows: ${rowCount}): [${colNames.join(", ")}]`);
            if (rowCount > 0) {
                const sample = querySqliteWithPython(dbPath, `SELECT * FROM "${tName}" ORDER BY rowid DESC LIMIT 2`);
                console.log(`    Recent sample:`, JSON.stringify(sample, null, 2).slice(0, 350));
            }
        }
    }
    console.log("\n=================================================");
    console.log(" Diagnostics complete.");
    console.log("=================================================");
}
runDiagnostics().catch(console.error);
//# sourceMappingURL=debug.js.map