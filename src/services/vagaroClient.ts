import { logger } from "../utils/logger";

const VAGARO_API_BASE =
  process.env.VAGARO_API_BASE ?? "https://api.vagaro.com/us03/api/v2";

const VAGARO_CLIENT_ID = process.env.VAGARO_CLIENT_ID;
const VAGARO_CLIENT_SECRET = process.env.VAGARO_CLIENT_SECRET;
const VAGARO_SCOPE = process.env.VAGARO_SCOPE ?? "read";

if (!VAGARO_CLIENT_ID || !VAGARO_CLIENT_SECRET) {
  logger.warn(
    "[vagaroClient] VAGARO_CLIENT_ID or VAGARO_CLIENT_SECRET not configured. Historical API calls will fail until set."
  );
}

interface RawTokenResponse {
  access_token?: string;
  accessToken?: string;
  token_type?: string;
  tokenType?: string;
  expires_in?: number;
  expiresIn?: number;
  scope?: string;
  [key: string]: unknown;
}

export interface VagaroAccessToken {
  token: string;
  tokenType?: string;
  expiresIn?: number;
  scope?: string;
}

/**
 * Try to find an access token anywhere in the response.
 * - Checks common fields: access_token, accessToken, token
 * - Looks under common wrappers: data, result
 * - Recursively scans nested objects for any key containing "token"
 */
function extractTokenAny(json: unknown, depth = 0): string | null {
  if (!json || typeof json !== "object") return null;
  if (depth > 5) return null; // safety guard

  const obj = json as Record<string, unknown>;

  // 1. Common direct keys
  const directKeys = ["access_token", "accessToken", "token"];
  for (const key of directKeys) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) {
      return v;
    }
  }

  // 2. Common wrappers
  for (const wrapper of ["data", "result", "value"]) {
    const nested = obj[wrapper];
    if (nested && typeof nested === "object") {
      const nestedToken = extractTokenAny(nested, depth + 1);
      if (nestedToken) return nestedToken;
    }
  }

  // 3. Any property whose key includes "token"
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && key.toLowerCase().includes("token")) {
      if (value.length > 0) return value;
    }
  }

  // 4. Recursive scan of nested objects
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      const nestedToken = extractTokenAny(value, depth + 1);
      if (nestedToken) return nestedToken;
    }
  }

  return null;
}

/**
 * Request an access token from Vagaro.
 * Mirrors the PowerShell example you got from their docs.
 */
export async function getVagaroAccessToken(): Promise<VagaroAccessToken> {
  if (!VAGARO_CLIENT_ID || !VAGARO_CLIENT_SECRET) {
    throw new Error(
      "VAGARO_CLIENT_ID and VAGARO_CLIENT_SECRET must be set in environment variables."
    );
  }

  const url = `${VAGARO_API_BASE}/merchants/generate-access-token`;

  const body = {
    clientId: VAGARO_CLIENT_ID,
    clientSecretKey: VAGARO_CLIENT_SECRET,
    scope: VAGARO_SCOPE,
  };

  logger.info("[vagaroClient] Requesting Vagaro access token", {
    url,
    scope: VAGARO_SCOPE,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const status = res.status;
  const statusText = res.statusText;
  const text = await res.text();

  let json: RawTokenResponse | null = null;

  if (text) {
    try {
      json = JSON.parse(text) as RawTokenResponse;
    } catch (parseErr) {
      logger.error("[vagaroClient] Failed to parse token response JSON", {
        status,
        statusText,
        rawBody: text,
      });
      const err = new Error(
        `Failed to parse Vagaro token response: ${status} ${statusText}`
      );
      (err as any).rawBody = text;
      throw err;
    }
  }

  if (!res.ok) {
    logger.error("[vagaroClient] Non-200 response from token endpoint", {
      status,
      statusText,
      body: json ?? text,
    });
    const err = new Error(
      `Vagaro token request failed: ${status} ${statusText}`
    );
    (err as any).rawResponse = json ?? null;
    (err as any).rawBody = text ?? null;
    throw err;
  }

  const token = extractTokenAny(json);
  if (!token) {
    logger.error(
      "[vagaroClient] Token missing in Vagaro response. Full body:",
      json ?? text
    );
    const err = new Error("Vagaro token missing in response");
    (err as any).rawResponse = json ?? null;
    (err as any).rawBody = text ?? null;
    throw err;
  }

  const tokenType = json?.token_type ?? json?.tokenType;
  const expiresIn = json?.expires_in ?? json?.expiresIn;

  logger.info("[vagaroClient] Successfully obtained Vagaro access token");

  return {
    token,
    tokenType: typeof tokenType === "string" ? tokenType : undefined,
    expiresIn: typeof expiresIn === "number" ? expiresIn : undefined,
    scope: typeof json?.scope === "string" ? json!.scope : undefined,
  };
}
