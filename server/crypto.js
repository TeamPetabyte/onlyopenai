// AES-256-GCM helper for secret-at-rest columns such as project_api_key.
// Blob format: enc:v1:<base64(iv || ciphertext || authTag)>, iv 12 bytes, tag 16 bytes.
// Key: ENCRYPTION_KEY, 64 hex chars (32 bytes); never hardcode or commit it.

const crypto = require('crypto');

const ALG  = 'aes-256-gcm';
const IV_LEN = 12;          // 96 bits — GCM standard
const TAG_LEN = 16;         // 128 bits
const PREFIX = 'enc:v1:';

/** Parse ENCRYPTION_KEY once and cache it. */
let _keyCache = null;
function _key() {
    if (_keyCache) return _keyCache;
    const hex = (process.env.ENCRYPTION_KEY || '').trim();
    if (!hex) throw new Error('ENCRYPTION_KEY is not configured');
    if (hex.length !== 64) throw new Error('ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
    _keyCache = Buffer.from(hex, 'hex');
    if (_keyCache.length !== 32) throw new Error('ENCRYPTION_KEY decode failed');
    return _keyCache;
}

/** True if `s` looks like an encrypted blob produced by this module. */
function isEncrypted(s) {
    return typeof s === 'string' && s.startsWith(PREFIX);
}

/** Encrypt a UTF-8 string to `enc:v1:<base64>`. Already-encrypted input is returned unchanged. */
function encrypt(plaintext) {
    if (plaintext === null || plaintext === undefined) return plaintext;
    if (isEncrypted(plaintext)) return plaintext;
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALG, _key(), iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, ct, tag]).toString('base64');
}

/**
 * Decrypt a blob from `encrypt`. Non-encrypted (legacy plaintext) input is returned as-is;
 * throws on a corrupted blob (wrong key, tampering, truncation).
 */
function decrypt(blob) {
    if (blob === null || blob === undefined) return blob;
    if (!isEncrypted(blob)) return blob;       // legacy plaintext
    const b = Buffer.from(blob.slice(PREFIX.length), 'base64');
    if (b.length < IV_LEN + TAG_LEN + 1) throw new Error('encrypted blob truncated');
    const iv  = b.subarray(0, IV_LEN);
    const tag = b.subarray(b.length - TAG_LEN);
    const ct  = b.subarray(IV_LEN, b.length - TAG_LEN);
    const decipher = crypto.createDecipheriv(ALG, _key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Like decrypt, but returns null (and warns) instead of throwing. */
function tryDecrypt(blob) {
    try { return decrypt(blob); }
    catch (e) {
        console.warn('[crypto] decrypt failed:', e.message);
        return null;
    }
}

module.exports = { encrypt, decrypt, tryDecrypt, isEncrypted };
