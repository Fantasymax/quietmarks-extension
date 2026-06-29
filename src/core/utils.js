(function (root) {
  "use strict";

  const QuietMarks = root.QuietMarks = root.QuietMarks || {};

  function randomId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function normalizeText(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  function normalizeUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(value);
      url.hash = "";
      if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
        url.port = "";
      }
      return url.toString();
    } catch (_) {
      return String(value).trim();
    }
  }

  function encodeBase64(bytes) {
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary);
  }

  function decodeBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function rootGuid(kind) {
    return `root:${kind}`;
  }

  function isBookmark(node) {
    return Boolean(node && node.url);
  }

  function isFolder(node) {
    return Boolean(node && !node.url);
  }

  function nodeType(node) {
    return isBookmark(node) ? "bookmark" : "folder";
  }

  QuietMarks.Utils = {
    randomId,
    nowIso,
    normalizeText,
    normalizeUrl,
    encodeBase64,
    decodeBase64,
    rootGuid,
    isBookmark,
    isFolder,
    nodeType
  };
})(globalThis);
