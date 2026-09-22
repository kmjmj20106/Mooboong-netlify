import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password, encoded) {
  try {
    const [algorithm, salt, expected] = encoded.split('$');
    if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(expected)) return false;
    const actual = scryptSync(String(password), salt, 64);
    return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
  } catch { return false; }
}

export const randomToken = () => randomBytes(32).toString('base64url');
export const tokenHash = token => createHash('sha256').update(String(token)).digest('hex');

export function readCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => {
    const index = part.indexOf('=');
    if (index < 1) return ['', ''];
    return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }).filter(([key]) => key));
}
