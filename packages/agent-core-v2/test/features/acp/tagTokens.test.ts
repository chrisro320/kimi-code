import { describe, expect, test } from 'vitest';
import { formatTokens, rewriteTagTokens, stableTagTokens } from '#/features/acp/tagTokens';

describe('tagTokens - stable tag token formatting and rewriting', () => {
  test('formatTokens mirrors kernel formatting rules', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1.0K');
    expect(formatTokens(2500)).toBe('2.5K');
    expect(formatTokens(9999)).toBe('10.0K');
    expect(formatTokens(10000)).toBe('10K');
    expect(formatTokens(12345)).toBe('12K');
  });

  test('stableTagTokens produces deterministic token count from text', () => {
    expect(stableTagTokens('')).toBe('0');
    expect(stableTagTokens('hello world foo bar baz')).toBe('6');
    expect(stableTagTokens('这是一个中文测试')).toBe('8');
    expect(stableTagTokens('hello世界')).toBe('4');
  });

  test('rewriteTagTokens replaces tokens attribute while preserving ref and type', () => {
    const tag = '<acp tokens="5.0K" type="bash">m00042</acp>';
    const body = 'hello world foo bar baz';
    const rewritten = rewriteTagTokens(tag, body);
    expect(rewritten).toBe('<acp tokens="6" type="bash">m00042</acp>');
  });

  test('rewriteTagTokens works with text type tags', () => {
    const tag = '<acp tokens="2.5K" type="text">m00001</acp>';
    const body = '这是一个中文测试';
    const rewritten = rewriteTagTokens(tag, body);
    expect(rewritten).toBe('<acp tokens="8" type="text">m00001</acp>');
  });
});
