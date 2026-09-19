import type {
  APIGatewayProxyStructuredResultV2,
  Context,
  LambdaFunctionURLEvent,
  StreamifyHandler,
} from "aws-lambda";
import {
  createHeaders as createApiGatewayV2Headers,
  createRequest as createApiGatewayV2Request,
  createResult as createApiGatewayV2Result,
} from "./api-gateway-v2.ts";
import {
  createStreamingHandler as createLambdaStreamingHandler,
  streamFunctionUrlResponse,
  validateFunctionUrlStreamingResponse,
} from "./lambda-streaming.ts";
import {
  createErrorResponse,
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

/** A buffered Lambda handler for a Lambda Function URL. */
export interface Handler<TEvent extends LambdaFunctionURLEvent = LambdaFunctionURLEvent> {
  (event: TEvent, context?: Context): Promise<APIGatewayProxyStructuredResultV2>;
}

/** Creates Fetch API headers from Lambda Function URL headers and cookies. */
export function createHeaders(
  headers: LambdaFunctionURLEvent["headers"],
  cookies?: readonly string[],
): Headers {
  return createApiGatewayV2Headers(headers, cookies);
}

/** Converts a Lambda Function URL event into a Fetch API `Request`. */
export function createRequest(event: LambdaFunctionURLEvent, options?: RequestOptions): Request {
  // Function URL events use the same payload shape as API Gateway v2 for HTTP conversion.
  return createApiGatewayV2Request(event, options);
}

/** Converts a Fetch API `Response` into a buffered Lambda Function URL result. */
export async function createResult(
  response: Response,
  options?: ResultOptions,
): Promise<APIGatewayProxyStructuredResultV2> {
  return createApiGatewayV2Result(response, options);
}

/** Creates a buffered Lambda handler for a Lambda Function URL. */
export function createHandler<TEvent extends LambdaFunctionURLEvent = LambdaFunctionURLEvent>(
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

/** Streams a Fetch API `Response` through a response-streaming Lambda Function URL. */
export function streamResponse(
  response: Response,
  responseStream: awslambda.HttpResponseStream,
): Promise<void> {
  return streamFunctionUrlResponse(response, responseStream);
}

/** Creates a response-streaming Lambda handler for a Lambda Function URL. */
export function createStreamingHandler<
  TEvent extends LambdaFunctionURLEvent = LambdaFunctionURLEvent,
>(
  handler: FetchHandler<TEvent>,
  options?: StreamingHandlerOptions<TEvent>,
): StreamifyHandler<TEvent, void> {
  return createLambdaStreamingHandler(
    createRequest,
    validateFunctionUrlStreamingResponse,
    streamResponse,
    handler,
    options,
  );
}
