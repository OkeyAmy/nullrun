import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';

/**
 * Minimal structural types for the WebMCP core API. We declare them locally so
 * the game compiles against browsers that ship `document.modelContext`
 * natively as well as against the polyfill.
 */
export interface ToolContent {
  type: 'text';
  text: string;
}

export interface ToolResponse {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, never>) => Promise<ToolResponse> | ToolResponse;
}

export interface ModelContext {
  registerTool(descriptor: ToolDescriptor, options?: { signal?: AbortSignal }): Promise<unknown>;
  getTools?: () => Promise<unknown[]>;
  executeTool?: (tool: unknown, args: unknown) => Promise<ToolResponse>;
}

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
}

export type BridgeMode = 'native' | 'polyfill' | 'unavailable';

export interface Bridge {
  mode: BridgeMode;
  context: ModelContext | null;
}

/**
 * Prefer the browser's own implementation; fall back to the polyfill so the
 * game is still fully agent-drivable (and testable) everywhere else.
 */
export function connectBridge(): Bridge {
  if (typeof document === 'undefined') {
    return { mode: 'unavailable', context: null };
  }

  if (document.modelContext) {
    return { mode: 'native', context: document.modelContext };
  }

  try {
    initializeWebMCPPolyfill();
  } catch (error) {
    console.warn('[nullrun] WebMCP polyfill failed to initialise', error);
  }

  if (document.modelContext) {
    return { mode: 'polyfill', context: document.modelContext };
  }
  return { mode: 'unavailable', context: null };
}

export function textResponse(message: string, data?: unknown): ToolResponse {
  const text = data === undefined ? message : `${message}\n\n${JSON.stringify(data, null, 2)}`;
  return { content: [{ type: 'text', text }] };
}

export function errorResponse(message: string): ToolResponse {
  return { content: [{ type: 'text', text: message }], isError: true };
}
