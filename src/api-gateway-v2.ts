import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from "aws-lambda";
import {
  createErrorResponse,
  createFetchHeaders,
  createFetchRequest,
  createRequestUrl,
  serializeResponse,
  type FetchHandler,
  type HandlerOptions,
  type RequestOptions,
  type ResultOptions,
} from "./shared.ts";

export type {
  ErrorHandler,
  FetchHandler,
  FetchHandlerContext,
  HandlerOptions,
  RequestOptions,
  ResultOptions,
} from "./shared.ts";

/** A buffered Lambda handler for API Gateway HTTP API payload format v2.0. */
export interface Handler<TEvent extends APIGatewayProxyEventV2 = APIGatewayProxyEventV2> {
  (event: TEvent, context?: Context): Promise<APIGatewayProxyStructuredResultV2>;
}

/** Creates Fetch API headers from API Gateway v2 headers and cookies. */
export function createHeaders(
  headers: APIGatewayProxyEventV2["headers"],
  cookies?: readonly string[],
): Headers {
  let result = createFetchHeaders(headers);
  if (cookies !== undefined && cookies.length > 0) result.set("Cookie", cookies.join("; "));
  return result;
}

/** Converts an API Gateway HTTP API payload format v2.0 event into a Fetch API `Request`. */
export function createRequest(event: APIGatewayProxyEventV2, options?: RequestOptions): Request {
  let headers = createHeaders(event.headers, event.cookies);
  let search = event.rawQueryString === "" ? "" : `?${event.rawQueryString}`;
  let url = createRequestUrl(
    event.rawPath,
    search,
    headers,
    event.requestContext.domainName,
    options,
    true,
  );

  return createFetchRequest(
    event.requestContext.http.method,
    url,
    headers,
    event.body,
    event.isBase64Encoded,
  );
}

/** Converts a Fetch API `Response` into a buffered API Gateway v2 proxy result. */
export async function createResult(
  response: Response,
  options?: ResultOptions,
): Promise<APIGatewayProxyStructuredResultV2> {
  let serialized = await serializeResponse(response, options);
  let result: APIGatewayProxyStructuredResultV2 = {
    statusCode: serialized.statusCode,
    body: serialized.body,
    isBase64Encoded: serialized.isBase64Encoded,
  };

  if (Object.keys(serialized.headers).length > 0) result.headers = serialized.headers;
  if (serialized.cookies.length > 0) result.cookies = serialized.cookies;

  return result;
}

/** Creates a buffered Lambda handler for API Gateway HTTP API payload format v2.0. */
export function createHandler<TEvent extends APIGatewayProxyEventV2 = APIGatewayProxyEventV2>(
  handler: FetchHandler<TEvent>,
  options?: HandlerOptions<TEvent>,
): Handler<TEvent> {
  return async (event, lambdaContext) => {
    let context = { event, lambdaContext };

    try {
      let response = await handler(createRequest(event, options), context);
      return await createResult(response, options);
    } catch (error) {
      let response = await createErrorResponse(options?.onError, error, context);
      return createResult(response, options);
    }
  };
}
