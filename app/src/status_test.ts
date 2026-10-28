import { assertEquals } from 'https://deno.land/std@0.217.0/assert/mod.ts';
import { serverUrls } from './status.ts';

Deno.test('wildcard IPv4 listener advertises usable, unique IP URLs', () => {
  assertEquals(
    serverUrls('0.0.0.0', 4321, [
      '127.0.0.1',
      '192.168.1.10',
      '192.168.1.10',
      '10.0.0.5',
      '::1',
      'fe80::1',
      '2001:db8::1',
    ]),
    ['http://127.0.0.1:4321', 'http://192.168.1.10:4321', 'http://10.0.0.5:4321'],
  );
});

Deno.test('IPv6 listener brackets routable IPv6 addresses and excludes link-local addresses', () => {
  assertEquals(
    serverUrls('::', 3000, ['::1', 'fe80::1234', '2001:db8::1']),
    ['http://127.0.0.1:3000', 'http://[2001:db8::1]:3000'],
  );
});

Deno.test('explicit bind address does not advertise other interfaces', () => {
  assertEquals(serverUrls('127.0.0.1', 9876, ['192.168.1.10']), ['http://127.0.0.1:9876']);
  assertEquals(serverUrls('::1', 9876, []), ['http://[::1]:9876']);
});
