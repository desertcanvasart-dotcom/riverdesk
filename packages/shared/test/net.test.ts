import { describe, expect, it } from 'vitest';
import { isPublicAddress, webhookUrlProblem } from '../src/net';

describe('outgoing addresses', () => {
  it('tells public addresses from this machine, the private network and cloud metadata', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
      expect(isPublicAddress(address), address).toBe(true);
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd12:3456::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      'not-an-ip',
    ])
      expect(isPublicAddress(address), address).toBe(false);
  });

  it('hosted webhooks: https to a public host only; locally anything http(s)', () => {
    expect(webhookUrlProblem('https://hooks.agency.example/vs', true)).toBeNull();
    expect(webhookUrlProblem('https://8.8.8.8/vs', true)).toBeNull();
    for (const url of [
      'http://hooks.agency.example/vs',
      'https://127.0.0.1/vs',
      'https://[::1]/vs',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/vs',
      'https://api.railway.internal/vs',
      'https://printer.local/vs',
      'https://intranet/vs',
      'https://user:pw@hooks.agency.example/vs',
      'ftp://hooks.agency.example/vs',
    ])
      expect(webhookUrlProblem(url, true), url).not.toBeNull();
    expect(webhookUrlProblem('http://127.0.0.1:4000/hooks', false)).toBeNull();
    expect(webhookUrlProblem('ftp://127.0.0.1/hooks', false)).not.toBeNull();
  });
});
