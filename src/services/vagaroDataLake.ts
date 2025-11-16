import { logger } from "../utils/logger";

const BASE_URL = process.env.VAGARO_DATALAKE_URL;
const SAS = (process.env.VAGARO_DATALAKE_SAS ?? "").replace(/^\?/, "");

if (!BASE_URL || !SAS) {
  logger.warn(
    "[vagaroDataLake] VAGARO_DATALAKE_URL or VAGARO_DATALAKE_SAS not configured. Data Lake calls will fail."
  );
}

export interface DataLakePath {
  name: string;
  isDirectory: boolean;
  contentLength?: number;
  lastModified?: string;
}

interface ListPathsResponse {
  paths?: Array<{
    name: string;
    isDirectory?: boolean;
    contentLength?: number;
    lastModified?: string;
    [key: string]: unknown;
  }>;
}

/**
 * Build a URL for the filesystem-level operations (list paths).
 */
function buildFilesystemUrl(params: Record<string, string>): string {
  if (!BASE_URL || !SAS) {
    throw new Error(
      "VAGARO_DATALAKE_URL and VAGARO_DATALAKE_SAS must be set in environment variables."
    );
  }

  const qp = new URLSearchParams(params);
  const url = `${BASE_URL}?${qp.toString()}&${SAS}`;
  return url;
}

/**
 * Build a URL to download a specific file (path relative to the filesystem root).
 */
function buildFileUrl(path: string): string {
  if (!BASE_URL || !SAS) {
    throw new Error(
      "VAGARO_DATALAKE_URL and VAGARO_DATALAKE_SAS must be set in environment variables."
    );
  }

  const trimmed = path.replace(/^\/+/, "");
  const baseWithPath = `${BASE_URL}/${encodeURIComponent(trimmed)}`;
  const url = `${baseWithPath}?${SAS}`;
  return url;
}

/**
 * List paths in the Data Lake filesystem.
 *
 * If directory is provided, lists under that directory.
 * If recursive is true, returns all nested paths.
 */
export async function listDataLakePaths(
  directory?: string,
  recursive = true
): Promise<DataLakePath[]> {
  const params: Record<string, string> = {
    resource: "filesystem",
    recursive: recursive ? "true" : "false",
  };

  if (directory && directory.trim().length > 0) {
    params["directory"] = directory.trim();
  }

  const url = buildFilesystemUrl(params);

  logger.info("[vagaroDataLake] Listing Data Lake paths", {
    url,
    directory: directory ?? null,
    recursive,
  });

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-ms-version": "2020-10-02",
    },
  });

  const text = await res.text();
  let json: ListPathsResponse | null = null;

  try {
    json = text ? (JSON.parse(text) as ListPathsResponse) : null;
  } catch (err) {
    logger.error("[vagaroDataLake] Failed to parse list paths response", {
      status: res.status,
      statusText: res.statusText,
      rawBody: text,
    });
    throw new Error(
      `Failed to parse Data Lake list response: ${res.status} ${res.statusText}`
    );
  }

  if (!res.ok) {
    logger.error("[vagaroDataLake] Non-200 response from list paths", {
      status: res.status,
      statusText: res.statusText,
      body: json,
    });
    throw new Error(
      `Data Lake list paths failed: ${res.status} ${res.statusText}`
    );
  }

  const paths: DataLakePath[] =
    json?.paths?.map((p) => ({
      name: p.name,
      isDirectory: Boolean(p.isDirectory),
      contentLength: p.contentLength,
      lastModified: p.lastModified,
    })) ?? [];

  return paths;
}

/**
 * Download a file as text from the Data Lake, given its path relative to the filesystem root.
 */
export async function downloadDataLakeFile(path: string): Promise<string> {
  const url = buildFileUrl(path);

  logger.info("[vagaroDataLake] Downloading Data Lake file", {
    path,
    url,
  });

  const res = await fetch(url, {
    method: "GET",
  });

  const text = await res.text();

  if (!res.ok) {
    logger.error("[vagaroDataLake] Non-200 response when downloading file", {
      status: res.status,
      statusText: res.statusText,
      path,
      rawBody: text,
    });
    throw new Error(
      `Data Lake file download failed: ${res.status} ${res.statusText}`
    );
  }

  return text;
}
