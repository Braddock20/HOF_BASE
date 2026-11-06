
import type { Env } from "./types";

type B2Auth = {
  apiUrl: string;
  downloadUrl: string;
  authorizationToken: string;
};

let cachedAuth: {
  value: B2Auth;
  expiresAt: number;
} | null = null;

function configured(env: Env): boolean {
  return !!(
    env.B2_ACCOUNT_ID &&
    env.B2_APPLICATION_KEY_ID &&
    env.B2_APPLICATION_KEY &&
    env.B2_BUCKET_ID &&
    env.B2_BUCKET_NAME
  );
}

async function authorize(env: Env): Promise<B2Auth> {
  if (!configured(env)) {
    throw new Error("Private B2 storage is not configured");
  }

  if (
    cachedAuth &&
    cachedAuth.expiresAt > Date.now() + 60_000
  ) {
    return cachedAuth.value;
  }

  const basic = btoa(
    `${env.B2_APPLICATION_KEY_ID}:${env.B2_APPLICATION_KEY}`
  );

  const response = await fetch(
    "https://api.backblazeb2.com/b2api/v3/b2_authorize_account",
    {
      method: "GET",
      headers: {
        Authorization: `Basic ${basic}`
      },
      signal: AbortSignal.timeout(12000)
    }
  );

  if (!response.ok) {
    throw new Error(
      `B2 authorization failed (${response.status})`
    );
  }

  const data = await response.json() as any;

  // B2 v3 returns storage endpoints inside apiInfo.storageApi.
  // Also accept the older flat structure for compatibility.
  const storageApi = data.apiInfo?.storageApi;

  const rawApiUrl =
    storageApi?.apiUrl ?? data.apiUrl;

  const rawDownloadUrl =
    storageApi?.downloadUrl ?? data.downloadUrl;

  const authorizationToken = data.authorizationToken;

  if (
    typeof rawApiUrl !== "string" ||
    typeof rawDownloadUrl !== "string" ||
    typeof authorizationToken !== "string"
  ) {
    throw new Error(
      "B2 authorization response is missing storage API details"
    );
  }

  const apiUrl = new URL(rawApiUrl);
  const downloadUrl = new URL(rawDownloadUrl);

  if (
    apiUrl.protocol !== "https:" ||
    downloadUrl.protocol !== "https:"
  ) {
    throw new Error(
      "B2 returned an invalid storage endpoint"
    );
  }

  const value: B2Auth = {
    apiUrl: apiUrl.origin,
    downloadUrl: downloadUrl.origin,
    authorizationToken
  };

  // B2 authorization tokens are valid for at most 24 hours.
  // Refresh our cached authorization before that limit.
  cachedAuth = {
    value,
    expiresAt: Date.now() + 20 * 60 * 60 * 1000
  };

  return value;
}

export function b2Configured(env: Env): boolean {
  return configured(env);
}

export async function fetchPrivateB2Object(
  env: Env,
  objectKey: string,
  range?: string
): Promise<Response> {
  const encodedKey = objectKey
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  const makeRequest = async (
    auth: B2Auth
  ): Promise<Response> => {
    const url =
      `${auth.downloadUrl}/file/` +
      `${encodeURIComponent(env.B2_BUCKET_NAME!)}/` +
      encodedKey;

    const headers = new Headers({
      Authorization: auth.authorizationToken
    });

    if (range) {
      headers.set("Range", range);
    }

    return fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(25000)
    });
  };

  let auth = await authorize(env);
  let response = await makeRequest(auth);

  if (response.status === 401) {
    cachedAuth = null;
    auth = await authorize(env);
    response = await makeRequest(auth);
  }

  return response;
}

export async function uploadPrivateB2Object(
  env: Env,
  objectKey: string,
  file: File
) {
  let auth = await authorize(env);

  const requestUploadUrl = async (
    currentAuth: B2Auth
  ): Promise<Response> => {
    const endpoint =
      `${currentAuth.apiUrl}/b2api/v3/b2_get_upload_url`;

    return fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: currentAuth.authorizationToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        bucketId: env.B2_BUCKET_ID
      }),
      signal: AbortSignal.timeout(15000)
    });
  };

  let uploadUrlResponse = await requestUploadUrl(auth);

  if (uploadUrlResponse.status === 401) {
    cachedAuth = null;
    auth = await authorize(env);
    uploadUrlResponse = await requestUploadUrl(auth);
  }

  if (!uploadUrlResponse.ok) {
    throw new Error(
      `B2 upload URL request failed (${uploadUrlResponse.status})`
    );
  }

  const uploadInfo = await uploadUrlResponse.json() as any;

  if (
    typeof uploadInfo.uploadUrl !== "string" ||
    typeof uploadInfo.authorizationToken !== "string"
  ) {
    throw new Error(
      "B2 returned an invalid upload URL response"
    );
  }

  const bytes = await file.arrayBuffer();

  const digest = await crypto.subtle.digest(
    "SHA-1",
    bytes
  );

  const sha1 = [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");

  const uploadResponse = await fetch(
    uploadInfo.uploadUrl,
    {
      method: "POST",
      headers: {
        Authorization: uploadInfo.authorizationToken,
        "X-Bz-File-Name": encodeURIComponent(objectKey),
        "Content-Type": file.type || "b2/x-auto",
        "X-Bz-Content-Sha1": sha1
      },
      body: bytes,
      signal: AbortSignal.timeout(60000)
    }
  );

  if (!uploadResponse.ok) {
    throw new Error(
      `B2 upload failed (${uploadResponse.status})`
    );
  }

  const result = await uploadResponse.json() as any;

  if (!result.fileId) {
    throw new Error("B2 upload response is missing file ID");
  }

  return {
    fileId: String(result.fileId),
    objectKey,
    size: file.size,
    mimeType: file.type || "application/octet-stream",
    sha1
  };
}

export async function deletePrivateB2Object(
  env: Env,
  fileId: string,
  objectKey: string
): Promise<void> {
  let auth = await authorize(env);

  const deleteRequest = async (
    currentAuth: B2Auth
  ): Promise<Response> => {
    return fetch(
      `${currentAuth.apiUrl}/b2api/v3/b2_delete_file_version`,
      {
        method: "POST",
        headers: {
          Authorization: currentAuth.authorizationToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          fileId,
          fileName: objectKey
        }),
        signal: AbortSignal.timeout(20000)
      }
    );
  };

  let response = await deleteRequest(auth);

  if (response.status === 401) {
    cachedAuth = null;
    auth = await authorize(env);
    response = await deleteRequest(auth);
  }

  if (!response.ok && response.status !== 404) {
    throw new Error(
      `B2 delete failed (${response.status})`
    );
  }
}
