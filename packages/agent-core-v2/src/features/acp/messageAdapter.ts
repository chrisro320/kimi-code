/**
 * `acp` domain — pure conversion between Kimi provider-neutral messages and
 * ACP kernel messages.
 *
 * Preserves Kimi-only content on the original message while exposing text and
 * tool-call bodies to the kernel. Rejects opaque carriers and media so callers
 * can fail open before a lossy transform reaches the provider. No scoped state
 * or I/O.
 */

import type { CoreMessage } from 'acp-kernel';

import {
  isToolDeclarationOnlyMessage,
  type ContentPart,
  type Message,
  type ThinkPart,
  type ToolCall,
} from '#/kosong/contract/message';

type CoreOrigin =
  | { readonly messageIndex: number; readonly kind: 'text' }
  | {
      readonly messageIndex: number;
      readonly kind: 'reasoning';
      readonly contentIndex: number;
      readonly toolCallId?: string;
    }
  | { readonly messageIndex: number; readonly kind: 'tool-call'; readonly toolCallId: string }
  | { readonly messageIndex: number; readonly kind: 'tool-result'; readonly toolCallId: string };

export interface CoreProjection {
  readonly messages: CoreMessage[];
  readonly origins: ReadonlyMap<string, CoreOrigin>;
  readonly originals: readonly Message[];
}

export type CoreProjectionResult =
  | { readonly ok: true; readonly projection: CoreProjection }
  | { readonly ok: false; readonly reason: string };

const ACP_TAG = /^<acp\s[^>]*>m\d{5}<\/acp>\n?/;
const SUMMARY_ID_PREFIX = 'acp_summary_';
/** Tools whose call arguments the kernel may cosmetically rewrite while keeping
 *  the core visible (acp-kernel hide-consumed range filtering). */
const KERNEL_REWRITABLE_TOOLS = new Set(['compress']);

/**
 * Validates a kernel compress-argument rewrite (hide-consumed filtering).
 * Both sides must parse as JSON objects, every non-`content` field must be
 * preserved verbatim, and the rewritten `content` array must be an ordered
 * subsequence of the original entries (compared entry-by-entry via JSON).
 * Returns the rewritten arguments when valid, otherwise undefined.
 */
function validatedCompressRewrite(originalArgs: string, rewrittenText: string): string | undefined {
  let before: unknown;
  let after: unknown;
  try {
    before = JSON.parse(originalArgs);
    after = JSON.parse(rewrittenText);
  } catch {
    return undefined;
  }
  if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object') {
    return undefined;
  }
  const beforeObj = before as Record<string, unknown>;
  const afterObj = after as Record<string, unknown>;
  for (const key of Object.keys(beforeObj)) {
    if (key === 'content') continue;
    if (!(key in afterObj) || JSON.stringify(afterObj[key]) !== JSON.stringify(beforeObj[key])) {
      return undefined;
    }
  }
  for (const key of Object.keys(afterObj)) {
    if (key === 'content') continue;
    if (!(key in beforeObj)) return undefined;
  }
  const beforeContent = beforeObj['content'];
  const afterContent = afterObj['content'];
  if (!Array.isArray(beforeContent) || !Array.isArray(afterContent)) return undefined;
  const pool = beforeContent.map((entry) => JSON.stringify(entry));
  let cursor = 0;
  for (const entry of afterContent) {
    const needle = JSON.stringify(entry);
    let found = -1;
    for (let i = cursor; i < pool.length; i++) {
      if (pool[i] === needle) {
        found = i;
        break;
      }
    }
    if (found < 0) return undefined;
    cursor = found + 1;
  }
  return rewrittenText;
}

