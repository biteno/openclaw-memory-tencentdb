/**
 * Types and interfaces for @biteno/openclaw-memory-tencentdb
 */
export interface TencentDBConfig {
    coreUrl?: string;
    importUrl?: string;
    knowledgeUrl?: string;
    userKey?: string;
    teamId?: string;
    agentId?: string;
    autoRecall?: boolean;
    autoCapture?: boolean;
    scoreThreshold?: number;
    maxRecallResults?: number;
}
export interface ConversationMessage {
    role: "user" | "assistant" | "system";
    content: string;
    score?: number;
    created_at?: string;
    id?: string;
}
export interface ConversationSearchResponse {
    code?: number;
    message?: string;
    data?: {
        messages?: ConversationMessage[];
    };
}
export interface SkillItem {
    id?: string;
    name: string;
    description: string;
    snippet?: string;
    score?: number;
}
export interface SkillSearchResponse {
    code?: number;
    message?: string;
    data?: {
        items?: SkillItem[];
    };
}
export interface TurnImportPayload {
    team_id: string;
    agent_id: string;
    session_id: string;
    messages: Array<{
        role: string;
        content: string;
    }>;
}
export interface TurnImportResponse {
    code?: number;
    message?: string;
    status?: string;
}
export interface WikiSearchResponse {
    code?: number;
    message?: string;
    data?: any;
}
export interface CodeGraphSearchResponse {
    code?: number;
    message?: string;
    data?: any;
}
//# sourceMappingURL=types.d.ts.map