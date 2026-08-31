/**
 * File Watcher for OpenClaw Sessions & Transcripts
 *
 * Continuously monitors OpenClaw workspace memory & session directories,
 * parses completed dialogue turns, and pushes them directly to TencentDB.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
  private watchDirs: string[];
  private intervalTimer: NodeJS.Timeout | null = null;
  private processedSignatures = new Set<string>();
  private fileOffsets = new Map<string, number>();
  private isRunning = false;

  constructor(client: TencentDBClient, logger: Logger, customWatchDirs?: string[]) {
    this.client = client;
    this.logger = logger;

    const homeDir = os.homedir();
    const defaultDirs = [
      path.join(homeDir, ".openclaw", "workspace", "memory"),
      path.join(homeDir, ".openclaw", "workspace"),
      path.join(homeDir, ".openclaw", "sessions"),
      path.join(homeDir, ".openclaw", "agents"),
      path.join(homeDir, ".openclaw", "workspace", "memory", ".dreams"),
      "/root/.openclaw/workspace/memory",
      "/root/.openclaw/workspace",
      "/root/.openclaw/sessions",
      "/root/.openclaw/agents",
    ];

    this.watchDirs = customWatchDirs && customWatchDirs.length > 0 ? customWatchDirs : defaultDirs;
  }

  public start(pollIntervalMs = 4000) {
    if (this.isRunning) return;
    this.isRunning = true;

    this.logger.info(`[openclaw-memory-tencentdb] Session File-Watcher started (polling every ${pollIntervalMs}ms)`);

    // Initial scan to establish baseline offsets
    this.scanDirs(true);

    // Periodic polling to catch all writes reliably across all Linux filesystems
    this.intervalTimer = setInterval(() => {
      if (this.isRunning) {
        this.scanDirs(false);
      }
    }, pollIntervalMs);
  }

  public stop() {
    this.isRunning = false;
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.logger.info("[openclaw-memory-tencentdb] Session File-Watcher stopped");
  }

  private scanDirs(isBaseline: boolean) {
    for (const dir of this.watchDirs) {
      if (!fs.existsSync(dir)) continue;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;

          const ext = path.extname(entry.name).toLowerCase();
          if (ext !== ".md" && ext !== ".jsonl" && ext !== ".json") continue;

          const filePath = path.join(dir, entry.name);
          this.processFile(filePath, isBaseline);
        }
      } catch (err: any) {
        // Ignore permission or transient dir read errors
      }
    }
  }

  private processFile(filePath: string, isBaseline: boolean) {
    try {
      const stats = fs.statSync(filePath);
      const lastOffset = this.fileOffsets.get(filePath) || 0;

      // If file was not modified since baseline, skip
      if (isBaseline) {
        this.fileOffsets.set(filePath, stats.size);
        return;
      }

      if (stats.size <= lastOffset) {
        return;
      }

      // Read full file content
      const content = fs.readFileSync(filePath, "utf-8");
      this.fileOffsets.set(filePath, stats.size);

      const fileName = path.basename(filePath);
      const ext = path.extname(fileName).toLowerCase();

      if (ext === ".md") {
        this.parseAndSyncMarkdown(content, fileName);
      } else if (ext === ".jsonl") {
        this.parseAndSyncJsonl(content, fileName);
      }
    } catch (err: any) {
      this.logger.debug?.(`[openclaw-memory-tencentdb] File read error on ${filePath}: ${err.message}`);
    }
  }

  private parseAndSyncMarkdown(content: string, fileName: string) {
    // Pattern to match "user: <text>" and "assistant: <text>" blocks
    const pattern = /^(user|assistant):\s*([\s\S]+?)(?=(?:^(?:user|assistant):|\Z))/gim;
    const matches: Array<{ role: string; content: string }> = [];

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const role = match[1].toLowerCase();
      const text = match[2].trim();
      if (text) {
        matches.push({ role, content: text });
      }
    }

    let currentUser = "";
    for (const item of matches) {
      if (item.role === "user") {
        currentUser = item.content.replace(/<tencentdb-memory>[\s\S]*?<\/tencentdb-memory>/g, "").trim();
      } else if (item.role === "assistant" && currentUser) {
        const assistantText = item.content.trim();
        this.syncTurn(currentUser, assistantText, fileName);
        currentUser = "";
      }
    }
  }

  private parseAndSyncJsonl(content: string, fileName: string) {
    const lines = content.split("\n");
    let currentUser = "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const obj = JSON.parse(trimmed);
        const role = String(obj.role || obj.sender || obj.type || "").toLowerCase();
        let text = "";

        if (typeof obj.content === "string") {
          text = obj.content;
        } else if (typeof obj.text === "string") {
          text = obj.text;
        } else if (typeof obj.message === "string") {
          text = obj.message;
        }

        text = text.trim();
        if (!text) continue;

        if (role === "user" || role === "human") {
          currentUser = text.replace(/<tencentdb-memory>[\s\S]*?<\/tencentdb-memory>/g, "").trim();
        } else if ((role === "assistant" || role === "model" || role === "bot") && currentUser) {
          this.syncTurn(currentUser, text, fileName);
          currentUser = "";
        }
      } catch {
        // Skip invalid JSON lines
      }
    }
  }

  private syncTurn(user: string, assistant: string, sourceFile: string) {
    if (!user || !assistant) return;

    const signature = `${user}:::${assistant}`;
    if (this.processedSignatures.has(signature)) {
      return; // Already synced
    }
    this.processedSignatures.add(signature);

    const sessionId = `openclaw-file-${sourceFile.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

    this.logger.info(
      `[openclaw-memory-tencentdb] [File-Watcher] Discovered new turn in ${sourceFile} — syncing to TencentDB (user: "${user.slice(0, 35)}...")`,
    );

    this.client
      .importTurn(sessionId, [
        { role: "user", content: user },
        { role: "assistant", content: assistant },
      ])
      .then(() => {
        this.logger.info(
          `[openclaw-memory-tencentdb] [File-Watcher] Successfully synced turn from ${sourceFile} to TencentDB L0!`,
        );
      })
      .catch((err: any) => {
        this.logger.warn(
          `[openclaw-memory-tencentdb] [File-Watcher] Sync failed for ${sourceFile}: ${err.message || String(err)}`,
        );
      });
  }
}
