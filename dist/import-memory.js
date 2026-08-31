/**
 * One-Shot Batch Importer: OpenClaw Local Memory -> TencentDB L0
 *
 * Reads ~/.openclaw/workspace/MEMORY.md and ~/.openclaw/workspace/memory/*.md
 * Automatically chunks large files (>7000 chars) to adhere to TencentDB limits.
 *
 * Run with: node /root/.openclaw/extensions/openclaw-memory-tencentdb/dist/import-memory.js
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TencentDBClient } from "./client.js";
function chunkText(text, maxLen = 7000) {
    if (text.length <= maxLen)
        return [text];
    const chunks = [];
    const lines = text.split("\n");
    let currentChunk = "";
    for (const line of lines) {
        if ((currentChunk + "\n" + line).length > maxLen) {
            if (currentChunk.trim()) {
                chunks.push(currentChunk.trim());
            }
            currentChunk = line;
        }
        else {
            currentChunk += (currentChunk ? "\n" : "") + line;
        }
    }
    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }
    return chunks;
}
async function runImport() {
    console.log("=================================================");
    console.log(" OpenClaw -> TencentDB Memory Migration Tool");
    console.log(" (with automatic chunking for >8192 char limit)");
    console.log("=================================================\n");
    const home = os.homedir();
    const rootDir = fs.existsSync("/root/.openclaw") ? "/root/.openclaw" : path.join(home, ".openclaw");
    // Load config
    let config = {};
    const configPath = path.join(rootDir, "openclaw.json");
    if (fs.existsSync(configPath)) {
        try {
            const fullConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            config =
                fullConfig.plugins?.entries?.["openclaw-memory-tencentdb"]?.config ||
                    fullConfig.plugins?.entries?.["openclaw-memory-tencentdb"] ||
                    {};
        }
        catch { }
    }
    const client = new TencentDBClient({
        coreUrl: config.coreUrl || "http://tencentdb.itsc.local:8420",
        importUrl: config.importUrl || "http://tencentdb.itsc.local:8125",
        knowledgeUrl: config.knowledgeUrl || "http://tencentdb.itsc.local:8424",
        userKey: config.userKey,
        teamId: config.teamId || "team-thpa5ncu0p",
        agentId: config.agentId || "agt-th8bvq00pv",
    });
    console.log(`Target Agent: ${client.getAgentId()} | Team: ${client.getTeamId()}`);
    console.log(`TencentDB Import Endpoint: ${config.importUrl || "http://tencentdb.itsc.local:8125"}\n`);
    let totalImported = 0;
    // 1. Import MEMORY.md (core durable facts)
    const memoryMdPath = path.join(rootDir, "workspace", "MEMORY.md");
    if (fs.existsSync(memoryMdPath)) {
        console.log(`[1] Processing ${memoryMdPath}...`);
        const content = fs.readFileSync(memoryMdPath, "utf-8");
        const sections = content.split(/^##\s+/m);
        for (const section of sections) {
            const cleanSec = section.trim();
            if (!cleanSec || cleanSec.startsWith("#"))
                continue;
            const lines = cleanSec.split("\n");
            const title = lines[0].trim();
            const body = lines.slice(1).join("\n").trim();
            if (body) {
                const chunks = chunkText(body, 7000);
                for (let idx = 0; idx < chunks.length; idx++) {
                    const chunk = chunks[idx];
                    const suffix = chunks.length > 1 ? ` (Teil ${idx + 1}/${chunks.length})` : "";
                    try {
                        await client.importTurn(`openclaw-migration-memory-md-${title.replace(/[^a-zA-Z0-9_-]/g, "_")}-${idx}`, [
                            { role: "user", content: `Faktensammlung / Kontext zu: ${title}${suffix}` },
                            { role: "assistant", content: chunk },
                        ]);
                        console.log(`  [✓] Imported section: "${title}"${suffix}`);
                        totalImported++;
                    }
                    catch (e) {
                        console.log(`  [!] Failed section "${title}"${suffix}: ${e.message}`);
                    }
                }
            }
        }
    }
    // 2. Import daily memory files (~/.openclaw/workspace/memory/*.md)
    const memoryDir = path.join(rootDir, "workspace", "memory");
    if (fs.existsSync(memoryDir)) {
        console.log(`\n[2] Processing memory files in ${memoryDir}...`);
        const files = fs.readdirSync(memoryDir).filter((f) => f.endsWith(".md"));
        console.log(`Found ${files.length} memory markdown files.`);
        for (const file of files) {
            const filePath = path.join(memoryDir, file);
            const content = fs.readFileSync(filePath, "utf-8").trim();
            if (!content || content.length < 20)
                continue;
            const chunks = chunkText(content, 7000);
            for (let idx = 0; idx < chunks.length; idx++) {
                const chunk = chunks[idx];
                const suffix = chunks.length > 1 ? ` (Teil ${idx + 1}/${chunks.length})` : "";
                try {
                    await client.importTurn(`openclaw-migration-${file.replace(".md", "")}-${idx}`, [
                        { role: "user", content: `Erinnerungen und Notizen vom Datum / Thema: ${file}${suffix}` },
                        { role: "assistant", content: chunk },
                    ]);
                    console.log(`  [✓] Imported file: ${file}${suffix}`);
                    totalImported++;
                }
                catch (e) {
                    console.log(`  [!] Failed file ${file}${suffix}: ${e.message}`);
                }
            }
        }
    }
    console.log("\n=================================================");
    console.log(` Migration complete! Total entries/chunks imported: ${totalImported}`);
    console.log("=================================================");
}
runImport().catch(console.error);
//# sourceMappingURL=import-memory.js.map