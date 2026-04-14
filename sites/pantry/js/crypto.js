const ITERATIONS = 600_000;
const KEY_LENGTH = 256;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export async function encryptToken(token, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    textEncoder.encode(token)
  );

  return {
    algorithm: "PBKDF2-AES-GCM-256",
    iterations: ITERATIONS,
    saltBase64: bytesToBase64(salt),
    ivBase64: bytesToBase64(iv),
    cipherTextBase64: bytesToBase64(new Uint8Array(cipherBuffer)),
  };
}

export async function decryptToken(tokenEnvelope, passphrase) {
  if (!tokenEnvelope || tokenEnvelope.algorithm !== "PBKDF2-AES-GCM-256") {
    throw new Error("저장된 토큰 형식을 해석하지 못했습니다.");
  }

  const salt = base64ToBytes(tokenEnvelope.saltBase64);
  const iv = base64ToBytes(tokenEnvelope.ivBase64);
  const cipherBytes = base64ToBytes(tokenEnvelope.cipherTextBase64);
  const key = await deriveKey(passphrase, salt, tokenEnvelope.iterations ?? ITERATIONS);

  try {
    const plainBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      cipherBytes
    );
    return textDecoder.decode(plainBuffer);
  } catch (error) {
    throw new Error("잠금 해제에 실패했습니다. passphrase를 다시 확인하세요.");
  }
}

async function deriveKey(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    material,
    {
      name: "AES-GCM",
      length: KEY_LENGTH,
    },
    false,
    ["encrypt", "decrypt"]
  );
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
