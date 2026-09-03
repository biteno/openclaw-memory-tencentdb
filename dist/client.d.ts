/**
 * TencentDB HTTP Client for OpenClaw
 * Uses native node:http / node:https with IPv4 affinity to prevent
 * undici / fetch IPv6 .local resolution issues on Linux hosts.
 */
import type { TencentDBConfig, ConversationSearchResponse, SkillSearchResponse, TurnImportResponse, WikiSearchResponse, CodeGraphSearchResponse } from "./types.js";
export declare class TencentDBClient {
    private coreUrl;
    private importUrl;
    private knowledgeUrl;
    private userKey;
    private teamId;
    private agentId;
    constructor(config: TencentDBConfig);
    getAgentId(): string;
    getTeamId(): string;
    isConfigured(): boolean;
    /**
     * Search past conversation memories & distilled facts (L0-L3)
     * Queries both L0 (raw messages, full markdown tables) and L1 (distilled facts)
     * on the Panel dedicated agent block (/api/v1/chat-memory/search on port 8125)
     * as well as the Core conversational vector index (/v2/conversation/search on port 8420),
     * merging the results so no memories are missed regardless of team partitioning.
     */
    searchConversation(query: string, limit?: number, customAgentId?: string): Promise<ConversationSearchResponse>;
    /**
     * Search skills and distilled knowledge via Core API
     */
    searchSkills(query: string, limit?: number, customAgentId?: string): Promise<SkillSearchResponse>;
    /**
     * Import completed dialogue turn into Panel API (L0 Raw Turn Ingest)
     * Note: Panel Import requires X-Tdai-Service-Id: default in the header,
     * while the actual teamId is passed in the JSON body.
     */
    importTurn(sessionId: string, messages: Array<{
        role: string;
        content: string;
    }>, customAgentId?: string): Promise<TurnImportResponse>;
    /**
     * Search Team Wiki documents on port 8424
     */
    searchWiki(query: string, limit?: number, wikiId?: string): Promise<WikiSearchResponse>;
    /**
     * Search CodeGraph symbols and impact dependencies on port 8424
     */
    searchCodeGraph(query: string, limit?: number): Promise<CodeGraphSearchResponse>;
}
//# sourceMappingURL=client.d.ts.map