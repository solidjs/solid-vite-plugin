import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { parseRequestTarget, webRequestFromNode } from './http.js';

function nodeRequest(url: string): IncomingMessage {
  return { url, method: 'GET', headers: { host: 'localhost:3000' }, socket: {} } as IncomingMessage;
}

describe('request URLs', () => {
  it('keeps a request target that starts with // as the path', () => {
    const request = webRequestFromNode(nodeRequest('//evil.example/api/x?y=1'));
    expect(request.url).toBe('http://localhost:3000//evil.example/api/x?y=1');
  });

  it('keeps the host for a backslash after the leading slash', () => {
    expect(parseRequestTarget('/\\evil.example/x', 'http://localhost').host).toBe('localhost');
  });

  it('keeps the path when the Host header carries URL delimiters', () => {
    for (const host of ['localhost#', 'localhost?', 'localhost/x']) {
      expect(parseRequestTarget('/admin', `http://${host}`).pathname).toBe('/admin');
    }
  });

  it('serves a // path from the node entry as that path, not the one after the host', () => {
    expect(parseRequestTarget('//assets/x.js', 'http://localhost').pathname).toBe('//assets/x.js');
  });

  it('resolves ordinary paths against the host', () => {
    expect(webRequestFromNode(nodeRequest('/a/b?c=1')).url).toBe('http://localhost:3000/a/b?c=1');
  });
});
