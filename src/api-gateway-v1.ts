import type {
  APIGatewayProxyEvent,
  APIGatewayProxyEventHeaders,
  APIGatewayProxyEventMultiValueHeaders,
  APIGatewayProxyResult,
  Context,
  StreamifyHandler,
} from "aws-lambda";
import {
  createStreamingHandler as createLambdaStreamingHandler,
  streamApiGatewayV1Response,
  validateApiGatewayV1StreamingResponse,
} from "./lambda-streaming.ts";
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
  type StreamingHandlerOptions,
} from "./shared.ts";

export type {
  ErrorHandler,
  FetchHandler,
  FetchHandlerContext,
  HandlerOptions,
  RequestOptions,
  ResultOptions,
  StreamingHandlerOptions,
} from "./shared.ts";

/** A buffered Lambda handler for API Gateway payload format v1.0. */
export interface Handler<TEvent extends APIGatewayProxyEvent = APIGatewayProxyEvent> {
  (event: TEvent, context?: Context): Promise<APIGatewayProxyResult>;
}

/** Creates Fetch API headers from API Gateway v1 single-value and multi-value headers. */
export function createHeaders(
  headers: APIGatewayProxyEventHeaders | null,
  multiValueHeaders: APIGatewayProxyEventMultiValueHeaders | null,
): Headers {
  return createFetchHeaders(headers, multiValueHeaders);
}

/** Converts an API Gateway payload format v1.0 event into a Fetch API `Request`. */
export function createRequest(event: APIGatewayProxyEvent, options?: RequestOptions): Request {
  let headers = createHeaders(event.headers, event.multiValueHeaders);
  let url = createRequestUrl(
    event.path,
    createSearch(event),
    headers,
    event.requestContext.domainName ?? "",
    options,
  );

  return createFetchRequest(event.httpMethod, url, headers, event.body, event.isBase64Encoded);
}

/** Converts a Fetch API `Response` into a buffered API Gateway v1 proxy result. */
export async function createResult(
  response: Response,
  options?: ResultOptions,
): Promise<APIGatewayProxyResult> {
  let serialized = await serializeResponse(response, options);
  let result: APIGatewayProxyResult = {
    statusCode: serialized.statusCode,
    body: serialized.body,
    isBase64Encoded: serialized.isBase64Encoded,
  };

  if (Object.keys(serialized.headers).length > 0) result.headers = serialized.headers;
  if (serialized.cookies.length > 0) {
    result.multiValueHeaders = { "set-cookie": serialized.cookies };
  }

  return result;
}

/** Creates a buffered Lambda handler for API Gateway payload format v1.0. */
export function createHandler<TEvent extends APIGatewayProxyEvent = APIGatewayProxyEvent>(
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

/** Streams a Fetch API `Response` through an API Gateway REST API streaming integration. */
export function streamResponse(
  response: Response,
  responseStream: awslambda.HttpResponseStream,
): Promise<void> {
  return streamApiGatewayV1Response(response, responseStream);
}

/** Creates a response-streaming Lambda handler for an API Gateway REST API. */
export function createStreamingHandler<TEvent extends APIGatewayProxyEvent = APIGatewayProxyEvent>(
  handler: FetchHandler<TEvent>,
  options?: StreamingHandlerOptions<TEvent>,
): StreamifyHandler<TEvent, void> {
  return createLambdaStreamingHandler(
    createRequest,
    validateApiGatewayV1StreamingResponse,
    streamResponse,
    handler,
    options,
  );
}

function createSearch(event: APIGatewayProxyEvent): string {
  let search = new URLSearchParams();
  let multiValueNames = new Set<string>();

  // As with headers, the multi-value map wins when API Gateway populates both representations.
  for (let [name, values] of Object.entries(event.multiValueQueryStringParameters ?? {})) {
    if (values === undefined) continue;
    multiValueNames.add(name);
    for (let value of values) search.append(name, value);
  }

  for (let [name, value] of Object.entries(event.queryStringParameters ?? {})) {
    if (value === undefined || multiValueNames.has(name)) continue;
    search.append(name, value);
  }

  let value = search.toString();
  return value === "" ? "" : `?${value}`;
}
