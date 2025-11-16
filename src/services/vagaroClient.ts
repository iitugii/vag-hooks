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
 * Request an access token from Vagaro.
 * This is the TS/Node equivalent of the PowerShell sample you pasted.
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

  const text = await res.text();
  let json: RawTokenResponse;

  try {
    json = text ? (JSON.parse(text) as RawTokenResponse) : {};
  } catch (err) {
    logger.error("[vagaroClient] Failed to parse token response JSON", {
      status: res.status,
      statusText: res.statusText,
      rawBody: text,
    });
    throw new Error(
      `Failed to parse Vagaro token response: ${res.status} ${res.statusText}`
    );
  }

  if (!res.ok) {
    logger.error("[vagaroClient] Non-200 response from token endpoint", {
      status: res.status,
      statusText: res.statusText,
      body: json,
    });
    throw new Error(
      `Vagaro token request failed: ${res.status} ${res.statusText}`
    );
  }

  const token =
    json.access_token ??
    json.accessToken ??
    (json as Record<string, unknown>).token;

  if (!token || typeof token !== "string") {
    logger.error(
      "[vagaroClient] Token missing in Vagaro response. Full body:",
      json
    );
    throw new Error("Vagaro token missing in response");
  }

  const tokenType = json.token_type ?? json.tokenType;
  const expiresIn = json.expires_in ?? json.expiresIn;

  logger.info("[vagaroClient] Successfully obtained Vagaro access token");

  return {
    token,
    tokenType: typeof tokenType === "string" ? tokenType : undefined,
    expiresIn: typeof expiresIn === "number" ? expiresIn : undefined,
    scope: typeof json.scope === "string" ? json.scope : undefined,
  };
}
