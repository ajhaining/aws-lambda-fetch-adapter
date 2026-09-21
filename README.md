# AWS Lambda Fetch Adapter

Use standard Fetch API `Request` and `Response` objects with AWS Lambda HTTP integrations.

## Installation

```sh
npm install aws-lambda-fetch-adapter
```

The package is ESM-only and requires Node.js 22 or later.

## Integrations

| Integration                         | Entry point                               | Response modes         |
| ----------------------------------- | ----------------------------------------- | ---------------------- |
| API Gateway REST API / payload v1.0 | `aws-lambda-fetch-adapter/api-gateway-v1` | Buffered and streaming |
| API Gateway HTTP API / payload v1.0 | `aws-lambda-fetch-adapter/api-gateway-v1` | Buffered               |
| API Gateway HTTP API / payload v2.0 | `aws-lambda-fetch-adapter/api-gateway-v2` | Buffered               |
| Lambda Function URL                 | `aws-lambda-fetch-adapter/function-url`   | Buffered and streaming |

## Buffered Responses

```ts
import { createHandler } from "aws-lambda-fetch-adapter/api-gateway-v1";

export const handler = createHandler(async (request, context) => {
  return Response.json({
    method: request.method,
    path: new URL(request.url).pathname,
    requestId: context.lambdaContext?.awsRequestId,
  });
});
```

Use the same `createHandler` API from the API Gateway v2 or Function URL entry point.

Buffered responses are read as UTF-8 text by default. To preserve binary bytes, configure `binaryMediaTypes`; matching responses are base64-encoded:

```ts
export const handler = createHandler(fetchHandler, {
  binaryMediaTypes: ["image/*", "application/octet-stream"],
});
```

Use `["*/*"]` to base64-encode every response, including bodies with no content type. This also preserves intentionally compressed response bodies, even when their content type is textual.

For REST APIs, also configure [API Gateway binary media types](https://docs.aws.amazon.com/apigateway/latest/developerguide/lambda-proxy-binary-media.html). API Gateway uses the first media type in the client's `Accept` header when deciding how to return binary data; `*/*` is useful when you cannot control that order. HTTP APIs and Function URLs do not need this infrastructure setting.

## Streaming Responses

```ts
import { createStreamingHandler } from "aws-lambda-fetch-adapter/function-url";

export const handler = createStreamingHandler(() => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
      controller.close();
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
});
```

Streaming is available for Lambda Function URLs and API Gateway REST APIs. The infrastructure must also enable it:

- Function URL: set `InvokeMode` to `RESPONSE_STREAM`.
- REST API: use a Lambda proxy integration with `ResponseTransferMode: STREAM` and the Lambda response-streaming invocation URI.

API Gateway HTTP APIs do not support Lambda response streaming.

Streaming requires the `awslambda` global supplied by the Lambda Node.js runtime. Bodies are sent as raw bytes, so `binaryMediaTypes` is not a streaming option. For REST APIs, response status, headers, cookies, and the metadata delimiter must fit within the first 16 KB. See the [REST API streaming setup](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode-lambda.html) for the invocation URI and metadata format.

## Errors

Without `onError`, factory-created handlers log caught errors and return a plain-text 500 response. Use `onError` to control error handling:

- Return a `Response` to handle the error.
- Return nothing to use the same 500 response without automatic logging.
- Throw or reject to propagate the error to Lambda or an outer wrapper.

```ts
export const handler = createHandler(fetchHandler, {
  onError(error) {
    console.error(error);
    return Response.json({ message: "Request failed" }, { status: 500 });
  },
});
```

Buffered handlers catch request conversion, Fetch handler, and response conversion errors, including body-reading errors. Streaming handlers catch request conversion, Fetch handler, and response validation errors before streaming; later stream errors propagate to Lambda. Failures in `onError` or validation of its returned response propagate without calling it again. Lower-level conversion and streaming functions propagate errors directly.

## Conversion Behavior

- `context.event` is the original AWS event, including authorizer data. `context.lambdaContext` is the invocation context when supplied. The handler factories accept a generic event type to retain custom authorizer typing.
- The request origin comes from `X-Forwarded-Host`, then `Host`, then `requestContext.domainName`, with `X-Forwarded-Proto` or HTTPS as the protocol. Set `{ origin: "https://example.com" }` when your application needs a fixed origin. This overrides only the origin, not the path or headers.
- Paths come from the event; stage names and custom-domain mapping prefixes are not added. Payload v1 query parameters are reconstructed from AWS's parsed maps, so original query ordering/escaping cannot be recovered. Payload v2 uses `rawPath` and `rawQueryString`.
- Fetch forbids GET/HEAD request bodies, so those event bodies are ignored. Other base64-encoded event bodies are decoded to bytes; plain event bodies are UTF-8 encoded without adding a content type.
- Response hop-by-hop headers and `Content-Length` are removed so AWS can frame the response. Separate `Set-Cookie` values are preserved in each integration's cookie representation.
- Native Node.js `fetch()` decodes supported content encodings but retains the upstream header. The adapter removes stale `Content-Encoding` for those responses. A newly constructed `Response` retains its explicit encoding header; if you wrap a decoded upstream body in a new response, remove the stale encoding header yourself.

## API

| Entry point      | Runtime exports                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `api-gateway-v1` | `createHandler`, `createStreamingHandler`, `createHeaders`, `createRequest`, `createResult`, `streamResponse` |
| `api-gateway-v2` | `createHandler`, `createHeaders`, `createRequest`, `createResult`                                             |
| `function-url`   | `createHandler`, `createStreamingHandler`, `createHeaders`, `createRequest`, `createResult`, `streamResponse` |

Choose an integration-specific import; the package root intentionally has no adapter export. The consistent function names let applications switch integrations without a runtime event-detection API.

Each entry point also exports its `Handler` type and the shared `ErrorHandler`, `FetchHandler`, `FetchHandlerContext`, `HandlerOptions`, `RequestOptions`, and `ResultOptions` types. The streaming entry points additionally export `StreamingHandlerOptions`.

The lower-level conversion and streaming functions are useful when an application owns the Lambda handler lifecycle. TypeScript applications should install `@types/node` for their runtime to provide the Node.js and Fetch global types.
