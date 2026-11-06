import type { Env } from "./types";

type B2Auth = { apiUrl: string; downloadUrl: string; authorizationToken: string; };
let cachedAuth: { value: B2Auth; expiresAt: number } | null = null;

function configured(env: Env) {
  return !!(env.B2_ACCOUNT_ID && env.B2_APPLICATION_KEY_ID && env.B2_APPLICATION_KEY && env.B2_BUCKET_ID && env.B2_BUCKET_NAME);
}
async function authorize(env: Env): Promise<B2Auth> {
  if (!configured(env)) throw new Error("Private B2 storage is not configured");
  if (cachedAuth && cachedAuth.expiresAt > Date.now() + 60_000) return cachedAuth.value;
  const basic = btoa(`${env.B2_APPLICATION_KEY_ID}:${env.B2_APPLICATION_KEY}`);
  const r = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    headers: { Authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(12000)
  });
  if (!r.ok) throw new Error(`B2 authorization failed (${r.status})`);
  const j = await r.json() as any;
  const value: B2Auth = { apiUrl: j.apiUrl, downloadUrl: j.downloadUrl, authorizationToken: j.authorizationToken };
  cachedAuth = { value, expiresAt: Date.now() + 20 * 60 * 60 * 1000 };
  return value;
}
export function b2Configured(env: Env) { return configured(env); }

export async function fetchPrivateB2Object(env: Env, objectKey: string, range?: string): Promise<Response> {
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
  const makeRequest = async (auth: B2Auth) => {
    const url = `${auth.downloadUrl}/file/${encodeURIComponent(env.B2_BUCKET_NAME!)}/${encodedKey}`;
    const headers = new Headers({ Authorization: auth.authorizationToken });
    if (range) headers.set("Range", range);
    return fetch(url, { headers, signal: AbortSignal.timeout(25000) });
  };
  let auth = await authorize(env);
  let r = await makeRequest(auth);
  if (r.status === 401) {
    cachedAuth = null;
    auth = await authorize(env);
    r = await makeRequest(auth);
  }
  return r;
}

export async function uploadPrivateB2Object(env: Env, objectKey: string, file: File) {
  const auth = await authorize(env);
  const endpoint = `${auth.apiUrl}/b2api/v3/b2_get_upload_url`;
  const u = await fetch(endpoint, {
    method: "POST", headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" },
    body: JSON.stringify({ bucketId: env.B2_BUCKET_ID })
  });
  if (!u.ok) throw new Error(`B2 upload URL request failed (${u.status})`);
  const up = await u.json() as any;
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  const sha1 = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
  const r = await fetch(up.uploadUrl, {
    method: "POST",
    headers: {
      Authorization: up.authorizationToken,
      "X-Bz-File-Name": encodeURIComponent(objectKey),
      "Content-Type": file.type || "b2/x-auto",
      "X-Bz-Content-Sha1": sha1
    },
    body: bytes
  });
  if (!r.ok) throw new Error(`B2 upload failed (${r.status})`);
  const result = await r.json() as any;
  return { fileId: String(result.fileId), objectKey, size: file.size, mimeType: file.type || "application/octet-stream", sha1 };
}

export async function deletePrivateB2Object(env: Env, fileId: string, objectKey: string) {
  const auth = await authorize(env);
  const r = await fetch(`${auth.apiUrl}/b2api/v3/b2_delete_file_version`, {
    method: "POST", headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" },
    body: JSON.stringify({ fileId, fileName: objectKey })
  });
  if (!r.ok && r.status !== 404) throw new Error(`B2 delete failed (${r.status})`);
}
