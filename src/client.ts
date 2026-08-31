/**
 * TencentDB HTTP Client for OpenClaw
 */

import type {
  TencentDBConfig,
  ConversationSearchResponse,
  SkillSearchResponse,
  TurnImportPayload,
  TurnImportResponse,
  WikiSearchResponse,
  CodeGraphSearchResponse,
} from "./types.js";

function formatFetchError(err: any): string {
  if (!err) return "Unknown error";
  const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : "";
  return `${err.message || String(err)}${cause}`;
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
      "Content-Type": "application/json",
    };

    const payload = {
      query: query.slice(0, 500),
      limit,
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4000),
      });

      if (!res.ok) {
        throw new Error(`Core search returned HTTP ${res.status}: ${await res.text()}`);
      }

      return (await res.json()) as ConversationSearchResponse;
    } catch (err: any) {
      throw new Error(`Failed connecting to Core at ${url}: ${formatFetchError(err)}`);
    }
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
      "Content-Type": "application/json",
    };

    const payload = {
      query: query.slice(0, 500),
      limit,
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4000),
      });

      if (!res.ok) {
        throw new Error(`Skill search returned HTTP ${res.status}: ${await res.text()}`);
      }

      return (await res.json()) as SkillSearchResponse;
    } catch (err: any) {
      throw new Error(`Failed connecting to Skill service at ${url}: ${formatFetchError(err)}`);
    }
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
      "Content-Type": "application/json",
    };

    const payload: TurnImportPayload = {
      team_id: this.teamId,
      agent_id: customAgentId || this.agentId,
      session_id: sessionId.startsWith("openclaw-") ? sessionId : `openclaw-${sessionId}`,
      messages,
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) {
        throw new Error(`Panel import returned HTTP ${res.status}: ${await res.text()}`);
      }

      return (await res.json()) as TurnImportResponse;
    } catch (err: any) {
      throw new Error(`Failed connecting to Panel at ${url}: ${formatFetchError(err)}`);
    }
  }

  /**
   * Search Team Wiki documents on port 8424
   */
  async searchWiki(query: string, limit = 5, wikiId?: string): Promise<WikiSearchResponse> {
    const url = `${this.knowledgeUrl}/v3/wiki/search`;
    const headers = {
      Authorization: `Bearer ${this.userKey}`,
      "x-tdai-service-id": this.teamId,
      "Content-Type": "application/json",
    };

    const payload: Record<string, any> = {
      team_id: this.teamId,
      query,
      limit,
    };
    if (wikiId) {
      payload.wiki_id = wikiId;
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4000),
      });

      if (!res.ok) {
        throw new Error(`Wiki search returned HTTP ${res.status}: ${await res.text()}`);
      }

      return (await res.json()) as WikiSearchResponse;
    } catch (err: any) {
      throw new Error(`Failed connecting to Wiki service at ${url}: ${formatFetchError(err)}`);
    }
  }

  /**
   * Search CodeGraph symbols and impact dependencies on port 8424
   */
  async searchCodeGraph(query: string, limit = 5): Promise<CodeGraphSearchResponse> {
    const url = `${this.knowledgeUrl}/v3/code-graph/search`;
    const headers = {
      Authorization: `Bearer ${this.userKey}`,
      "x-tdai-service-id": this.teamId,
      "Content-Type": "application/json",
    };

    const payload = {
      team_id: this.teamId,
      query,
      limit,
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4000),
      });

      if (!res.ok) {
        throw new Error(`CodeGraph search returned HTTP ${res.status}: ${await res.text()}`);
      }

      return (await res.json()) as CodeGraphSearchResponse;
    } catch (err: any) {
      throw new Error(`Failed connecting to CodeGraph service at ${url}: ${formatFetchError(err)}`);
    }
  }
}
