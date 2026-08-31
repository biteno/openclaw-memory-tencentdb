/**
 * OpenClaw Remote TencentDB Agent Memory Plugin
 *
 * Robust bidirectional memory integration:
 * - Pre-turn semantic recall (before_agent_start)
 * - Multi-turn capture (agent_end) with support for Thinking Models (Gemini 3.7 / Claude 3.7)
 * - Tool-use & multi-block message parsing
 */
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
}
declare const memoryPlugin: {
    id: string;
    name: string;
    description: string;
    kind: "memory";
    register(api: OpenClawPluginApi): void;
};
export default memoryPlugin;
//# sourceMappingURL=index.d.ts.map