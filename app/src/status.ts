export type NvimContext = {
  pid: number;
  buffer: { number: number; name: string };
};

export type ConnectionStatus = {
  id: string;
  label: string;
  context?: NvimContext;
};

/** Wildcard bind addresses are not destinations; advertise actual interface IPs. */
export function serverUrls(hostname: string, port: number, addresses: string[]): string[] {
  const hosts = hostname === '0.0.0.0' || hostname === '::'
    ? [
      '127.0.0.1',
      ...addresses.filter((address) =>
        address !== '::1' && !address.startsWith('127.') &&
        !address.startsWith('fe80:') && address !== '0.0.0.0' && address !== '::' &&
        (hostname === '::' || !address.includes(':'))
      ),
    ]
    : [hostname];

  return [...new Set(hosts)].map((host) =>
    `http://${host.includes(':') ? `[${host}]` : host}:${port}`
  );
}
