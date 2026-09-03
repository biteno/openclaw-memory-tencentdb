/**
 * TencentDB HTTP Client for OpenClaw
 * Uses native node:http / node:https with IPv4 affinity to prevent
 * undici / fetch IPv6 .local resolution issues on Linux hosts.
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

import type {
  TencentDBConfig,
  ConversationSearchResponse,
  SkillSearchResponse,
  TurnImportPayload,
  TurnImportResponse,
  WikiSearchResponse,
  CodeGraphSearchResponse,
} from "./types.js";

function postJson<T = any>(
  urlStr: string,
  headers: Record<string, string>,
  bodyObj: any,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(urlStr);
      const postData = JSON.stringify(bodyObj);
      const isHttps = parsed.protocol === "https:";
      const lib = isHttps ? https : http;

      const req = lib.request(
        parsed,
        {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
          },
          timeout: timeoutMs,
          family: 4, // Force IPv4 to prevent Node.js .local / mDNS dual-stack bugs
        },
        (res) => {
          let raw = "";
          res.on("data", (chunk) => {
            raw += chunk;
          });
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(raw) as T);
              } catch {
                resolve(raw as unknown as T);
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
            }
          });
        },
      );

      req.on("error", (err) => {
        reject(new Error(`Connection to ${urlStr} failed: ${err.message}`));
      });

      req.on("timeout", () => {
        req.destroy(new Error(`Timeout after ${timeoutMs}ms connecting to ${urlStr}`));
      });

      req.write(postData);
      req.end();
    } catch (err: any) {
      reject(new Error(`Request setup error for ${urlStr}: ${err.message || String(err)}`));
    }
  });
}

export class TencentDBClient {
  private coreUrl: string;
  private importUrl: string;
  private knowledgeUrl: string;
  private userKey: string;
  private teamId: string;
  private agentId: string;

  constructor(config: TencentDBConfig) {
    this.coreUrl = (config.coreUrl || "http://localhost:8420").replace(/\/+$/, "");
    this.importUrl = (config.importUrl || "http://localhost:8125").replace(/\/+$/, "");
    this.knowledgeUrl = (config.knowledgeUrl || "http://localhost:8424").replace(/\/+$/, "");
    this.userKey = config.userKey || process.env.TDAI_USER_KEY || "";
    this.teamId = config.teamId || process.env.TDAI_TEAM_ID || "default";
    this.agentId = config.agentId || process.env.TDAI_AGENT_ID || "default";
  }

  public getAgentId(): string {
    return this.agentId;
  }

  public getTeamId(): string {
    return this.teamId;
  }

  public isConfigured(): boolean {
    return Boolean(this.userKey && this.coreUrl);
  }

  /**
   * Search past conversation memories (L0/L1) via Core API
   */
  async searchConversation(query: string, limit = 5, customAgentId?: string): Promise<ConversationSearchResponse> {
    const url = `${this.coreUrl}/v2/conversation/search`;
    const headers = {
      Authorization: `Bearer ${this.userKey}`,
      "x-tdai-service-id": this.teamId,
      "x-agent-id": customAgentId || this.agentId,
    };

    const qStr = typeof query === "string" ? query : String(query || "");
    const payload = {
      query: qStr.slice(0, 500),
      limit: typeof limit === "number" ? limit : 5,
    };

    return postJson<ConversationSearchResponse>(url, headers, payload, 4000);
  }

  /**
   * Search skills and distilled knowledge via Core API
   */
  async searchSkills(query: string, limit = 3, customAgentId?: string): Promise<SkillSearchResponse> {
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

    return postJson<SkillSearchResponse>(url, headers, payload, 4000);
  }

  /**
   * Import completed dialogue turn into Panel API (L0 Raw Turn Ingest)
   * Note: Panel Import requires X-Tdai-Service-Id: default in the header,
   * while the actual teamId is passed in the JSON body.
   */
  async importTurn(
    sessionId: string,
    messages: Array<{ role: string; content: string }>,
    customAgentId?: string,
  ): Promise<TurnImportResponse> {
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
    const payload: TurnImportPayload = {
      team_id: this.teamId,
      agent_id: customAgentId || this.agentId,
      session_id: sId.startsWith("openclaw-") ? sId : `openclaw-${sId}`,
      messages: sanitizedMessages,
    };

    return postJson<TurnImportResponse>(url, headers, payload, 6000);
  }

  /**
   * Search Team Wiki documents on port 8424
   */
  async searchWiki(query: string, limit = 5, wikiId?: string): Promise<WikiSearchResponse> {
    const url = `${this.knowledgeUrl}/v3/wiki/search`;
    const headers = {
      Authorization: `Bearer ${this.userKey}`,
      "x-tdai-service-id": this.teamId,
    };

    const qStr = typeof query === "string" ? query : String(query || "");
    const payload: Record<string, any> = {
      team_id: this.teamId,
      query: qStr.slice(0, 500),
      limit: typeof limit === "number" ? limit : 5,
    };
    if (wikiId) {
      payload.wiki_id = wikiId;
    }

    return postJson<WikiSearchResponse>(url, headers, payload, 4000);
  }

  /**
   * Search CodeGraph symbols and impact dependencies on port 8424
   */
  async searchCodeGraph(query: string, limit = 5): Promise<CodeGraphSearchResponse> {
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

    return postJson<CodeGraphSearchResponse>(url, headers, payload, 4000);
  }
}
