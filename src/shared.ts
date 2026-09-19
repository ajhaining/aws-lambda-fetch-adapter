import zlib from "node:zlib";
import type { Context } from "aws-lambda";

/** Context passed to a Fetch handler for the current Lambda invocation. */
export interface FetchHandlerContext<TEvent> {
  event: TEvent;
  lambdaContext: Context | undefined;
}

/** A function that handles an AWS HTTP event using Fetch API primitives. */
export interface FetchHandler<TEvent = unknown> {
  (request: Request, context: FetchHandlerContext<TEvent>): Response | Promise<Response>;
}

/** Handles an error with a response, uses the default 500 by returning nothing, or propagates by throwing. */
export interface ErrorHandler<TEvent = unknown> {
  (
    error: unknown,
    context: FetchHandlerContext<TEvent>,
  ): void | Response | Promise<void | Response>;
}

/** Options for converting an AWS HTTP event into a Fetch API `Request`. */
export interface RequestOptions {
  /** Overrides the URL origin inferred from forwarded headers, `Host`, and the request context. */
  origin?: string;
}

/** Options for converting a Fetch API `Response` into a buffered Lambda result. */
export interface ResultOptions {
  /**
   * Content types that should be base64-encoded. Supports exact values and wildcards such as
   * `image/*` and `*\/*`.
   * @defaultValue `[]`
   */
  binaryMediaTypes?: readonly string[];
}

/** Options for creating a buffered AWS HTTP request handler. */
export interface HandlerOptions<TEvent = unknown> extends RequestOptions, ResultOptions {
  /** Handles errors from request conversion, the Fetch handler, or response conversion. */
  onError?: ErrorHandler<TEvent>;
}

/** Options for creating a streaming AWS HTTP request handler. */
export interface StreamingHandlerOptions<TEvent = unknown> extends RequestOptions {
  /** Handles request conversion, Fetch handler, and response validation errors before streaming. */
  onError?: ErrorHandler<TEvent>;
}

type SingleValueHeaders = Record<string, string | undefined>;
type MultiValueHeaders = Record<string, string[] | undefined>;

// Match native Fetch decoding, including the Undici version bundled with Node.
const decodedContentEncodings = new Set(["gzip", "x-gzip", "deflate", "br"]);
const [undiciMajor = 0, undiciMinor = 0] = (process.versions.undici ?? "").split(".").map(Number);
// Undici added zstd decoding in 7.11; Node 22's Undici 6 leaves it encoded.
if (
  (undiciMajor > 7 || (undiciMajor === 7 && undiciMinor >= 11)) &&
  typeof zlib.createZstdDecompress === "function"
) {
  decodedContentEncodings.add("zstd");
}

// Lambda and API Gateway own response framing, so these transport-level headers must not leak through.
export const excludedResponseHeaders = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface SerializedResponse {
  statusCode: number;
  headers: Record<string, string>;
  cookies: string[];
  body: string;
  isBase64Encoded: boolean;
}

/** Merges single-value and multi-value headers into Fetch API headers. */
export function createFetchHeaders(
  headers: SingleValueHeaders | null | undefined,
  multiValueHeaders?: MultiValueHeaders | null,
): Headers {
  let result = new Headers();
  let multiValueNames = new Set<string>();

  // API Gateway v1 can repeat a header in both maps; the multi-value map is authoritative.
  for (let [name, values] of Object.entries(multiValueHeaders ?? {})) {
    if (values === undefined) continue;
    multiValueNames.add(name.toLowerCase());

    if (name.toLowerCase() === "cookie") {
      result.append(name, values.join("; "));
      continue;
    }

    for (let value of values) result.append(name, value);
  }

  for (let [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined || multiValueNames.has(name.toLowerCase())) continue;
    result.append(name, value);
  }

  return result;
}

export function createFetchRequest(
  method: string,
  url: URL,
  headers: Headers,
  body: string | null | undefined,
  isBase64Encoded: boolean,
): Request {
  method = method.toUpperCase();

  if (method === "GET" || method === "HEAD" || body == null) {
    return new Request(url, { method, headers });
  }

  // A string body makes Request invent a text/plain content type when AWS supplied none.
  let requestBody = isBase64Encoded ? decodeBase64(body) : new TextEncoder().encode(body);
  return new Request(url, { method, headers, body: requestBody });
}

