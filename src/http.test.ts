import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { parseRequestTarget, parseTrustProxy, webRequestFromNode } from './http.js';

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

function proxiedRequest(remoteAddress: string, proto?: string): IncomingMessage {
  const headers: Record<string, string> = { host: 'example.com' };
  if (proto !== undefined) headers['x-forwarded-proto'] = proto;
  return { url: '/_server', method: 'GET', headers, socket: { remoteAddress } } as IncomingMessage;
}

describe('trustProxy', () => {
  it('ignores X-Forwarded-Proto by default', () => {
    expect(webRequestFromNode(proxiedRequest('127.0.0.1', 'https')).url).toBe(
      'http://example.com/_server',
    );
  });

  it('takes the scheme from a trusted peer', () => {
    const url = (address: string, trust: Parameters<typeof webRequestFromNode>[3]) =>
      webRequestFromNode(proxiedRequest(address, 'https'), undefined, undefined, trust).url;
    expect(url('203.0.113.9', true)).toBe('https://example.com/_server');
    expect(url('127.0.0.1', 'loopback')).toBe('https://example.com/_server');
    expect(url('::ffff:127.0.0.1', 'loopback')).toBe('https://example.com/_server');
    expect(url('::1', 'loopback')).toBe('https://example.com/_server');
    expect(url('10.0.0.2', ['10.0.0.2'])).toBe('https://example.com/_server');
  });

  it('ignores the header from a peer it does not trust', () => {
    const url = (address: string, trust: Parameters<typeof webRequestFromNode>[3]) =>
      webRequestFromNode(proxiedRequest(address, 'https'), undefined, undefined, trust).url;
    expect(url('203.0.113.9', 'loopback')).toBe('http://example.com/_server');
    expect(url('10.0.0.3', ['10.0.0.2'])).toBe('http://example.com/_server');
  });

  it('uses the nearest proxy value and only http or https', () => {
    const url = (proto: string) =>
      webRequestFromNode(proxiedRequest('127.0.0.1', proto), undefined, undefined, true).url;
    expect(url('http, https')).toBe('https://example.com/_server');
    expect(url('https, http')).toBe('http://example.com/_server');
    expect(url(' HTTPS ')).toBe('https://example.com/_server');
    expect(url('ftp')).toBe('http://example.com/_server');
  });

  it('keeps https on a TLS socket when the header is absent', () => {
    const req = proxiedRequest('127.0.0.1');
    (req.socket as { encrypted?: boolean }).encrypted = true;
    expect(webRequestFromNode(req, undefined, undefined, true).url).toBe(
      'https://example.com/_server',
    );
  });

  it('parses TRUST_PROXY', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(true);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy('10.0.0.2, 10.0.0.3')).toEqual(['10.0.0.2', '10.0.0.3']);
  });
});
