/**
 * OpenClaw Remote TencentDB Agent Memory Plugin
 *
 * Combines prefetch recall before agent turns with an autonomous
 * session file watcher that syncs all conversation files to TencentDB.
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
    registerCli?(cli: {
        command: string;
        description: string;
        action: (args: any) => Promise<void>;
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