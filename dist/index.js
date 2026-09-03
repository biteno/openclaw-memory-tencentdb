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
function extractMessageText(msg, ctx) {
    if (!msg && !ctx)
        return "";
    if (typeof msg === "string")
        return msg.replace(/<tencentdb-memory>[\s\S]*?<\/tencentdb-memory>/g, "").trim();
    // If msg is an object, check all potential prompt/content fields
    const candidates = [
        msg?.prompt,
        msg?.input,
        msg?.userMessage,
        msg?.message,
        msg?.content,
        msg?.text,
        msg?.query,
        ctx?.prompt,
        ctx?.input,
        ctx?.userMessage,
        ctx?.message,
        ctx?.content,
    ];
    for (const cand of candidates) {
        if (typeof cand === "string" && cand.trim().length > 0) {
            return cand.replace(/<tencentdb-memory>[\s\S]*?<\/tencentdb-memory>/g, "").trim();
        }
    }
    // Check array of messages in event or ctx
    const msgArray = Array.isArray(msg?.messages)
        ? msg.messages
        : Array.isArray(ctx?.messages)
            ? ctx.messages
            : Array.isArray(msg)
                ? msg
                : [];
    if (msgArray.length > 0) {
        for (let i = msgArray.length - 1; i >= 0; i--) {
            const item = msgArray[i];
            const role = String(item?.role || "").toLowerCase();
            if (role === "user" || role === "human" || !item?.role) {
                const text = extractMessageText(item);
                if (text)
                    return text;
            }
        }
    }
    const rawContent = msg?.content !== undefined ? msg.content : msg?.text !== undefined ? msg.text : msg?.parts;
    const textParts = [];
    const thoughtParts = [];
    if (typeof rawContent === "string") {
        textParts.push(rawContent);
    }
    else if (Array.isArray(rawContent)) {
        for (const block of rawContent) {
            if (typeof block === "string") {
                textParts.push(block);
            }
            else if (block && typeof block === "object") {
                const bType = String(block.type || "").toLowerCase();
                const bText = typeof block.text === "string" ? block.text : typeof block.content === "string" ? block.content : "";
                if (bText) {
                    if (bType === "thought" || bType === "thinking") {
                        thoughtParts.push(bText);
                    }
                    else {
                        textParts.push(bText);
                    }
                }
            }
        }
    }
    const resultText = textParts.length > 0 ? textParts.join("\n") : thoughtParts.join("\n");
    return resultText.replace(/<tencentdb-memory>[\s\S]*?<\/tencentdb-memory>/g, "").trim();
}
function extractFallbackText(val) {
    if (!val)
        return "";
    if (typeof val === "string")
        return val.replace(/<tencentdb-memory>[\s\S]*?<\/tencentdb-memory>/g, "").trim();
    if (typeof val.finalAnswer === "string")
        return extractFallbackText(val.finalAnswer);
    if (typeof val.response === "string")
        return extractFallbackText(val.response);
    if (typeof val.output === "string")
        return extractFallbackText(val.output);
    if (Array.isArray(val)) {
        return val.map((item) => extractFallbackText(item)).filter(Boolean).join("\n").trim();
    }
    return "";
}
function parseToolQueryAndLimit(args, defaultLimit = 5) {
    let parsed = args;
    if (typeof args === "string") {
        try {
            parsed = JSON.parse(args);
        }
        catch {
            return { query: args.trim(), limit: defaultLimit };
        }
    }
    if (!parsed || typeof parsed !== "object") {
        return { query: "", limit: defaultLimit };
    }
    const queryCandidate = parsed.query ||
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
    kind: "memory",
    register(api) {
        const pluginConfig = resolvePluginConfig(api);
        const autoRecall = pluginConfig.autoRecall !== false;
        const autoCapture = pluginConfig.autoCapture !== false;
        const scoreThreshold = pluginConfig.scoreThreshold ?? 0.5;
        const maxRecallResults = pluginConfig.maxRecallResults ?? 3;
        const client = new TencentDBClient(pluginConfig);
        api.logger.info(`[openclaw-memory-tencentdb] Plugin registered (core: ${pluginConfig.coreUrl || "default"}, import: ${pluginConfig.importUrl || "default"}, team: ${client.getTeamId()}, agent: ${client.getAgentId()}, userKey configured: ${Boolean(pluginConfig.userKey)})`);
        const syncedTurnSignatures = new Set();
        // ── 1. Auto-Recall Hook (before_agent_start) ───────────────────────
        if (autoRecall) {
            api.on("before_agent_start", async (event, ctx) => {
                const prompt = extractMessageText(event, ctx);
                api.logger.info(`[openclaw-memory-tencentdb] [Hook:before_agent_start] Fired (prompt: "${prompt.slice(0, 50)}...", team: ${client.getTeamId()}, agent: ${client.getAgentId()})`);
                if (!prompt || prompt.length < 3) {
                    api.logger.info(`[openclaw-memory-tencentdb] [Hook:before_agent_start] Prompt too short or empty, skipping.`);
                    return;
                }
                // Skip trivial messages
                if (/^(hi|hello|hey|ok|danke|thx|thanks|hallo|ja|nein|yes|no)$/i.test(prompt)) {
                    return;
                }
                try {
                    const recalledSections = [];
                    // 1. Search conversation history & distilled facts (L0-L3)
                    try {
                        api.logger.info(`[openclaw-memory-tencentdb] [Hook:before_agent_start] Querying conversation memory for "${prompt.slice(0, 40)}..."`);
                        const convRes = await client.searchConversation(prompt, maxRecallResults);
                        const messages = convRes?.data?.messages || [];
                        const validMessages = Array.isArray(messages) ? messages.filter((m) => m && m.content) : [];
                        api.logger.info(`[openclaw-memory-tencentdb] [Hook:before_agent_start] Conversation search returned ${validMessages.length} items.`);
                        if (validMessages.length > 0) {
                            const lines = validMessages.map((m) => {
                                const clean = String(m.content || "").trim();
                                const snippet = clean.length > 400 ? `${clean.slice(0, 397)}...` : clean;
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
                    }
                    catch (err) {
                        api.logger.warn(`[openclaw-memory-tencentdb] Skill search failed: ${err.message || String(err)}`);
                    }
                    if (recalledSections.length === 0) {
                        api.logger.info(`[openclaw-memory-tencentdb] [Hook:before_agent_start] No memories found for prompt.`);
                        return;
                    }
                    const contextBlock = `<tencentdb-memory>\n${recalledSections.join("\n\n")}\n</tencentdb-memory>`;
                    api.logger.info(`[openclaw-memory-tencentdb] [Hook:before_agent_start] Successfully injected ${recalledSections.length} memory sections into context (${contextBlock.length} chars)`);
                    return {
                        prependContext: contextBlock,
                    };
                }
                catch (err) {
                    api.logger.warn(`[openclaw-memory-tencentdb] Recall error: ${err.message || String(err)}`);
                }
            });
        }
        // ── 2. Auto-Capture Hook (agent_end) ───────────────────────────────
        if (autoCapture) {
            api.on("agent_end", async (event, ctx) => {
                const sKey = ctx?.sessionKey || event?.sessionKey || "main";
                const messages = Array.isArray(event?.messages) ? event.messages : [];
                let lastUserText = "";
                let lastAssistantText = "";
                // Iterate through messages in reverse to find the latest completed turn
                for (let i = messages.length - 1; i >= 0; i--) {
                    const msg = messages[i];
                    if (!msg || typeof msg !== "object")
                        continue;
                    const role = String(msg.role || "").toLowerCase();
                    const text = extractMessageText(msg);
                    if (!lastAssistantText && (role === "assistant" || role === "model" || role === "bot") && text) {
                        lastAssistantText = text;
                    }
                    else if (lastAssistantText && !lastUserText && (role === "user" || role === "human") && text) {
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
                            if (text)
                                lastUserText = text;
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
                api.logger.info(`[openclaw-memory-tencentdb] [agent_end] Syncing turn to TencentDB (user: "${lastUserText.slice(0, 30)}...", assistant: "${lastAssistantText.slice(0, 30)}...")`);
                try {
                    await client.importTurn(`openclaw-${sKey}`, [
                        { role: "user", content: lastUserText },
                        { role: "assistant", content: lastAssistantText },
                    ]);
                    api.logger.info(`[openclaw-memory-tencentdb] [agent_end] Successfully synced turn to TencentDB L0!`);
                }
                catch (err) {
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
            execute: async (rawArgs) => {
                try {
                    const { query, limit } = parseToolQueryAndLimit(rawArgs, 5);
                    api.logger.info(`[openclaw-memory-tencentdb] [Tool:tdai_conversation_search] Executing query: "${query}" (limit: ${limit})`);
                    if (!query) {
                        return "Bitte gib einen Suchbegriff (query) an.";
                    }
                    const res = await client.searchConversation(query, limit);
                    const msgs = res?.data?.messages || [];
                    api.logger.info(`[openclaw-memory-tencentdb] [Tool:tdai_conversation_search] Query "${query}" returned ${Array.isArray(msgs) ? msgs.length : 0} hits.`);
                    if (!Array.isArray(msgs) || msgs.length === 0) {
                        return `Keine Konversationen zu '${query}' gefunden.`;
                    }
                    return JSON.stringify(msgs, null, 2);
                }
                catch (err) {
                    api.logger.warn(`[openclaw-memory-tencentdb] Tool execution error: ${err.message || String(err)}`);
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
            execute: async (rawArgs) => {
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
            execute: async (rawArgs) => {
                try {
                    const { query, limit, wikiId } = parseToolQueryAndLimit(rawArgs, 5);
                    if (!query) {
                        return "Bitte gib einen Suchbegriff (query) an.";
                    }
                    const res = await client.searchWiki(query, limit, wikiId);
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
            execute: async (rawArgs) => {
                try {
                    const { query, limit } = parseToolQueryAndLimit(rawArgs, 5);
                    if (!query) {
                        return "Bitte gib einen Symbolnamen oder Suchbegriff (query) an.";
                    }
                    const res = await client.searchCodeGraph(query, limit);
                    return JSON.stringify(res?.data || res, null, 2);
                }
                catch (err) {
                    return `Fehler bei CodeGraph-Suche: ${err.message || String(err)}`;
                }
            },
        });
        // ── 4. Register Long-Running Service ────────────────────────────────
        api.registerService({
            id: "openclaw-memory-tencentdb",
            start: () => {
                api.logger.info(`[openclaw-memory-tencentdb] Service active (team: ${client.getTeamId()}, agent: ${client.getAgentId()})`);
            },
            stop: () => {
                api.logger.info("[openclaw-memory-tencentdb] Service stopped");
            },
        });
    },
};
export default memoryPlugin;
//# sourceMappingURL=index.js.map