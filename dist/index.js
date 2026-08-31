/**
 * OpenClaw Remote TencentDB Agent Memory Plugin
 *
 * Combines prefetch recall before agent turns with an autonomous
 * session file watcher that syncs all conversation files to TencentDB.
 */
import { Type } from "@sinclair/typebox";
import { TencentDBClient } from "./client.js";
import { OpenClawSessionWatcher } from "./watcher.js";
function resolvePluginConfig(api) {
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
        if (cand &&
            typeof cand === "object" &&
            (cand.coreUrl || cand.userKey || cand.teamId || cand.importUrl || cand.agentId)) {
            return cand;
        }
    }
    return api.pluginConfig || api.config || {};
}
function extractText(val) {
    if (!val)
        return "";
    if (typeof val === "string")
        return val.trim();
    if (typeof val.text === "string")
        return val.text.trim();
    if (typeof val.content === "string")
        return val.content.trim();
    if (typeof val.message === "string")
        return val.message.trim();
    if (typeof val.finalAnswer === "string")
        return val.finalAnswer.trim();
    if (typeof val.response === "string")
        return val.response.trim();
    if (typeof val.output === "string")
        return val.output.trim();
    if (Array.isArray(val)) {
        return val
            .map((item) => extractText(item))
            .filter(Boolean)
            .join("\n")
            .trim();
    }
    return "";
}
const memoryPlugin = {
    id: "openclaw-memory-tencentdb",
    name: "TencentDB Agent Memory (Remote)",
    description: "Remote TencentDB Agent Memory plugin for OpenClaw — connects to central TencentDB cluster for bidirectional turn sync and prefetch recall.",
    kind: "memory",
    register(api) {
        const pluginConfig = resolvePluginConfig(api);
        const autoRecall = pluginConfig.autoRecall !== false;
        const autoCapture = pluginConfig.autoCapture !== false;
        const scoreThreshold = pluginConfig.scoreThreshold ?? 0.5;
        const maxRecallResults = pluginConfig.maxRecallResults ?? 3;
        const client = new TencentDBClient(pluginConfig);
        api.logger.info(`[openclaw-memory-tencentdb] Plugin registered (core: ${pluginConfig.coreUrl || "default"}, import: ${pluginConfig.importUrl || "default"}, team: ${client.getTeamId()}, agent: ${client.getAgentId()}, userKey configured: ${Boolean(pluginConfig.userKey)})`);
        // Start background session file watcher immediately
        const watcher = new OpenClawSessionWatcher(client, api.logger);
        watcher.start(3000);
        // ── 1. Auto-Recall Hook ────────────────────────────────────────────
        if (autoRecall) {
            const handleRecall = async (event, ctx) => {
                const prompt = extractText(event?.prompt || event?.content || event?.message || event?.text);
                if (!prompt)
                    return;
                const cleanPrompt = prompt.replace(/<tencentdb-memory>[\s\S]*?<\/tencentdb-memory>/g, "").trim();
                if (cleanPrompt.length < 4)
                    return;
                // Skip trivial messages
                if (/^(hi|hello|hey|ok|danke|thx|thanks|hallo|ja|nein|yes|no)$/i.test(cleanPrompt)) {
                    return;
                }
                try {
                    const recalledSections = [];
                    // 1. Search conversation history (L0/L1)
                    try {
                        const convRes = await client.searchConversation(cleanPrompt, maxRecallResults);
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
                    }
                    catch (err) {
                        api.logger.warn(`[openclaw-memory-tencentdb] Conversation search failed: ${err.message || String(err)}`);
                    }
                    // 2. Search skills / distilled knowledge
                    try {
                        const skillRes = await client.searchSkills(cleanPrompt, 2);
                        const items = skillRes?.data?.items || [];
                        if (items.length > 0) {
                            const lines = items.map((item) => {
                                const snippet = (item.snippet || "").replace(/<[^>]+>/g, "").trim();
                                return `- **${item.name}**: ${item.description || ""} (${snippet.slice(0, 200)})`;
                            });
                            recalledSections.push(`### Hinterlegte Skills & Dokumente (TencentDB):\n${lines.join("\n")}`);
                        }
                    }
                    catch (err) {
                        api.logger.warn(`[openclaw-memory-tencentdb] Skill search failed: ${err.message || String(err)}`);
                    }
                    if (recalledSections.length === 0) {
                        return;
                    }
                    const contextBlock = `<tencentdb-memory>\n${recalledSections.join("\n\n")}\n</tencentdb-memory>`;
                    api.logger.info(`[openclaw-memory-tencentdb] Prefetched ${recalledSections.length} memory sections into context`);
                    return {
                        prependContext: contextBlock,
                    };
                }
                catch (err) {
                    api.logger.warn(`[openclaw-memory-tencentdb] Recall error: ${err.message || String(err)}`);
                }
            };
            api.on("before_agent_start", handleRecall);
            api.on("before_turn", handleRecall);
            api.on("before_agent_run", handleRecall);
        }
        // ── 2. Tools ────────────────────────────────────────────────────────
        // Tool 1: Conversation Search
        api.registerTool({
            name: "tdai_conversation_search",
            description: "Durchsucht die Konversationshistorie und das Gesprächsgedächtnis des Agenten in TencentDB nach Begriffen oder Themen.",
            parameters: Type.Object({
                query: Type.String({ description: "Suchbegriff oder Frage" }),
                limit: Type.Optional(Type.Integer({ description: "Maximale Anzahl Ergebnisse (Standard: 5)", default: 5 })),
            }),
            execute: async (args) => {
                try {
                    const res = await client.searchConversation(args.query, args.limit || 5);
                    const msgs = res?.data?.messages || [];
                    if (msgs.length === 0) {
                        return `Keine Konversationen zu '${args.query}' gefunden.`;
                    }
                    return JSON.stringify(msgs, null, 2);
                }
                catch (err) {
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
            execute: async (args) => {
                try {
                    const res = await client.searchSkills(args.query, args.limit || 5);
                    const items = res?.data?.items || [];
                    if (items.length === 0) {
                        return `Keine Skills zu '${args.query}' gefunden.`;
                    }
                    return JSON.stringify(items, null, 2);
                }
                catch (err) {
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
            execute: async (args) => {
                try {
                    const res = await client.searchWiki(args.query, args.limit || 5, args.wiki_id);
                    return JSON.stringify(res?.data || res, null, 2);
                }
                catch (err) {
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
            execute: async (args) => {
                try {
                    const res = await client.searchCodeGraph(args.query, args.limit || 5);
                    return JSON.stringify(res?.data || res, null, 2);
                }
                catch (err) {
                    return `Fehler bei CodeGraph-Suche: ${err.message || String(err)}`;
                }
            },
        });
        // ── 3. Register Long-Running Service ────────────────────────────────
        api.registerService({
            id: "openclaw-memory-tencentdb",
            start: () => {
                watcher.start(3000);
                api.logger.info(`[openclaw-memory-tencentdb] Service active (team: ${client.getTeamId()}, agent: ${client.getAgentId()})`);
            },
            stop: () => {
                watcher.stop();
                api.logger.info("[openclaw-memory-tencentdb] Service stopped");
            },
        });
    },
};
export default memoryPlugin;
//# sourceMappingURL=index.js.map