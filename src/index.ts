/**
 * OpenClaw Remote TencentDB Agent Memory Plugin
 *
 * Provides bidirectional recall prefetching and turn synchronization
 * against a central TencentDB Agent Memory cluster.
 */

import { Type } from "@sinclair/typebox";
import { TencentDBClient } from "./client.js";
import type { TencentDBConfig } from "./types.js";

// Type definition for OpenClaw Plugin API
interface OpenClawPluginApi {
  config?: Record<string, any>;
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
  registerCli?(cli: {
    command: string;
    description: string;
    action: (args: any) => Promise<void>;
  }): void;
}

function resolvePluginConfig(apiConfig: any): TencentDBConfig {
  if (!apiConfig || typeof apiConfig !== "object") return {};

  const candidates = [
    apiConfig?.plugins?.entries?.["openclaw-memory-tencentdb"]?.config,
    apiConfig?.plugins?.entries?.["openclaw-memory-tencentdb"],
    apiConfig?.plugins?.entries?.["memory-tencentdb"]?.config,
    apiConfig?.plugins?.entries?.["memory-tencentdb"],
    apiConfig?.entries?.["openclaw-memory-tencentdb"]?.config,
    apiConfig?.entries?.["openclaw-memory-tencentdb"],
    apiConfig?.["openclaw-memory-tencentdb"]?.config,
    apiConfig?.["openclaw-memory-tencentdb"],
    apiConfig?.["memory-tencentdb"]?.config,
    apiConfig?.["memory-tencentdb"],
    apiConfig?.config,
    apiConfig,
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

  return apiConfig;
}

function extractTurnMessages(event: any): { user: string; assistant: string } {
  let userText = "";
  let assistantText = "";

  // 1. Direct prompt / response properties
  if (typeof event?.prompt === "string" && event.prompt.trim()) {
    userText = event.prompt.trim();
  }
  if (typeof event?.response === "string" && event.response.trim()) {
    assistantText = event.response.trim();
  } else if (typeof event?.output === "string" && event.output.trim()) {
    assistantText = event.output.trim();
  } else if (typeof event?.text === "string" && event.text.trim()) {
    assistantText = event.text.trim();
  }

  // 2. Search message array
  const msgs = event?.messages || event?.history || event?.conversation || [];
  if (Array.isArray(msgs) && msgs.length > 0) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (!msg || typeof msg !== "object") continue;

      const role = String(msg.role || msg.sender || msg.type || "").toLowerCase();
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (typeof msg.text === "string") {
        text = msg.text;
      } else if (typeof msg.message === "string") {
        text = msg.message;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((c: any) => c && typeof c === "object" && typeof c.text === "string")
          .map((c: any) => c.text)
          .join("\n");
      }

      if ((role === "assistant" || role === "model" || role === "bot") && !assistantText && text.trim()) {
        assistantText = text.trim();
      } else if ((role === "user" || role === "human") && !userText && text.trim()) {
        userText = text.replace(/<tencentdb-memory>[\s\S]*?<\/tencentdb-memory>/g, "").trim();
      }

      if (userText && assistantText) break;
    }
  }

  return {
    user: userText.replace(/<tencentdb-memory>[\s\S]*?<\/tencentdb-memory>/g, "").trim(),
    assistant: assistantText.trim(),
  };
}

export default function register(api: OpenClawPluginApi) {
  const pluginConfig = resolvePluginConfig(api.config);

  const autoRecall = pluginConfig.autoRecall !== false;
  const autoCapture = pluginConfig.autoCapture !== false;
  const scoreThreshold = pluginConfig.scoreThreshold ?? 0.5;
  const maxRecallResults = pluginConfig.maxRecallResults ?? 3;

  const client = new TencentDBClient(pluginConfig);

  api.logger.info(
    `[openclaw-memory-tencentdb] Plugin initialized (core: ${pluginConfig.coreUrl || "default"}, import: ${pluginConfig.importUrl || "default"}, team: ${client.getTeamId()}, agent: ${client.getAgentId()}, userKey configured: ${Boolean(pluginConfig.userKey)})`,
  );

  // ── 1. Auto-Recall Hook ──────────────────────────────────────────────
  const handleRecall = async (event: any, ctx: any) => {
    if (!autoRecall) return;

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

    // Check if prompt is a trivial greeting/acknowledgment
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

  // ── 2. Auto-Capture Hook ──────────────────────────────────────────────
  let lastSyncedTurnSignature = "";

  const handleCapture = async (event: any, ctx: any) => {
    if (!autoCapture) return;

    const { user, assistant } = extractTurnMessages(event);
    if (!user || !assistant) {
      api.logger.debug?.(`[openclaw-memory-tencentdb] Capture skipped: incomplete turn (user: ${Boolean(user)}, assistant: ${Boolean(assistant)})`);
      return;
    }

    const signature = `${user}:::${assistant}`;
    if (signature === lastSyncedTurnSignature) {
      return; // Deduplicate
    }
    lastSyncedTurnSignature = signature;

    const sessionId = (ctx as any)?.sessionKey || (ctx as any)?.sessionId || event?.sessionId || "openclaw-session";

    api.logger.info(`[openclaw-memory-tencentdb] Syncing dialogue turn to TencentDB Panel for session: ${sessionId}...`);

    client
      .importTurn(sessionId, [
        { role: "user", content: user },
        { role: "assistant", content: assistant },
      ])
      .then((res) => {
        api.logger.info(`[openclaw-memory-tencentdb] Turn synced successfully to TencentDB (accepted count: 2, session: ${sessionId})`);
      })
      .catch((err) => {
        api.logger.warn(`[openclaw-memory-tencentdb] Background turn sync failed: ${String(err)}`);
      });
  };

  api.on("agent_end", handleCapture);
  api.on("after_turn", handleCapture);
  api.on("turn_end", handleCapture);

  // ── 3. Register Explicit Tools ────────────────────────────────────────

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
}
