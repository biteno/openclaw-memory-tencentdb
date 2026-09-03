/**
 * OpenClaw Remote TencentDB Agent Memory Plugin
 *
 * Robust bidirectional memory integration:
 * - Pre-turn semantic recall (before_agent_start)
 * - Multi-turn capture (agent_end) with support for Thinking Models (Gemini 3.7 / Claude 3.7)
 * - Tool-use & multi-block message parsing
 */

import { Type } from "@sinclair/typebox";
import { TencentDBClient } from "./client.js";
import type { TencentDBConfig } from "./types.js";

// Type definition for OpenClaw Plugin API
interface OpenClawPluginApi {
  config?: Record<string, any>;
  pluginConfig?: Record<string, any>;
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug?(msg: string): void;
  };
  on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any): void;
  registerTool(tool: {
    name: string;
    description: string;
    parameters: any;
    execute: (args: any, ctx?: any) => Promise<any>;
  }): void;
  registerService(service: {
    id: string;
    start: () => void | Promise<void>;
    stop?: () => void | Promise<void>;
  }): void;
}

function resolvePluginConfig(api: OpenClawPluginApi): TencentDBConfig {
  const candidates = [
    api.pluginConfig,
    api.config?.plugins?.entries?.["openclaw-memory-tencentdb"]?.config,
    api.config?.plugins?.entries?.["openclaw-memory-tencentdb"],
    api.config?.plugins?.entries?.["memory-tencentdb"]?.config,
    api.config?.plugins?.entries?.["memory-tencentdb"],
    api.config?.entries?.["openclaw-memory-tencentdb"]?.config,
    api.config?.entries?.["openclaw-memory-tencentdb"],
    api.config?.["openclaw-memory-tencentdb"]?.config,
    api.config?.["openclaw-memory-tencentdb"],
    api.config?.["memory-tencentdb"]?.config,
    api.config?.["memory-tencentdb"],
    api.config?.config,
    api.config,
  ];

  for (const cand of candidates) {
    if (
      cand &&
      typeof cand === "object" &&
      (cand.coreUrl || cand.userKey || cand.teamId || cand.importUrl || cand.agentId)
    ) {
      return cand;
    }
  }

  return api.pluginConfig || api.config || {};
}

function extractMessageText(msg: any): string {
  if (!msg) return "";
  if (typeof msg === "string") return msg.replace(/<tencentdb-memory>[\s\S]*?<\/tencentdb-memory>/g, "").trim();

  const textParts: string[] = [];
  const thoughtParts: string[] = [];

  const rawContent = msg.content !== undefined ? msg.content : msg.text !== undefined ? msg.text : msg.message;

  if (typeof rawContent === "string") {
    textParts.push(rawContent);
  } else if (Array.isArray(rawContent)) {
    for (const block of rawContent) {
      if (typeof block === "string") {
        textParts.push(block);
      } else if (block && typeof block === "object") {
        const bType = String(block.type || "").toLowerCase();
        const bText = typeof block.text === "string" ? block.text : typeof block.content === "string" ? block.content : "";

        if (bText) {
          if (bType === "thought" || bType === "thinking") {
            thoughtParts.push(bText);
          } else {
            textParts.push(bText);
          }
        }
      }
    }
  } else if (Array.isArray(msg.parts)) {
    for (const part of msg.parts) {
      if (typeof part === "string") textParts.push(part);
      else if (part && typeof part.text === "string") textParts.push(part.text);
    }
  }

  // If text blocks exist, prefer them over thought traces
  const resultText = textParts.length > 0 ? textParts.join("\n") : thoughtParts.join("\n");
  return resultText.replace(/<tencentdb-memory>[\s\S]*?<\/tencentdb-memory>/g, "").trim();
}

function extractFallbackText(val: any): string {
  if (!val) return "";
  if (typeof val === "string") return val.replace(/<tencentdb-memory>[\s\S]*?<\/tencentdb-memory>/g, "").trim();
  if (typeof val.finalAnswer === "string") return extractFallbackText(val.finalAnswer);
  if (typeof val.response === "string") return extractFallbackText(val.response);
  if (typeof val.output === "string") return extractFallbackText(val.output);
  if (Array.isArray(val)) {
    return val.map((item) => extractFallbackText(item)).filter(Boolean).join("\n").trim();
  }
  return "";
}

