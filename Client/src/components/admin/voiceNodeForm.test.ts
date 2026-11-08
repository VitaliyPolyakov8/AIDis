import { describe, expect, it } from 'vitest';
import { parseNodeBlock, validNodeUrl } from './voiceNodeForm';

const validNodeUrlFor = (url: string) => validNodeUrl(url, 'chat.example.com');

describe('0.7.1 voice server form', () => {
  it('reads the block the VPS script prints (any order, extra spaces)', () => {
    const block = '  API secret:  s3cr3t-0123456789abcdefghij\nURL: wss://rtc2.chat.example.com\n\nAPI key:   APIabc123  \n';
    expect(parseNodeBlock(block)).toEqual({ url: 'wss://rtc2.chat.example.com', apiKey: 'APIabc123', apiSecret: 's3cr3t-0123456789abcdefghij' });
  });

  it('returns null when something is missing or it is not the block', () => {
    expect(parseNodeBlock('URL: wss://rtc2.chat.example.com\nAPI key: x')).toBeNull();
    expect(parseNodeBlock('hello')).toBeNull();
  });

  it('accepts only wss:// subdomains of chat.example.com', () => {
    expect(validNodeUrlFor('wss://rtc2.chat.example.com')).toBe(true);
    expect(validNodeUrlFor('https://rtc2.chat.example.com')).toBe(false);
    expect(validNodeUrlFor('wss://rtc2.example.com')).toBe(false);
    expect(validNodeUrlFor('wss://1.2.3.4')).toBe(false);
    expect(validNodeUrlFor('wss://chat.example.com')).toBe(false);
    expect(validNodeUrlFor('wss://rtc2.chat.example.com:7880')).toBe(false);
  });
});
