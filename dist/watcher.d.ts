/**
 * Comprehensive Session Watcher for OpenClaw
 *
 * Monitors OpenClaw's per-agent SQLite databases (~/.openclaw/agents/ * /agent/openclaw-agent.sqlite)
 * and workspace memory files, extracting active dialogue turns and syncing them to TencentDB L0.
 */
import type { TencentDBClient } from "./client.js";
interface Logger {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug?(msg: string): void;
}
export declare class OpenClawSessionWatcher {
    private client;
    private logger;
    private intervalTimer;
    private isRunning;
    private sqliteWatermarks;
    private fileOffsets;
    private processedSignatures;
    private sessionPendingUser;
    constructor(client: TencentDBClient, logger: Logger);
    start(pollIntervalMs?: number): void;
    stop(): void;
    private scanAll;
    private scanSqliteDatabases;
    private findSqlitePaths;
    private inspectAndSyncSqlite;
    private readSqliteWithNode;
    private readSqliteWithCli;
    private processSqliteRow;
    private extractRoleAndContent;
    private scanTextFiles;
    private processTextFile;
    private parseMarkdown;
    private parseJsonl;
    private syncTurn;
}
export {};
//# sourceMappingURL=watcher.d.ts.map