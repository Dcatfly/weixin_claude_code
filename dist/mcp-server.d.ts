import { Server } from "@modelcontextprotocol/sdk/server/index.js";
export declare function startTyping(chatId: string, baseUrl: string, token?: string, typingTicket?: string): void;
export declare function stopTyping(chatId: string): void;
export declare function setLastInboundAt(ts: number): void;
export declare function setPollLoopRunning(running: boolean): void;
export declare function setOnLoginSuccess(cb: (accountId: string) => void): void;
export declare function setPollAbortController(ac: AbortController): void;
export declare function createMcpServer(): Server;