export function projectAcpMessages(
  messages: readonly Message[],
  idForMessage: (message: Message, index: number) => string,
): CoreProjectionResult {
  const coreMessages: CoreMessage[] = [];
  const origins = new Map<string, CoreOrigin>();
  const baseIds = new Set<string>();
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const [messageIndex, message] of messages.entries()) {
    for (const call of message.toolCalls) {
      if (toolCallIds.has(call.id)) {
        return { ok: false, reason: `ACP tool call id is duplicated at index ${messageIndex}` };
      }
      toolCallIds.add(call.id);
    }
  }
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== 'tool') continue;
    const toolCallId = message.toolCallId;
    if (toolCallId === undefined || toolResultIds.has(toolCallId)) {
      return { ok: false, reason: `ACP tool result id is missing or duplicated at index ${messageIndex}` };
    }
    toolResultIds.add(toolCallId);
  }

  for (const [messageIndex, message] of messages.entries()) {
    if (message.partial === true) {
      return { ok: false, reason: 'ACP cannot safely transform a partial message' };
    }
    if (isToolDeclarationOnlyMessage(message)) {
      return { ok: false, reason: 'ACP cannot safely transform a tool-declaration-only message' };
    }
    const unsupported = unsupportedPart(message.content);
    if (unsupported !== undefined) return { ok: false, reason: unsupported };

    const baseId = idForMessage(message, messageIndex);
    if (
      baseId.length === 0 ||
      baseIds.has(baseId) ||
      origins.has(baseId) ||
      baseId.startsWith(SUMMARY_ID_PREFIX)
    ) {
      return {
        ok: false,
        reason: `ACP message id is empty, duplicated, or reserved at index ${messageIndex}`,
      };
    }
    baseIds.add(baseId);

    const text = textOf(message.content);
    if (text.length > 0 || (message.toolCalls.length === 0 && !hasReasoning(message.content))) {
      const contentType = message.role === 'tool' ? 'tool-result' : 'text';
      const core: CoreMessage = {
        id: baseId,
        role: message.role,
        contentType,
        text,
        ...(message.name === undefined ? {} : { toolName: message.name }),
        ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
      };
      coreMessages.push(core);
      origins.set(
        baseId,
        message.role === 'tool'
          ? { messageIndex, kind: 'tool-result', toolCallId: message.toolCallId! }
          : { messageIndex, kind: 'text' },
      );
    }

    for (const [contentIndex, part] of message.content.entries()) {
      if (part.type !== 'think') continue;
      const id = `${baseId}#reasoning:${contentIndex}`;
      if (origins.has(id) || baseIds.has(id)) {
        return { ok: false, reason: `ACP core id collides at message index ${messageIndex}` };
      }
      coreMessages.push({
        id,
        role: message.role,
        contentType: 'reasoning',
        text: part.think,
      });
      origins.set(id, {
        messageIndex,
        kind: 'reasoning',
        contentIndex,
        ...(message.role === 'tool' ? { toolCallId: message.toolCallId! } : {}),
      });
    }

    for (const call of message.toolCalls) {
      const id = `${baseId}#tool:${call.id}`;
      if (origins.has(id) || baseIds.has(id)) {
        return { ok: false, reason: `ACP tool call id is duplicated at index ${messageIndex}` };
      }
      coreMessages.push({
        id,
        role: message.role,
        contentType: 'tool-call',
        toolName: call.name,
        toolCallId: call.id,
        text: call.arguments ?? '',
      });
      origins.set(id, { messageIndex, kind: 'tool-call', toolCallId: call.id });
    }
  }

  return {
    ok: true,
    projection: { messages: coreMessages, origins, originals: messages },
  };
}

export type CoreRebuildResult =
  | { readonly ok: true; readonly messages: Message[] }
  | { readonly ok: false; readonly reason: string };

