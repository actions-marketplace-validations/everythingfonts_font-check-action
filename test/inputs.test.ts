import { describe, expect, it } from 'vitest';
import { isPullRequestEvent, parseApiUrl, parseFailBelow, parseFailOn, resolveToggle } from '../src/inputs';

describe('inputs', () => {
  it('defaults the event-dependent toggles and lets an explicit value win', () => {
    expect(resolveToggle('changed-only', '', isPullRequestEvent('pull_request'))).toBe(true);
    expect(resolveToggle('changed-only', '', isPullRequestEvent('pull_request_target'))).toBe(true);
    expect(resolveToggle('changed-only', '', isPullRequestEvent('push'))).toBe(false);
    expect(resolveToggle('comment', 'false', true)).toBe(false);
    expect(resolveToggle('comment', 'true', false)).toBe(true);
    expect(() => resolveToggle('comment', 'maybe', true)).toThrow(/comment/);
  });

  it('validates fail-on', () => {
    expect(parseFailOn('')).toBe('error');
    expect(parseFailOn('warning')).toBe('warning');
    expect(() => parseFailOn('bogus')).toThrow(/fail-on/);
  });

  it('validates fail-below as an integer 0-100', () => {
    expect(parseFailBelow('')).toBeUndefined();
    expect(parseFailBelow('0')).toBe(0);
    expect(parseFailBelow('100')).toBe(100);
    for (const bad of ['101', '-1', '7.5', 'abc']) {
      expect(() => parseFailBelow(bad)).toThrow(/fail-below/);
    }
  });
});

describe('parseApiUrl', () => {
  it('falls back to the default when empty and trims the value', () => {
    expect(parseApiUrl('')).toBe('https://font.rest/api/v1');
    expect(parseApiUrl('   ')).toBe('https://font.rest/api/v1');
    expect(parseApiUrl(' https://everythingfonts.com/api/v1 ')).toBe('https://everythingfonts.com/api/v1');
  });

  it('allows http only for localhost and 127.0.0.1', () => {
    expect(parseApiUrl('http://localhost:8000/api/v1')).toBe('http://localhost:8000/api/v1');
    expect(parseApiUrl('http://127.0.0.1/api/v1')).toBe('http://127.0.0.1/api/v1');
    for (const bad of ['http://example.com/api/v1', 'http://localhost.example.com', 'ftp://font.rest', 'font.rest/api/v1']) {
      expect(() => parseApiUrl(bad)).toThrow('Input api-url must be an https URL');
    }
  });
});
