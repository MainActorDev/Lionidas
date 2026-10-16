/** Timeline item types — the TurnItem contract shared from the server
 *  (Phase 5 step 2). Type-only mirror: the server emits, the web renders. */
export type TurnItemStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type TurnItemIntent = 'queued' | 'steering';

export interface TurnItemBase {
  id: string;
  sessionId: string;
  turnId: string | null;
  ordinal: number;
  status: TurnItemStatus;
  startedAt: number;
  completedAt: number | null;
}

export interface MessageItem extends TurnItemBase {
  kind: 'message';
  role: 'user' | 'assistant';
  streaming: boolean;
  text: string;
  intent?: TurnItemIntent;
  /** sketch-A turn meta (assistant messages): duration/cost from the durable
   *  log; the page layers the model name. */
  turnMeta?: { durationMs: number | null; cost: number | null };
}

export interface ToolCallItem extends TurnItemBase {
  kind: 'mcp_tool_call';
  toolCallId: string;
  name: string;
  arg?: string;
  result?: string;
  isError?: boolean;
}

export interface ErrorItem extends TurnItemBase {
  kind: 'error';
  class: 'provider_error' | 'empty_completion' | 'aborted';
  message: string;
}

export interface UsageItem extends TurnItemBase {
  kind: 'usage';
  cost: number;
  contextUsed: number;
  contextWindow: number;
}

export interface CompactionItem extends TurnItemBase {
  kind: 'compaction';
  summary: string;
}

export type TurnItem = MessageItem | ToolCallItem | ErrorItem | UsageItem | CompactionItem;

export interface TimelineResponse {
  items: TurnItem[];
  liveTurn?: { turnId: string; startedAt: number };
}