export function rebuildAcpMessages(
  coreMessages: readonly CoreMessage[],
  projection: CoreProjection,
): CoreRebuildResult {
  const byMessage = new Map<number, CoreMessage[]>();
  const firstPosition = new Map<number, number>();
  const lastPosition = new Map<number, number>();
  const seenIds = new Set<string>();
  let previousMessageIndex = -1;

  for (const [position, core] of coreMessages.entries()) {
    if (seenIds.has(core.id)) {
      return { ok: false, reason: `ACP kernel returned duplicate id ${core.id}` };
    }
    seenIds.add(core.id);
    const origin = projection.origins.get(core.id);
    if (origin === undefined && !core.id.startsWith(SUMMARY_ID_PREFIX)) {
      return { ok: false, reason: `ACP kernel returned unknown id ${core.id}` };
    }
    if (origin === undefined) continue;
    if (origin.messageIndex < previousMessageIndex) {
      return { ok: false, reason: 'ACP kernel reordered source message groups' };
    }
    previousMessageIndex = origin.messageIndex;
    const group = byMessage.get(origin.messageIndex) ?? [];
    group.push(core);
    byMessage.set(origin.messageIndex, group);
    if (!firstPosition.has(origin.messageIndex)) firstPosition.set(origin.messageIndex, position);
    lastPosition.set(origin.messageIndex, position);
  }

  for (const [position, core] of coreMessages.entries()) {
    if (!core.id.startsWith(SUMMARY_ID_PREFIX)) continue;
    for (const [messageIndex, first] of firstPosition) {
      const last = lastPosition.get(messageIndex)!;
      if (first < position && position < last) {
        return { ok: false, reason: 'ACP summary splits one source message group' };
      }
    }
    const splitToolCallId = toolInteractionSplitAt(position, coreMessages, projection.origins);
    if (splitToolCallId !== undefined) {
      return {
        ok: false,
        reason: `ACP summary splits tool interaction ${splitToolCallId}`,
      };
    }
  }

  const pairingError = validateSurvivingToolPairs(seenIds, projection.origins);
  if (pairingError !== undefined) return { ok: false, reason: pairingError };

  const out: Message[] = [];
  const emitted = new Set<number>();
  for (const [position, core] of coreMessages.entries()) {
    if (core.id.startsWith(SUMMARY_ID_PREFIX)) {
      out.push({
        role: 'system',
        content: [{ type: 'text', text: core.text ?? '' }],
        toolCalls: [],
      });
      continue;
    }
    const origin = projection.origins.get(core.id);
    if (origin === undefined || emitted.has(origin.messageIndex)) continue;
    if (firstPosition.get(origin.messageIndex) !== position) continue;
    emitted.add(origin.messageIndex);
    const rebuilt = rebuildOriginal(
      projection.originals[origin.messageIndex]!,
      byMessage.get(origin.messageIndex)!,
      projection.origins,
    );
    if (!rebuilt.ok) return rebuilt;
    out.push(rebuilt.message);
  }

  return { ok: true, messages: out };
}

type RebuiltMessage =
  | { readonly ok: true; readonly message: Message }
  | { readonly ok: false; readonly reason: string };

function rebuildOriginal(
  original: Message,
  cores: readonly CoreMessage[],
  origins: ReadonlyMap<string, CoreOrigin>,
): RebuiltMessage {
  let textCore: CoreMessage | undefined;
  const reasoningCores = new Map<number, CoreMessage>();
  const survivingCalls = new Map<string, CoreMessage>();
  for (const core of cores) {
    const origin = origins.get(core.id);
    if (origin?.kind === 'tool-call') survivingCalls.set(origin.toolCallId, core);
    else if (origin?.kind === 'reasoning') reasoningCores.set(origin.contentIndex, core);
    else textCore = core;
  }

  const toolCalls: ToolCall[] = [];
  for (const call of original.toolCalls) {
    const core = survivingCalls.get(call.id);
    if (core === undefined) continue;
    const rewrittenText = peelTag(core.text ?? '');
    if (rewrittenText === (call.arguments ?? '')) {
      toolCalls.push(call);
      continue;
    }
    // The kernel cosmetically filters consumed ranges out of a surviving
    // compress call's arguments (hide-consumed). Emit the rewritten arguments
    // only when they verify as an ordered subsequence of the original content
    // with every other field preserved; otherwise fail the rebuild.
    if (KERNEL_REWRITABLE_TOOLS.has(call.name)) {
      const rewritten = validatedCompressRewrite(call.arguments ?? '', rewrittenText);
      if (rewritten !== undefined) {
        toolCalls.push({ ...call, arguments: rewritten });
        continue;
      }
    }
    return { ok: false, reason: `ACP changed tool-call arguments for ${call.id}` };
  }
  const rebuiltContent = rebuildContent(original.content, textCore, reasoningCores);
  if (!rebuiltContent.ok) return rebuiltContent;
  const content = rebuiltContent.content;
  if (content.length === 0 && toolCalls.length === 0 && original.tools === undefined) {
    return { ok: false, reason: `ACP produced an empty ${original.role} message` };
  }

  if (sameContent(content, original.content) && sameToolCalls(toolCalls, original.toolCalls)) {
    return { ok: true, message: original };
  }
  return { ok: true, message: { ...original, content: [...content], toolCalls } };
}

type RebuiltContent =
  | { readonly ok: true; readonly content: readonly ContentPart[] }
  | { readonly ok: false; readonly reason: string };