export function createRequestUrl(
  path: string,
  search: string,
  headers: Headers,
  domainName: string,
  options?: RequestOptions,
  rawPath = false,
): URL {
  let origin = options?.origin;

  if (origin === undefined) {
    let host = firstHeaderValue(headers.get("X-Forwarded-Host"));
    host ??= firstHeaderValue(headers.get("Host"));
    host ??= domainName || undefined;

    if (host === undefined) {
      throw new TypeError(
        "Cannot create an AWS request URL without an origin, Host header, or request context domain name",
      );
    }

    let protocol = firstHeaderValue(headers.get("X-Forwarded-Proto")) ?? "https";
    origin = `${protocol.replace(/:$/, "")}://${host}`;
  }

  let originUrl = new URL(origin);
  let pathname = path.startsWith("/") ? path : `/${path}`;

  // v2 supplies the raw path/query; preserve escapes and query ordering rather than rebuilding them.
  if (rawPath) return new URL(`${originUrl.origin}${pathname}${search}`);

  // In v1 a literal ? or # in the event path must stay in the pathname, not become a URL delimiter.
  let url = new URL(originUrl.origin);
  url.pathname = pathname;
  url.search = search;
  return url;
}

export async function serializeResponse(
  response: Response,
  options?: ResultOptions,
): Promise<SerializedResponse> {
  assertResponseStatus(response);
  let { headers, cookies } = splitResponseHeaders(response, excludedResponseHeaders);
  let isBase64Encoded = isBinaryContentType(
    response.headers.get("Content-Type"),
    options?.binaryMediaTypes ?? [],
  );
  // Buffered AWS proxy integrations represent binary response bytes as base64 text.
  let body = isBase64Encoded
    ? encodeBase64(new Uint8Array(await response.arrayBuffer()))
    : await response.text();

  return {
    statusCode: response.status,
    headers,
    cookies,
    body,
    isBase64Encoded,
  };
}

export function splitResponseHeaders(
  response: Response,
  excludedNames: ReadonlySet<string> = new Set(),
): { headers: Record<string, string>; cookies: string[] } {
  let headers: Record<string, string> = {};
  let contentEncodings = response.headers.get("content-encoding")?.toLowerCase().split(",");
  let hasDecodedBody =
    (response.type === "basic" || response.type === "cors") &&
    response.body !== null &&
    contentEncodings?.every((encoding) => decodedContentEncodings.has(encoding.trim()));

  // Connection can nominate additional hop-by-hop headers beyond the standard fixed set.
  let connectionHeaders = new Set(
    response.headers
      .get("connection")
      ?.split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );

  for (let [name, value] of response.headers) {
    if (name === "set-cookie" || excludedNames.has(name) || connectionHeaders.has(name)) continue;

    // Fetch retains Content-Encoding after decoding, but skips decoding if any coding is unknown.
    // Constructed responses and bodyless responses (e.g. HEAD/304) retain their encoding metadata.
    if (hasDecodedBody && name === "content-encoding") continue;

    // defineProperty keeps names such as "__proto__" as ordinary own properties.
    Object.defineProperty(headers, name, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }

  // Set-Cookie cannot be comma-joined (Expires dates contain commas), but still obeys exclusions.
  let cookies =
    excludedNames.has("set-cookie") || connectionHeaders.has("set-cookie")
      ? []
      : response.headers.getSetCookie();
  return { headers, cookies };
}

export function assertResponseStatus(response: Response): void {
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new RangeError(
      `Response status must be between 100 and 599, received ${response.status}`,
    );
  }
}

export async function createErrorResponse<TEvent>(
  onError: ErrorHandler<TEvent> | undefined,
  error: unknown,
  context: FetchHandlerContext<TEvent>,
): Promise<Response> {
  if (onError === undefined) {
    console.error(error);
    return internalServerError();
  }

  return (await onError(error, context)) ?? internalServerError();
}

function firstHeaderValue(value: string | null): string | undefined {
  if (value === null) return undefined;
  let first = value.split(",", 1)[0]?.trim();
  return first === "" ? undefined : first;
}

function isBinaryContentType(
  contentType: string | null,
  binaryMediaTypes: readonly string[],
): boolean {
  let mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();

  for (let pattern of binaryMediaTypes) {
    let normalizedPattern = pattern.split(";", 1)[0]?.trim().toLowerCase();

    if (normalizedPattern === "*/*") return true;
    if (mediaType === undefined || normalizedPattern === undefined) continue;
    if (normalizedPattern === mediaType) return true;

    let slashIndex = normalizedPattern.indexOf("/");
    if (slashIndex === -1 || normalizedPattern.slice(slashIndex + 1) !== "*") continue;
    if (mediaType.startsWith(`${normalizedPattern.slice(0, slashIndex)}/`)) return true;
  }

  return false;
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  let binary = atob(value);
  let bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  // Avoid exceeding the engine's argument limit by spreading the response in bounded chunks.
  let chunkSize = 32_768;
  let chunks: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    let end = Math.min(offset + chunkSize, bytes.length);
    chunks.push(String.fromCharCode(...bytes.subarray(offset, end)));
  }

  return btoa(chunks.join(""));
}

function internalServerError(): Response {
  return new Response("Internal Server Error", {
    status: 500,
    headers: { "Content-Type": "text/plain" },
  });
}
