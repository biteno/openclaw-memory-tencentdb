/**
 * OpenClaw Remote TencentDB Agent Memory Plugin
 *
 * Provides bidirectional recall prefetching and turn synchronization
 * against a central TencentDB Agent Memory cluster (e.g. tencentdb.itsc.local).
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
  registerCli?(cli: {
    command: string;
    description: string;
    action: (args: any) => Promise<void>;
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

    let currentSessionId: string | undefined;

    // ── 1. Auto-Recall Hook ────────────────────────────────────────────
    if (autoRecall) {
      const handleRecall = async (event: any, ctx: any) => {
        let prompt = "";
        if (typeof event?.prompt === "string") {
          prompt = event.prompt.trim();
        } else if (typeof event?.content === "string") {
          prompt = event.content.trim();
        } else if (typeof event?.message === "string") {
          prompt = event.message.trim();
        }

        if (!prompt || prompt.length < 4) {
          return;
        }

        const sessionId = (ctx as any)?.sessionKey || (ctx as any)?.sessionId || event?.sessionId;
        if (sessionId) currentSessionId = sessionId;

        // Skip trivial messages
        if (/^(hi|hello|hey|ok|danke|thx|thanks|hallo|ja|nein|yes|no)$/i.test(prompt)) {
          return;
        }

        try {
          const recalledSections: string[] = [];

          // 1. Search conversation history (L0/L1)
          try {
            const convRes = await client.searchConversation(prompt, maxRecallResults);
            const messages = convRes?.data?.messages || [];
            const validMessages = messages.filter((m) => (m.score ?? 1) >= scoreThreshold && m.content);

            if (validMessages.length > 0) {
              const lines = validMessages.map((m) => {
                const clean = m.content.trim();
                const snippet = clean.length > 300 ? `${clean.slice(0, 297)}...` : clean;
                return `- ${snippet}`;
              });
              recalledSections.push(`### Relevante Gesprächserinnerungen (TencentDB):\n${lines.join("\n")}`);
            }
          } catch (err) {
            api.logger.warn(`[openclaw-memory-tencentdb] Conversation search failed: ${String(err)}`);
          }

          // 2. Search skills / distilled knowledge
          try {
            const skillRes = await client.searchSkills(prompt, 2);
            const items = skillRes?.data?.items || [];
            if (items.length > 0) {
              const lines = items.map((item) => {
                const snippet = (item.snippet || "").replace(/<[^>]+>/g, "").trim();
                return `- **${item.name}**: ${item.description || ""} (${snippet.slice(0, 200)})`;
              });
              recalledSections.push(`### Hinterlegte Skills & Dokumente (TencentDB):\n${lines.join("\n")}`);
            }
          } catch (err) {
            api.logger.warn(`[openclaw-memory-tencentdb] Skill search failed: ${String(err)}`);
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
        } catch (err) {
          api.logger.warn(`[openclaw-memory-tencentdb] Recall error: ${String(err)}`);
        }
      };

      api.on("before_agent_start", handleRecall);
      api.on("before_turn", handleRecall);
    }

    // ── 2. Auto-Capture Hook ────────────────────────────────────────────
    if (autoCapture) {
      let lastSyncedSignature = "";

      const handleCapture = async (event: any, ctx: any) => {
        const rawMessages = event?.messages || event?.history || event?.conversation;
        const sessionId =
          (ctx as any)?.sessionKey ||
          (ctx as any)?.sessionId ||
          event?.sessionId ||
          currentSessionId ||
          "openclaw-session";

        const formattedMessages: Array<{ role: string; content: string }> = [];

        if (Array.isArray(rawMessages) && rawMessages.length > 0) {
          const recentMessages = rawMessages.slice(-10);
          for (const msg of recentMessages) {
            if (!msg || typeof msg !== "object") continue;

            const role = String(msg.role || msg.sender || msg.type || "").toLowerCase();
            if (role !== "user" && role !== "assistant" && role !== "model" && role !== "human") {
              continue;
            }

            const standardRole = (role === "model" || role === "assistant") ? "assistant" : "user";
            let textContent = "";

            if (typeof msg.content === "string") {
              textContent = msg.content;
            } else if (typeof msg.text === "string") {
              textContent = msg.text;
            } else if (typeof msg.message === "string") {
              textContent = msg.message;
            } else if (Array.isArray(msg.content)) {
              textContent = msg.content
                .filter((c: any) => c && typeof c === "object" && typeof c.text === "string")
                .map((c: any) => c.text)
                .join("\n");
            }

            if (!textContent) continue;

            // Strip injected memory context
            if (textContent.includes("<tencentdb-memory>")) {
              textContent = textContent.replace(/<tencentdb-memory>[\s\S]*?<\/tencentdb-memory>/g, "").trim();
              if (!textContent) continue;
            }

            formattedMessages.push({
              role: standardRole,
              content: textContent.trim(),
            });
          }
        }

        // Fallback to direct event.prompt / event.response
        if (formattedMessages.length === 0) {
          const userPrompt = typeof event?.prompt === "string" ? event.prompt.trim() : "";
          const assistantResp =
            typeof event?.response === "string"
              ? event.response.trim()
              : typeof event?.output === "string"
                ? event.output.trim()
                : typeof event?.text === "string"
                  ? event.text.trim()
                  : "";

          if (userPrompt) {
            formattedMessages.push({
              role: "user",
              content: userPrompt.replace(/<tencentdb-memory>[\s\S]*?<\/tencentdb-memory>/g, "").trim(),
            });
          }
          if (assistantResp) {
            formattedMessages.push({ role: "assistant", content: assistantResp });
          }
        }

        if (formattedMessages.length === 0) {
          return;
        }

        // Ensure we have at least one user and one assistant message
        const hasUser = formattedMessages.some((m) => m.role === "user");
        const hasAssistant = formattedMessages.some((m) => m.role === "assistant");
        if (!hasUser || !hasAssistant) {
          return;
        }

        const signature = formattedMessages.map((m) => `${m.role}:${m.content}`).join(":::");
        if (signature === lastSyncedSignature) {
          return; // Deduplicate
        }
        lastSyncedSignature = signature;

        api.logger.info(
          `[openclaw-memory-tencentdb] Syncing ${formattedMessages.length} message(s) to TencentDB for session: ${sessionId}...`,
        );

        // Send to TencentDB Panel import API
        client
          .importTurn(sessionId, formattedMessages)
          .then((res) => {
            api.logger.info(
              `[openclaw-memory-tencentdb] Successfully synced ${formattedMessages.length} turn(s) to TencentDB (session: ${sessionId})`,
            );
          })
          .catch((err) => {
            api.logger.warn(`[openclaw-memory-tencentdb] Background turn sync failed: ${String(err)}`);
          });
      };

      api.on("agent_end", handleCapture);
      api.on("after_turn", handleCapture);
      api.on("turn_end", handleCapture);
    }

    // ── 3. Register Explicit Tools ──────────────────────────────────────

    // Tool 1: Conversation Search
    api.registerTool({
      name: "tdai_conversation_search",
      description: "Durchsucht die Konversationshistorie und das Gesprächsgedächtnis des Agenten in TencentDB nach Begriffen oder Themen.",
      parameters: Type.Object({
        query: Type.String({ description: "Suchbegriff oder Frage" }),
        limit: Type.Optional(Type.Integer({ description: "Maximale Anzahl Ergebnisse (Standard: 5)", default: 5 })),
      }),
      execute: async (args: { query: string; limit?: number }) => {
        try {
          const res = await client.searchConversation(args.query, args.limit || 5);
          const msgs = res?.data?.messages || [];
          if (msgs.length === 0) {
            return `Keine Konversationen zu '${args.query}' gefunden.`;
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
      execute: async (args: { query: string; limit?: number }) => {
        try {
          const res = await client.searchSkills(args.query, args.limit || 5);
          const items = res?.data?.items || [];
          if (items.length === 0) {
            return `Keine Skills zu '${args.query}' gefunden.`;
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
      execute: async (args: { query: string; wiki_id?: string; limit?: number }) => {
        try {
          const res = await client.searchWiki(args.query, args.limit || 5, args.wiki_id);
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
      execute: async (args: { query: string; limit?: number }) => {
        try {
          const res = await client.searchCodeGraph(args.query, args.limit || 5);
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
