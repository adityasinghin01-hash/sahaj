// Public server origin only. HTTP is restricted to private/loopback IPs in development.
export function validateServerAddress(input: string, development = __DEV__): string {
  const url = new URL(input.trim());
  const parts = url.hostname.split('.').map(Number);
  const ipv4 = parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
  const local = ['localhost', '[::1]'].includes(url.hostname) || (ipv4 && (
    parts[0] === 127 || parts[0] === 10 ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 169 && parts[1] === 254)
  ));
  if (url.protocol !== 'https:' && !(development && url.protocol === 'http:' && local))
    throw new Error('Use HTTPS. Local HTTP addresses are allowed only in development.');
  if (!url.hostname || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname))
    throw new Error('Enter only the server address, without a path, login or query.');
  return url.origin;
}
