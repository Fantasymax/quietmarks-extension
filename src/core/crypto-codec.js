(function (root) {
  "use strict";

  const QuietMarks = root.QuietMarks = root.QuietMarks || {};
  const { PBKDF2_ITERATIONS } = QuietMarks.Constants;
  const { encodeBase64, decodeBase64 } = QuietMarks.Utils;

  class CryptoCodec {
    constructor(options) {
      this.iterations = options && options.iterations ? options.iterations : PBKDF2_ITERATIONS;
    }

    async deriveKey(passphrase, salt) {
      const encoder = new TextEncoder();
      const baseKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(passphrase),
        "PBKDF2",
        false,
        ["deriveKey"]
      );
      return crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          salt,
          iterations: this.iterations,
          hash: "SHA-256"
        },
        baseKey,
        {
          name: "AES-GCM",
          length: 256
        },
        false,
        ["encrypt", "decrypt"]
      );
    }

    async encryptState(state, passphrase) {
      if (!passphrase) return state;

      const encoder = new TextEncoder();
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await this.deriveKey(passphrase, salt);
      const payload = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv
        },
        key,
        encoder.encode(JSON.stringify(state))
      );

      return {
        quietmarks: 1,
        encrypted: true,
        kdf: "PBKDF2-SHA256",
        iterations: this.iterations,
        cipher: "AES-GCM",
        salt: encodeBase64(salt),
        iv: encodeBase64(iv),
        payload: encodeBase64(new Uint8Array(payload))
      };
    }

    async decryptState(envelope, passphrase) {
      if (!envelope || !envelope.encrypted) return envelope;
      if (!passphrase) {
        throw new Error("Remote state is encrypted. Enter the same encryption passphrase on this browser.");
      }

      const key = await this.deriveKey(passphrase, decodeBase64(envelope.salt));
      const decrypted = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decodeBase64(envelope.iv)
        },
        key,
        decodeBase64(envelope.payload)
      );
      return JSON.parse(new TextDecoder().decode(decrypted));
    }
  }

  QuietMarks.CryptoCodec = CryptoCodec;
})(globalThis);
