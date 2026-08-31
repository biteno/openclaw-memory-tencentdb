/**
 * File Watcher for OpenClaw Sessions & Transcripts
 *
 * Continuously monitors OpenClaw workspace memory & session directories,
 * parses completed dialogue turns, and pushes them directly to TencentDB.
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
    private watchDirs;
    private intervalTimer;
    private processedSignatures;
    private fileOffsets;
    private isRunning;
    constructor(client: TencentDBClient, logger: Logger, customWatchDirs?: string[]);
    start(pollIntervalMs?: number): void;
    stop(): void;
    private scanDirs;
    private processFile;
    private parseAndSyncMarkdown;
    private parseAndSyncJsonl;
    private syncTurn;
}
export {};
//# sourceMappingURL=watcher.d.ts.map