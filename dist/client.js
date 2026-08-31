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
     * Search past conversation memories (L0/L1) via Core API
     */
    async searchConversation(query, limit = 5, customAgentId) {
        const url = `${this.coreUrl}/v2/conversation/search`;
        const headers = {
            Authorization: `Bearer ${this.userKey}`,
            "x-tdai-service-id": this.teamId,
            "x-agent-id": customAgentId || this.agentId,
        };
        const payload = {
            query: query.slice(0, 500),
            limit,
        };
        return postJson(url, headers, payload, 4000);
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
        const payload = {
            query: query.slice(0, 500),
            limit,
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
        const payload = {
            team_id: this.teamId,
            agent_id: customAgentId || this.agentId,
            session_id: sessionId.startsWith("openclaw-") ? sessionId : `openclaw-${sessionId}`,
            messages,
        };
        return postJson(url, headers, payload, 6000);
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
        const payload = {
            team_id: this.teamId,
            query,
            limit,
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
        const payload = {
            team_id: this.teamId,
            query,
            limit,
        };
        return postJson(url, headers, payload, 4000);
    }
}
//# sourceMappingURL=client.js.map