function rebuildContent(
  original: readonly ContentPart[],
  textCore: CoreMessage | undefined,
  reasoningCores: ReadonlyMap<number, CoreMessage>,
): RebuiltContent {
  const originalText = textOf(original);
  const coreText = peelTag(textCore?.text ?? '');
  const tag = tagOf(textCore?.text);
  const textChanged = textCore !== undefined && coreText !== originalText;
  const textPartCount = original.filter((part) => part.type === 'text').length;
  if (textPartCount > 1 && (textChanged || tag !== undefined)) {
    return { ok: false, reason: 'ACP cannot safely rebuild mutated multiple text parts' };
  }
  const out: ContentPart[] = [];
  let wroteText = false;

  for (const [contentIndex, part] of original.entries()) {
    if (part.type === 'text') {
      if (textCore === undefined) continue;
      if (!textChanged && tag === undefined) {
        out.push(part);
        wroteText = true;
        continue;
      }
      if (wroteText) continue;
      const body = textChanged ? coreText : originalText;
      const text = tag === undefined ? body : body.length === 0 ? tag : `${tag}\n${body}`;
      if (text.length > 0) out.push({ type: 'text', text });
      wroteText = true;
      continue;
    }
    if (part.type === 'think') {
      const reasoningCore = reasoningCores.get(contentIndex);
      if (part.encrypted !== undefined) {
        out.push(part);
      } else if (reasoningCore !== undefined) {
        const think = peelTag(reasoningCore.text ?? '');
        if (think.length > 0) out.push(think === part.think ? part : { ...part, think });
      }
      continue;
    }
    out.push(part);
  }

  if (!wroteText && textCore !== undefined) {
    const text = tag === undefined ? coreText : coreText.length === 0 ? tag : `${tag}\n${coreText}`;
    if (text.length > 0) out.push({ type: 'text', text });
  }
  return { ok: true, content: sameContent(out, original) ? original : out };
}

function validateSurvivingToolPairs(
  survivingIds: ReadonlySet<string>,
  origins: ReadonlyMap<string, CoreOrigin>,
): string | undefined {
  const calls = new Map<string, boolean>();
  const results = new Map<string, boolean>();
  for (const [id, origin] of origins) {
    if (origin.kind === 'tool-call') calls.set(origin.toolCallId, survivingIds.has(id));
    if (origin.kind === 'tool-result') results.set(origin.toolCallId, survivingIds.has(id));
    if (origin.kind === 'reasoning' && origin.toolCallId !== undefined && survivingIds.has(id)) {
      results.set(origin.toolCallId, true);
    }
  }
  for (const [toolCallId, callSurvives] of calls) {
    const resultSurvives = results.get(toolCallId);
    if (resultSurvives !== undefined && callSurvives !== resultSurvives) {
      return `ACP kernel orphaned tool interaction ${toolCallId}`;
    }
  }
  return undefined;
}

function toolInteractionSplitAt(
  summaryPosition: number,
  messages: readonly CoreMessage[],
  origins: ReadonlyMap<string, CoreOrigin>,
): string | undefined {
  const callsBefore = new Set<string>();
  for (const [position, message] of messages.entries()) {
    const origin = origins.get(message.id);
    if (origin?.kind === 'tool-call' && position < summaryPosition) {
      callsBefore.add(origin.toolCallId);
    }
    const resultToolCallId =
      origin?.kind === 'tool-result'
        ? origin.toolCallId
        : origin?.kind === 'reasoning'
          ? origin.toolCallId
          : undefined;
    if (
      resultToolCallId !== undefined &&
      position > summaryPosition &&
      callsBefore.has(resultToolCallId)
    ) {
      return resultToolCallId;
    }
  }
  return undefined;
}

function unsupportedPart(parts: readonly ContentPart[]): string | undefined {
  for (const part of parts as readonly { readonly type: string }[]) {
    if (part.type === 'compaction') return 'ACP cannot safely transform a compaction checkpoint carrier';
    if (part.type !== 'text' && part.type !== 'think') {
      return `ACP cannot safely transform ${part.type} content`;
    }
  }
  return undefined;
}

function textOf(parts: readonly ContentPart[]): string {
  return parts
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text.replace(ACP_TAG, ''))
    .join('\n');
}

function hasReasoning(parts: readonly ContentPart[]): boolean {
  return parts.some((part) => part.type === 'think');
}

function tagOf(text: string | undefined): string | undefined {
  return text?.match(ACP_TAG)?.[0].trimEnd();
}

function peelTag(text: string): string {
  return text.replace(ACP_TAG, '');
}

export { peelTag };

function sameContent(left: readonly ContentPart[], right: readonly ContentPart[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function sameToolCalls(left: readonly ToolCall[], right: readonly ToolCall[]): boolean {
  return left.length === right.length && left.every((call, index) => call === right[index]);
}
