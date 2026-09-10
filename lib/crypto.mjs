const encoder = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (text) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
async function key(secret) {
  if (!secret || unb64(secret).length !== 32) throw new Error("Secure settings storage is unavailable.");
  return crypto.subtle.importKey("raw", unb64(secret), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(value, userId, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(userId) },
    await key(secret), encoder.encode(JSON.stringify(value)));
  return `${b64(iv)}.${b64(new Uint8Array(bytes))}`;
}
export async function unseal(value, userId, secret) {
  const [iv, ciphertext] = value.split(".");
  const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: encoder.encode(userId) },
    await key(secret), unb64(ciphertext));
  return JSON.parse(new TextDecoder().decode(bytes));
}
