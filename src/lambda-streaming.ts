import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import type { StreamifyHandler } from "aws-lambda";
import {
  assertResponseStatus,
  createErrorResponse,
  excludedResponseHeaders,
  splitResponseHeaders,
  type FetchHandler,
  type RequestOptions,
  type StreamingHandlerOptions,
} from "./shared.ts";

/** Metadata sent before an API Gateway REST API streamed response body. */
interface ApiGatewayV1Metadata {
  statusCode: number;
  headers?: Record<string, string>;
  multiValueHeaders?: Record<string, string[]>;
}

/** Metadata sent before a Lambda Function URL streamed response body. */
interface FunctionUrlMetadata {
  statusCode: number;
  headers?: Record<string, string>;
  cookies?: string[];
}

/** Streams a Fetch API `Response` through an API Gateway REST API streaming integration. */
export async function streamApiGatewayV1Response(
  response: Response,
  responseStream: awslambda.HttpResponseStream,
): Promise<void> {
  await streamResponseBody(response, responseStream, { ...createApiGatewayV1Metadata(response) });
}

/** Streams a Fetch API `Response` through a response-streaming Lambda Function URL. */
export async function streamFunctionUrlResponse(
  response: Response,
  responseStream: awslambda.HttpResponseStream,
): Promise<void> {
  await streamResponseBody(response, responseStream, { ...createFunctionUrlMetadata(response) });
}

export function validateApiGatewayV1StreamingResponse(response: Response): void {
  // Metadata construction performs all preflight checks without committing the output stream.
  createApiGatewayV1Metadata(response);
}

export function validateFunctionUrlStreamingResponse(response: Response): void {
  createFunctionUrlMetadata(response);
}

export function createStreamingHandler<TEvent>(
  createRequest: (event: TEvent, options?: RequestOptions) => Request,
  validateResponse: (response: Response) => void,
  streamResponse: (
    response: Response,
    responseStream: awslambda.HttpResponseStream,
  ) => Promise<void>,
  handler: FetchHandler<TEvent>,
  options?: StreamingHandlerOptions<TEvent>,
): StreamifyHandler<TEvent, void> {
  assertLambdaStreamingRuntime();

  return awslambda.streamifyResponse(async (event, responseStream, lambdaContext) => {
    let context = { event, lambdaContext };
    let response: Response;

    // Only failures before the first streamed byte can safely be replaced by onError.
    try {
      response = await handler(createRequest(event, options), context);
      validateResponse(response);
    } catch (error) {
      response = await createErrorResponse(options?.onError, error, context);
      // Fallback validation errors must propagate instead of recursively re-entering onError.
      validateResponse(response);
    }

    await streamResponse(response, responseStream);
  });
}

function createApiGatewayV1Metadata(response: Response): ApiGatewayV1Metadata {
  assertStreamingResponse(response);
  let { headers, cookies } = splitResponseHeaders(response, excludedResponseHeaders);
  let metadata: ApiGatewayV1Metadata = { statusCode: response.status };

  if (Object.keys(headers).length > 0) metadata.headers = headers;
  if (cookies.length > 0) metadata.multiValueHeaders = { "set-cookie": cookies };

  assertApiGatewayMetadataSize(metadata);
  return metadata;
}

function createFunctionUrlMetadata(response: Response): FunctionUrlMetadata {
  assertStreamingResponse(response);
  let { headers, cookies } = splitResponseHeaders(response, excludedResponseHeaders);
  let metadata: FunctionUrlMetadata = { statusCode: response.status };

  if (Object.keys(headers).length > 0) metadata.headers = headers;
  if (cookies.length > 0) metadata.cookies = cookies;

  return metadata;
}

function assertStreamingResponse(response: Response): void {
  assertResponseStatus(response);
  if (response.bodyUsed || response.body?.locked) {
    throw new TypeError("Response body cannot be streamed after it has been read or locked");
  }
}

async function streamResponseBody(
  response: Response,
  responseStream: awslambda.HttpResponseStream,
  metadata: Record<string, unknown>,
): Promise<void> {
  assertLambdaStreamingRuntime();
  let output = awslambda.HttpResponseStream.from(responseStream, metadata);

  if (response.body === null) {
    let completed = finished(output);
    // Lambda commits metadata on the first write, including for null or initially empty bodies.
    output.write(new Uint8Array());
    output.end();
    await completed;
    return;
  }

  // Commit metadata before waiting for a delayed web stream to produce its first chunk.
  output.write(new Uint8Array());
  await pipeline(Readable.fromWeb(response.body), output);
}

function assertApiGatewayMetadataSize(metadata: ApiGatewayV1Metadata): void {
  // The streaming prelude adds eight NUL bytes after the JSON and is capped at 16 KB.
  let byteLength = Buffer.byteLength(JSON.stringify(metadata)) + 8;
  if (byteLength > 16_384) {
    throw new RangeError("API Gateway streaming metadata must fit within the first 16 KB");
  }
}

function assertLambdaStreamingRuntime(): void {
  if (typeof awslambda === "undefined") {
    throw new ReferenceError("Lambda response streaming requires the AWS Lambda Node.js runtime");
  }
}
