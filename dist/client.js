/**
 * TencentDB HTTP Client for OpenClaw
 * Uses native node:http / node:https with IPv4 affinity to prevent
 * undici / fetch IPv6 .local resolution issues on Linux hosts.
 */
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
function postJson(urlStr, headers, bodyObj, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        try {
            const parsed = new URL(urlStr);
            const postData = JSON.stringify(bodyObj);
            const isHttps = parsed.protocol === "https:";
            const lib = isHttps ? https : http;
            const req = lib.request(parsed, {
                method: "POST",
                headers: {
                    ...headers,
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(postData),
                },
                timeout: timeoutMs,
                family: 4, // Force IPv4 to prevent Node.js .local / mDNS dual-stack bugs
            }, (res) => {
                let raw = "";
                res.on("data", (chunk) => {
                    raw += chunk;
                });
                res.on("end", () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(raw));
                        }
                        catch {
                            resolve(raw);
                        }
                    }
                    else {
                        reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
                    }
                });
            });
            req.on("error", (err) => {
                reject(new Error(`Connection to ${urlStr} failed: ${err.message}`));
            });
            req.on("timeout", () => {
                req.destroy(new Error(`Timeout after ${timeoutMs}ms connecting to ${urlStr}`));
            });
            req.write(postData);
            req.end();
        }
        catch (err) {
            reject(new Error(`Request setup error for ${urlStr}: ${err.message || String(err)}`));
        }
    });
}
export class TencentDBClient {
    coreUrl;
    importUrl;
    knowledgeUrl;
    userKey;
    teamId;
    agentId;
    constructor(config) {
        this.coreUrl = (config.coreUrl || "http://localhost:8420").replace(/\/+$/, "");
        this.importUrl = (config.importUrl || "http://localhost:8125").replace(/\/+$/, "");
        this.knowledgeUrl = (config.knowledgeUrl || "http://localhost:8424").replace(/\/+$/, "");
        this.userKey = config.userKey || process.env.TDAI_USER_KEY || "";
        this.teamId = config.teamId || process.env.TDAI_TEAM_ID || "default";
        this.agentId = config.agentId || process.env.TDAI_AGENT_ID || "default";
    }
    getAgentId() {
        return this.agentId;
    }
    getTeamId() {
        return this.teamId;
    }
    isConfigured() {
        return Boolean(this.userKey && this.coreUrl);
    }
    /**
     * Search past conversation memories & distilled facts (L0-L3)
     * Queries both L0 (raw messages, full markdown tables) and L1 (distilled facts)
     * on the Panel dedicated agent block (/api/v1/chat-memory/search on port 8125)
     * as well as the Core conversational vector index (/v2/conversation/search on port 8420),
     * merging the results so no memories are missed regardless of team partitioning.
     */
    async searchConversation(query, limit = 5, customAgentId) {
        const qStr = typeof query === "string" ? query : String(query || "");
        const safeLimit = typeof limit === "number" ? limit : 5;
        const targetAgentId = customAgentId || this.agentId;
        const messages = [];
        const seenContents = new Set();
        const panelUrl = `${this.importUrl}/api/v1/chat-memory/search`;
        const panelHeaders = {
            "X-Tdai-User-Key": this.userKey,
            "X-Tdai-Service-Id": "default",
        };
        // 1. Search Panel L0 Raw Messages (Detailed Markdown, Tables, Transcripts)
        try {
            const l0Payload = {
                block_id: `chat_memory-${this.teamId}-${targetAgentId}`,
                query: qStr.slice(0, 500),
                layer: "L0",
                limit: safeLimit,
            };
            const l0Res = await postJson(panelUrl, panelHeaders, l0Payload, 6000);
            const l0Items = l0Res?.data?.items || [];
            if (Array.isArray(l0Items)) {
                for (const it of l0Items) {
                    const body = (it?.body || it?.content || "").trim();
                    if (body && !seenContents.has(body)) {
                        seenContents.add(body);
                        messages.push({
                            id: it?.id || `l0-${Math.random().toString(36).slice(2, 9)}`,
                            role: it?.title || it?.role || "assistant",
                            content: body,
                            score: typeof it?.score === "number" ? it.score : 1.0,
                            timestamp: it?.created_at,
                        });
                    }
                }
            }
        }
        catch {
            // Ignore L0 search error
        }
        // 2. Search Panel L1 Distilled Facts (Episodic, Persona, Principles)
        try {
            const l1Payload = {
                block_id: `chat_memory-${this.teamId}-${targetAgentId}`,
                query: qStr.slice(0, 500),
                layer: "L1",
                limit: safeLimit,
            };
            const l1Res = await postJson(panelUrl, panelHeaders, l1Payload, 6000);
            const l1Items = l1Res?.data?.items || [];
            if (Array.isArray(l1Items)) {
                for (const it of l1Items) {
                    const body = (it?.body || it?.content || "").trim();
                    if (body && !seenContents.has(body)) {
                        seenContents.add(body);
                        messages.push({
                            id: it?.id || `l1-${Math.random().toString(36).slice(2, 9)}`,
                            role: it?.title || "memory",
                            content: body,
                            score: typeof it?.score === "number" ? it.score : 1.0,
                            timestamp: it?.created_at,
                        });
                    }
                }
            }
        }
        catch {
            // Ignore L1 search error
        }
        // 3. Search Core (:8420/v2/conversation/search)
        try {
            const coreUrl = `${this.coreUrl}/v2/conversation/search`;
            const coreHeaders = {
                Authorization: `Bearer ${this.userKey}`,
                "x-tdai-service-id": this.teamId,
                "x-agent-id": targetAgentId,
            };
            const corePayload = {
                query: qStr.slice(0, 500),
                limit: safeLimit,
            };
            const coreRes = await postJson(coreUrl, coreHeaders, corePayload, 5000);
            const coreMsgs = coreRes?.data?.messages || [];
            if (Array.isArray(coreMsgs)) {
                for (const m of coreMsgs) {
                    const clean = (m?.content || "").trim();
                    if (clean && !seenContents.has(clean)) {
                        seenContents.add(clean);
                        messages.push({
                            id: m?.id || `core-${Math.random().toString(36).slice(2, 9)}`,
                            role: m?.role || "user",
                            content: clean,
                            score: typeof m?.score === "number" ? m.score : 1.0,
                            timestamp: m?.timestamp,
                        });
                    }
                }
            }
        }
        catch {
            // Core search fallback
        }
        return {
            code: 0,
            message: "ok",
            data: {
                messages: messages.slice(0, safeLimit),
            },
        };
    }
    /**
     * Search skills and distilled knowledge via Core API
     */
    async searchSkills(query, limit = 3, customAgentId) {
        const url = `${this.coreUrl}/v3/skill/search`;
        const headers = {
            Authorization: `Bearer ${this.userKey}`,
            "x-tdai-service-id": this.teamId,
            "x-agent-id": customAgentId || this.agentId,
        };
        const qStr = typeof query === "string" ? query : String(query || "");
        const payload = {
            query: qStr.slice(0, 500),
            limit: typeof limit === "number" ? limit : 3,
        };
        return postJson(url, headers, payload, 4000);
    }
    /**
     * Import completed dialogue turn into Panel API (L0 Raw Turn Ingest)
     * Note: Panel Import requires X-Tdai-Service-Id: default in the header,
     * while the actual teamId is passed in the JSON body.
     */
    async importTurn(sessionId, messages, customAgentId) {
        const url = `${this.importUrl}/api/v1/chat-memory/import`;
        const headers = {
            "X-Tdai-User-Key": this.userKey,
            "X-Tdai-Service-Id": "default",
        };
        const sanitizedMessages = (Array.isArray(messages) ? messages : []).map((m) => ({
            role: m?.role || "user",
            content: (m?.content || "").length > 8000 ? (m?.content || "").slice(0, 7990) + "..." : (m?.content || ""),
        }));
        const sId = typeof sessionId === "string" ? sessionId : String(sessionId || "default");
        const payload = {
            team_id: this.teamId,
            agent_id: customAgentId || this.agentId,
            session_id: sId.startsWith("openclaw-") ? sId : `openclaw-${sId}`,
            messages: sanitizedMessages,
        };
        return postJson(url, headers, payload, 15000);
    }
    /**
     * Search Team Wiki documents on port 8424
     */
    async searchWiki(query, limit = 5, wikiId) {
        const url = `${this.knowledgeUrl}/v3/wiki/search`;
        const headers = {
            Authorization: `Bearer ${this.userKey}`,
            "x-tdai-service-id": this.teamId,
        };
        const qStr = typeof query === "string" ? query : String(query || "");
        const payload = {
            team_id: this.teamId,
            query: qStr.slice(0, 500),
            limit: typeof limit === "number" ? limit : 5,
        };
        if (wikiId) {
            payload.wiki_id = wikiId;
        }
        return postJson(url, headers, payload, 4000);
    }
    /**
     * Search CodeGraph symbols and impact dependencies on port 8424
     */
    async searchCodeGraph(query, limit = 5) {
        const url = `${this.knowledgeUrl}/v3/code-graph/search`;
        const headers = {
            Authorization: `Bearer ${this.userKey}`,
            "x-tdai-service-id": this.teamId,
        };
        const qStr = typeof query === "string" ? query : String(query || "");
        const payload = {
            team_id: this.teamId,
            query: qStr.slice(0, 500),
            limit: typeof limit === "number" ? limit : 5,
        };
        return postJson(url, headers, payload, 4000);
    }
}
//# sourceMappingURL=client.js.map