function parseToolQueryAndLimit(args: any, defaultLimit = 5): { query: string; limit: number; wikiId?: string } {
  let parsed = args;
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args);
    } catch {
      return { query: args.trim(), limit: defaultLimit };
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return { query: "", limit: defaultLimit };
  }

  const queryCandidate =
    parsed.query ||
    parsed.q ||
    parsed.searchTerm ||
    parsed.search ||
    parsed.text ||
    parsed.prompt ||
    parsed.keyword ||
    parsed.name ||
    parsed.params?.query ||
    parsed.params?.q ||
    parsed.params?.searchTerm ||
    parsed.params?.search ||
    "";

  const query = typeof queryCandidate === "string" ? queryCandidate.trim() : String(queryCandidate || "").trim();
  const limitVal = parsed.limit ?? parsed.params?.limit;
  const limit = typeof limitVal === "number" ? limitVal : defaultLimit;
  const wikiId = parsed.wiki_id || parsed.wikiId || parsed.params?.wiki_id || parsed.params?.wikiId;

  return { query, limit, wikiId };
}

const memoryPlugin = {
  id: "openclaw-memory-tencentdb",
  name: "TencentDB Agent Memory (Remote)",
  description: "Remote TencentDB Agent Memory plugin for OpenClaw — connects to central TencentDB cluster for bidirectional turn sync and prefetch recall.",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    const pluginConfig = resolvePluginConfig(api);

    const autoRecall = pluginConfig.autoRecall !== false;
    const autoCapture = pluginConfig.autoCapture !== false;
    const scoreThreshold = pluginConfig.scoreThreshold ?? 0.5;
    const maxRecallResults = pluginConfig.maxRecallResults ?? 3;

    const client = new TencentDBClient(pluginConfig);

    api.logger.info(
      `[openclaw-memory-tencentdb] Plugin registered (core: ${pluginConfig.coreUrl || "default"}, import: ${pluginConfig.importUrl || "default"}, team: ${client.getTeamId()}, agent: ${client.getAgentId()}, userKey configured: ${Boolean(pluginConfig.userKey)})`,
    );

    const syncedTurnSignatures = new Set<string>();

    // ── 1. Auto-Recall Hook (before_agent_start) ───────────────────────
    if (autoRecall) {
      api.on("before_agent_start", async (event: any, ctx: any) => {
        const prompt = extractMessageText(event);
        if (!prompt || prompt.length < 4) return;

        // Skip trivial messages
        if (/^(hi|hello|hey|ok|danke|thx|thanks|hallo|ja|nein|yes|no)$/i.test(prompt)) {
          return;
        }

        try {
          const recalledSections: string[] = [];

          // 1. Search conversation history & distilled facts (L0-L3)
          try {
            const convRes = await client.searchConversation(prompt, maxRecallResults);
            const messages = convRes?.data?.messages || [];
            const validMessages = Array.isArray(messages)
              ? messages.filter(
                  (m) =>
                    m &&
                    (m.score === undefined || m.score > 0.01 || (m.score ?? 1) >= scoreThreshold) &&
                    m.content,
                )
              : [];

            if (validMessages.length > 0) {
              const lines = validMessages.map((m) => {
                const clean = String(m.content || "").trim();
                const snippet = clean.length > 300 ? `${clean.slice(0, 297)}...` : clean;
                return `- ${snippet}`;
              });
              recalledSections.push(`### Relevante Gesprächserinnerungen (TencentDB):\n${lines.join("\n")}`);
            }
          } catch (err: any) {
            api.logger.warn(`[openclaw-memory-tencentdb] Conversation search failed: ${err.message || String(err)}`);
          }

          // 2. Search skills / distilled knowledge
          try {
            const skillRes = await client.searchSkills(prompt, 2);
            const items = skillRes?.data?.items || [];
            const validItems = Array.isArray(items) ? items.filter((item) => item && item.name) : [];

            if (validItems.length > 0) {
              const lines = validItems.map((item) => {
                const snippet = String(item.snippet || "").replace(/<[^>]+>/g, "").trim();
                return `- **${item.name}**: ${item.description || ""} (${snippet.slice(0, 200)})`;
              });
              recalledSections.push(`### Hinterlegte Skills & Dokumente (TencentDB):\n${lines.join("\n")}`);
            }
          } catch (err: any) {
            api.logger.warn(`[openclaw-memory-tencentdb] Skill search failed: ${err.message || String(err)}`);
          }

          if (recalledSections.length === 0) {
            return;
          }

          const contextBlock = `<tencentdb-memory>\n${recalledSections.join("\n\n")}\n</tencentdb-memory>`;

          api.logger.info(
            `[openclaw-memory-tencentdb] Prefetched ${recalledSections.length} memory sections into context`,
          );

          return {
            prependContext: contextBlock,
          };
        } catch (err: any) {
          api.logger.warn(`[openclaw-memory-tencentdb] Recall error: ${err.message || String(err)}`);
        }
      });
    }

    // ── 2. Auto-Capture Hook (agent_end) ───────────────────────────────
    if (autoCapture) {
      api.on("agent_end", async (event: any, ctx: any) => {
        const sKey = (ctx as any)?.sessionKey || event?.sessionKey || "main";
        const messages = Array.isArray(event?.messages) ? event.messages : [];

        let lastUserText = "";
        let lastAssistantText = "";

        // Iterate through messages in reverse to find the latest completed turn
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (!msg || typeof msg !== "object") continue;
          const role = String(msg.role || "").toLowerCase();
          const text = extractMessageText(msg);

          if (!lastAssistantText && (role === "assistant" || role === "model" || role === "bot") && text) {
            lastAssistantText = text;
          } else if (lastAssistantText && !lastUserText && (role === "user" || role === "human") && text) {
            lastUserText = text;
            break;
          }
        }

        // If user text was not found before assistant in array, scan forward for any user message
        if (!lastUserText) {
          for (const msg of messages) {
            const role = String(msg?.role || "").toLowerCase();
            if (role === "user" || role === "human") {
              const text = extractMessageText(msg);
              if (text) lastUserText = text;
            }
          }
        }

        // Fallback for assistant text from event response / finalAnswer
        if (!lastAssistantText) {
          lastAssistantText = extractFallbackText(event?.finalAnswer || event?.response || event?.output);
        }

        if (!lastUserText || !lastAssistantText) {
          return;
        }

        const signature = `${lastUserText}:::${lastAssistantText}`;
        if (syncedTurnSignatures.has(signature)) {
          return; // Already synced
        }
        syncedTurnSignatures.add(signature);

        api.logger.info(
          `[openclaw-memory-tencentdb] [agent_end] Syncing turn to TencentDB (user: "${lastUserText.slice(0, 30)}...", assistant: "${lastAssistantText.slice(0, 30)}...")`,
        );

        try {
          await client.importTurn(`openclaw-${sKey}`, [
            { role: "user", content: lastUserText },
            { role: "assistant", content: lastAssistantText },
          ]);
          api.logger.info(`[openclaw-memory-tencentdb] [agent_end] Successfully synced turn to TencentDB L0!`);
        } catch (err: any) {
          api.logger.warn(`[openclaw-memory-tencentdb] [agent_end] Sync failed: ${err.message || String(err)}`);
        }
      });
    }

    // ── 3. Tools ────────────────────────────────────────────────────────

    // Tool 1: Conversation Search
    api.registerTool({
      name: "tdai_conversation_search",
      description: "Durchsucht die Konversationshistorie und das Gesprächsgedächtnis des Agenten in TencentDB nach Begriffen oder Themen.",
      parameters: Type.Object({
        query: Type.String({ description: "Suchbegriff oder Frage" }),
        limit: Type.Optional(Type.Integer({ description: "Maximale Anzahl Ergebnisse (Standard: 5)", default: 5 })),
      }),
      execute: async (rawArgs: any) => {
        try {
          const { query, limit } = parseToolQueryAndLimit(rawArgs, 5);
          if (!query) {
            return "Bitte gib einen Suchbegriff (query) an.";
          }
          const res = await client.searchConversation(query, limit);
          const msgs = res?.data?.messages || [];
          if (!Array.isArray(msgs) || msgs.length === 0) {
            return `Keine Konversationen zu '${query}' gefunden.`;
          }
          return JSON.stringify(msgs, null, 2);
        } catch (err: any) {
          return `Fehler bei Konversationssuche: ${err.message || String(err)}`;
        }
      },
    });

    // Tool 2: Skill Search
    api.registerTool({
      name: "tdai_skill_search",
      description: "Durchsucht im TencentDB Memory Hub hinterlegte Skills, Workflows und Best Practices.",
      parameters: Type.Object({
        query: Type.String({ description: "Suchbegriff oder Name des Skills" }),
        limit: Type.Optional(Type.Integer({ description: "Maximale Anzahl Ergebnisse (Standard: 5)", default: 5 })),
      }),
      execute: async (rawArgs: any) => {
        try {
          const { query, limit } = parseToolQueryAndLimit(rawArgs, 5);
          if (!query) {
            return "Bitte gib einen Suchbegriff (query) an.";
          }
          const res = await client.searchSkills(query, limit);
          const items = res?.data?.items || [];
          if (!Array.isArray(items) || items.length === 0) {
            return `Keine Skills zu '${query}' gefunden.`;
          }
          return JSON.stringify(items, null, 2);
        } catch (err: any) {
          return `Fehler bei Skill-Suche: ${err.message || String(err)}`;
        }
      },
    });

    // Tool 3: Team Wiki Search
    api.registerTool({
      name: "tdai_wiki_search",
      description: "Durchsucht das Team-Wiki und Knowledge-Dokumente im TencentDB Memory Hub auf Port 8424.",
      parameters: Type.Object({
        query: Type.String({ description: "Suchbegriff" }),
        wiki_id: Type.Optional(Type.String({ description: "Optionale Wiki-ID" })),
        limit: Type.Optional(Type.Integer({ description: "Maximale Anzahl (Standard: 5)", default: 5 })),
      }),
      execute: async (rawArgs: any) => {
        try {
          const { query, limit, wikiId } = parseToolQueryAndLimit(rawArgs, 5);
          if (!query) {
            return "Bitte gib einen Suchbegriff (query) an.";
          }
          const res = await client.searchWiki(query, limit, wikiId);
          return JSON.stringify(res?.data || res, null, 2);
        } catch (err: any) {
          return `Fehler bei Wiki-Suche: ${err.message || String(err)}`;
        }
      },
    });

    // Tool 4: CodeGraph Search
    api.registerTool({
      name: "tdai_codegraph_search",
      description: "Durchsucht den Code-Graph nach Symbolen, Funktionen und Abhängigkeiten (Impact Analysis).",
      parameters: Type.Object({
        query: Type.String({ description: "Funktions- oder Symbolname" }),
        limit: Type.Optional(Type.Integer({ description: "Maximale Anzahl (Standard: 5)", default: 5 })),
      }),
      execute: async (rawArgs: any) => {
        try {
          const { query, limit } = parseToolQueryAndLimit(rawArgs, 5);
          if (!query) {
            return "Bitte gib einen Symbolnamen oder Suchbegriff (query) an.";
          }
          const res = await client.searchCodeGraph(query, limit);
          return JSON.stringify(res?.data || res, null, 2);
        } catch (err: any) {
          return `Fehler bei CodeGraph-Suche: ${err.message || String(err)}`;
        }
      },
    });

    // ── 4. Register Long-Running Service ────────────────────────────────
    api.registerService({
      id: "openclaw-memory-tencentdb",
      start: () => {
        api.logger.info(
          `[openclaw-memory-tencentdb] Service active (team: ${client.getTeamId()}, agent: ${client.getAgentId()})`,
        );
      },
      stop: () => {
        api.logger.info("[openclaw-memory-tencentdb] Service stopped");
      },
    });
  },
};

export default memoryPlugin;
