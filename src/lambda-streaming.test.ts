import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, it } from "node:test";
import type { APIGatewayProxyEvent, APIGatewayProxyEventV2, Context } from "aws-lambda";
import {
  createStreamingHandler as createApiGatewayV1StreamingHandler,
  streamResponse as streamApiGatewayV1Response,
} from "./api-gateway-v1.ts";
import {
  createStreamingHandler as createLambdaFunctionUrlStreamingHandler,
  streamResponse as streamFunctionUrlResponse,
} from "./function-url.ts";

let originalAwsLambda = Object.getOwnPropertyDescriptor(globalThis, "awslambda");

afterEach(() => {
  if (originalAwsLambda === undefined) delete (globalThis as Record<string, unknown>).awslambda;
  else Object.defineProperty(globalThis, "awslambda", originalAwsLambda);
});

describe("streamApiGatewayV1Response", () => {
  it("streams raw bytes with v1 metadata and multi-value cookies", async () => {
    let runtime = installStreamingRuntime();
    let output = createOutput();
    let headers = new Headers({
      "Content-Type": "application/octet-stream",
      "Content-Length": "4",
      Connection: "keep-alive, X-Private",
      "X-Private": "removed",
      "X-Request-Id": "abc",
    });
    headers.append("Set-Cookie", "a=1; Expires=Wed, 21 Oct 2030 07:28:00 GMT");
    headers.append("Set-Cookie", "b=2; Path=/");

    await streamApiGatewayV1Response(
      new Response(new Uint8Array([0, 255, 128, 64]), { status: 206, headers }),
      output.stream as unknown as awslambda.HttpResponseStream,
    );

    assert.deepEqual(runtime.metadata, {
      statusCode: 206,
      headers: {
        "content-type": "application/octet-stream",
        "x-request-id": "abc",
      },
      multiValueHeaders: {
        "set-cookie": ["a=1; Expires=Wed, 21 Oct 2030 07:28:00 GMT", "b=2; Path=/"],
      },
    });
    assert.deepEqual(Buffer.concat(output.chunks), Buffer.from([0, 255, 128, 64]));
  });

  it("commits metadata for a response without a body", async () => {
    let runtime = installStreamingRuntime();
    let output = createOutput();

    await streamApiGatewayV1Response(
      new Response(null, { status: 204 }),
      output.stream as unknown as awslambda.HttpResponseStream,
    );

    assert.deepEqual(runtime.metadata, { statusCode: 204 });
    assert.equal(output.stream.writableEnded, true);
  });

  it("commits metadata before an initially empty stream produces data", async () => {
    let runtime = installStreamingRuntime();
    let output = createOutput();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let response = new Response(
      new ReadableStream({
        start(value) {
          controller = value;
        },
      }),
      { status: 202 },
    );

    let streaming = streamApiGatewayV1Response(
      response,
      output.stream as unknown as awslambda.HttpResponseStream,
    );

    assert.deepEqual(runtime.metadata, { statusCode: 202 });
    controller?.close();
    await streaming;
    assert.deepEqual(output.chunks, []);
  });

  it("accepts metadata and its delimiter at the 16 KB boundary", async () => {
    let runtime = installStreamingRuntime();
    let output = createOutput();
    let overhead =
      Buffer.byteLength(JSON.stringify({ statusCode: 200, headers: { "x-large": "" } })) + 8;
    let value = "x".repeat(16_384 - overhead);

    await streamApiGatewayV1Response(
      new Response(null, { headers: { "X-Large": value } }),
      output.stream as unknown as awslambda.HttpResponseStream,
    );

    assert.equal(Buffer.byteLength(JSON.stringify(runtime.metadata)) + 8, 16_384);
  });

  it("rejects metadata whose UTF-8 bytes exceed 16 KB before touching the output", async () => {
    let runtime = installStreamingRuntime();
    let output = createOutput();

    await assert.rejects(
      streamApiGatewayV1Response(
        new Response(null, { headers: { "X-Large": "é".repeat(8_192) } }),
        output.stream as unknown as awslambda.HttpResponseStream,
      ),
      /first 16 KB/,
    );

    assert.equal(runtime.metadata, undefined);
    assert.equal(output.stream.writableEnded, false);
    assert.deepEqual(output.chunks, []);
    output.stream.destroy();
  });
});

describe("streamFunctionUrlResponse", () => {
  it("uses the Function URL cookies metadata field", async () => {
    let runtime = installStreamingRuntime();
    let output = createOutput();
    let headers = new Headers();
    headers.append("Set-Cookie", "session=abc; Path=/");

    await streamFunctionUrlResponse(
      new Response("hello", { headers }),
      output.stream as unknown as awslambda.HttpResponseStream,
    );

    assert.deepEqual(runtime.metadata, {
      statusCode: 200,
      headers: { "content-type": "text/plain;charset=UTF-8" },
      cookies: ["session=abc; Path=/"],
    });
    assert.equal(Buffer.concat(output.chunks).toString(), "hello");
  });

  it("rejects and destroys the output when the response body fails", async () => {
    let runtime = installStreamingRuntime();
    let output = createOutput();
    let expectedError = new Error("source failed");
    let response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(expectedError);
        },
      }),
    );

    await assert.rejects(
      streamFunctionUrlResponse(response, output.stream as unknown as awslambda.HttpResponseStream),
      (error) => error === expectedError,
    );

    assert.deepEqual(runtime.metadata, { statusCode: 200 });
    assert.equal(output.stream.destroyed, true);
  });

  it("cancels the response body when the destination fails", async () => {
    installStreamingRuntime();
    let output = createOutput();
    let expectedError = new Error("destination closed");
    let cancelledWith: unknown;
    let response = new Response(
      new ReadableStream({
        cancel(reason) {
          cancelledWith = reason;
        },
      }),
    );
    let streaming = streamFunctionUrlResponse(
      response,
      output.stream as unknown as awslambda.HttpResponseStream,
    );
    let rejection = assert.rejects(streaming, (error) => error === expectedError);
    output.stream.destroy(expectedError);

    await rejection;
    assert.equal(cancelledWith, expectedError);
    assert.equal(output.stream.destroyed, true);
  });

  it("respects destination backpressure instead of buffering the whole response", async () => {
    installStreamingRuntime();
    let totalChunks = 8;
    let pulls = 0;
    let bytesWritten = 0;
    let releaseWrites = false;
    let resolveFirstWrite: () => void = () => {};
    let firstWrite = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve;
    });
    let pendingWrites: (() => void)[] = [];
    let output = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        bytesWritten += chunk.byteLength;
        if (chunk.byteLength === 0 || releaseWrites) callback();
        else {
          pendingWrites.push(callback);
          resolveFirstWrite();
        }
      },
    });
    let response = new Response(
      new ReadableStream({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(128 * 1024));
          if (pulls === totalChunks) controller.close();
        },
      }),
    );

    let streaming = streamFunctionUrlResponse(response, output as awslambda.HttpResponseStream);
    await firstWrite;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert(pulls < totalChunks, "the source must pause while the destination is blocked");

    releaseWrites = true;
    for (let callback of pendingWrites) callback();
    await streaming;

    assert.equal(bytesWritten, totalChunks * 128 * 1024);
    assert.equal(output.writableFinished, true);
  });
});

describe("createApiGatewayV1StreamingHandler", () => {
  it("handles oversized metadata before streaming begins", async () => {
    let runtime = installStreamingRuntime();
    let output = createOutput();
    let receivedError: unknown;
    let handler = createApiGatewayV1StreamingHandler(
      () => new Response(null, { headers: { "X-Large": "x".repeat(16_384) } }),
      {
        onError(error) {
          receivedError = error;
          return new Response("bad gateway", { status: 502 });
        },
      },
    );

    await handler(
      createV1Event(),
      output.stream as unknown as awslambda.HttpResponseStream,
      undefined as unknown as Context,
    );

    assert.match(String(receivedError), /first 16 KB/);
    assert.deepEqual(runtime.metadata, {
      statusCode: 502,
      headers: { "content-type": "text/plain;charset=UTF-8" },
    });
    assert.equal(Buffer.concat(output.chunks).toString(), "bad gateway");
  });
});

describe("createLambdaFunctionUrlStreamingHandler", () => {
  it("converts a v2 event and streams the Fetch response", async () => {
    installStreamingRuntime();
    let output = createOutput();
    let handler = createLambdaFunctionUrlStreamingHandler((request) => {
      return new Response(new URL(request.url).searchParams.getAll("tag").join(","));
    });

    await handler(
      createV2Event({ rawQueryString: "tag=one&tag=two" }),
      output.stream as unknown as awslambda.HttpResponseStream,
      undefined as unknown as Context,
    );

    assert.equal(Buffer.concat(output.chunks).toString(), "one,two");
  });

  it("can rethrow errors before streaming begins", async () => {
    installStreamingRuntime();
    let output = createOutput();
    let expectedError = new Error("broken");
    let handler = createLambdaFunctionUrlStreamingHandler(
      () => {
        throw expectedError;
      },
      {
        onError(error) {
          throw error;
        },
      },
    );

    await assert.rejects(
      async () =>
        handler(
          createV2Event(),
          output.stream as unknown as awslambda.HttpResponseStream,
          undefined as unknown as Context,
        ),
      (error) => error === expectedError,
    );
  });

  it("handles an invalid Fetch response status before streaming", async () => {
    let runtime = installStreamingRuntime();
    let output = createOutput();
    let receivedError: unknown;
    let handler = createLambdaFunctionUrlStreamingHandler(() => Response.error(), {
      onError(error) {
        receivedError = error;
        return new Response("bad gateway", { status: 502 });
      },
    });

    await handler(
      createV2Event(),
      output.stream as unknown as awslambda.HttpResponseStream,
      undefined as unknown as Context,
    );

    assert.match(String(receivedError), /between 100 and 599/);
    assert.deepEqual(runtime.metadata, {
      statusCode: 502,
      headers: { "content-type": "text/plain;charset=UTF-8" },
    });
    assert.equal(Buffer.concat(output.chunks).toString(), "bad gateway");
  });

  it("handles a locked response body before streaming begins", async () => {
    let runtime = installStreamingRuntime();
    let output = createOutput();
    let receivedError: unknown;
    let response = new Response("locked");
    let reader = response.body?.getReader();
    let handler = createLambdaFunctionUrlStreamingHandler(() => response, {
      onError(error) {
        receivedError = error;
        return new Response("bad gateway", { status: 502 });
      },
    });

    try {
      await handler(
        createV2Event(),
        output.stream as unknown as awslambda.HttpResponseStream,
        undefined as unknown as Context,
      );
    } finally {
      await reader?.cancel();
    }

    assert.match(String(receivedError), /read or locked/);
    assert.deepEqual(runtime.metadata, {
      statusCode: 502,
      headers: { "content-type": "text/plain;charset=UTF-8" },
    });
    assert.equal(Buffer.concat(output.chunks).toString(), "bad gateway");
  });

  it("handles a consumed body before metadata is committed", async () => {
    let runtime = installStreamingRuntime();
    let output = createOutput();
    let response = new Response("consumed");
    await response.text();
    let handler = createLambdaFunctionUrlStreamingHandler(() => response, {
      onError(error) {
        assert.match(String(error), /read or locked/);
        assert.equal(runtime.metadata, undefined);
      },
    });

    await handler(
      createV2Event(),
      output.stream as unknown as awslambda.HttpResponseStream,
      undefined as unknown as Context,
    );

    assert.equal(runtime.metadata?.statusCode, 500);
    assert.equal(Buffer.concat(output.chunks).toString(), "Internal Server Error");
  });

  it("propagates source failures after the first chunk without invoking onError", async () => {
    let runtime = installStreamingRuntime();
    let output = createOutput();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let expectedError = new Error("source failed after headers");
    let errorCalls = 0;
    let handler = createLambdaFunctionUrlStreamingHandler(
      () =>
        new Response(
          new ReadableStream({
            start(value) {
              controller = value;
              value.enqueue(new TextEncoder().encode("first chunk"));
            },
          }),
          { status: 202 },
        ),
      {
        onError() {
          errorCalls++;
          return new Response("too late", { status: 500 });
        },
      },
    );
    let firstChunk = once(output.stream, "data");
    let streaming = handler(
      createV2Event(),
      output.stream as unknown as awslambda.HttpResponseStream,
      undefined as unknown as Context,
    );
    let rejection = assert.rejects(
      async () => streaming,
      (error) => error === expectedError,
    );
    await firstChunk;
    controller?.error(expectedError);
    await rejection;

    assert.equal(runtime.metadata?.statusCode, 202);
    assert.equal(Buffer.concat(output.chunks).toString(), "first chunk");
    assert.equal(errorCalls, 0);
    assert.equal(output.stream.destroyed, true);
  });

  it("propagates invalid fallback responses without retrying onError", async () => {
    let runtime = installStreamingRuntime();
    let output = createOutput();
    let calls = 0;
    let handler = createLambdaFunctionUrlStreamingHandler(() => Response.error(), {
      onError() {
        calls++;
        return Response.error();
      },
    });

    await assert.rejects(
      async () =>
        handler(
          createV2Event(),
          output.stream as unknown as awslambda.HttpResponseStream,
          undefined as unknown as Context,
        ),
      /between 100 and 599/,
    );
    assert.equal(calls, 1);
    assert.equal(runtime.metadata, undefined);
    assert.deepEqual(output.chunks, []);
    output.stream.destroy();
  });

  it("fails clearly when the Lambda streaming runtime is absent", async () => {
    delete (globalThis as Record<string, unknown>).awslambda;
    let output = createOutput();
    assert.throws(
      () => createLambdaFunctionUrlStreamingHandler(() => new Response("ok")),
      /requires the AWS Lambda Node.js runtime/,
    );
    await assert.rejects(
      streamFunctionUrlResponse(
        new Response(null),
        output.stream as unknown as awslambda.HttpResponseStream,
      ),
      /requires the AWS Lambda Node.js runtime/,
    );
    output.stream.destroy();
  });
});

function installStreamingRuntime(): { metadata: Record<string, unknown> | undefined } {
  let state: { metadata: Record<string, unknown> | undefined } = { metadata: undefined };

  Object.defineProperty(globalThis, "awslambda", {
    configurable: true,
    value: {
      HttpResponseStream: {
        from(stream: Writable, metadata: Record<string, unknown>) {
          let write = stream.write;
          stream.write = function (this: Writable, ...args: unknown[]) {
            // AWS emits its JSON prelude and delimiter on the first write, not on from() or end().
            state.metadata ??= metadata;
            return Reflect.apply(write, this, args);
          } as typeof stream.write;
          return stream;
        },
      },
      streamifyResponse<T>(handler: T): T {
        return handler;
      },
    },
  });

  return state;
}

function createOutput(): { stream: PassThrough; chunks: Buffer[] } {
  let stream = new PassThrough();
  let chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return { stream, chunks };
}

function createV2Event(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/",
    rawQueryString: "",
    headers: { host: "example.com" },
    requestContext: {
      accountId: "123456789012",
      apiId: "api-id",
      domainName: "example.lambda-url.eu-west-2.on.aws",
      domainPrefix: "example",
      http: {
        method: "GET",
        path: "/",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "test",
      },
      requestId: "request-id",
      routeKey: "$default",
      stage: "$default",
      time: "17/Sep/2026:00:00:00 +0000",
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
  };
}

function createV1Event(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: { Host: "example.com" },
    httpMethod: "GET",
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: "/",
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      accountId: "123456789012",
      apiId: "api-id",
      authorizer: undefined,
      domainName: "example.execute-api.eu-west-2.amazonaws.com",
      domainPrefix: "example",
      extendedRequestId: "extended-request-id",
      httpMethod: "GET",
      identity: {
        accessKey: null,
        accountId: null,
        apiKey: null,
        apiKeyId: null,
        caller: null,
        clientCert: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        sourceIp: "127.0.0.1",
        user: null,
        userAgent: "test",
        userArn: null,
      },
      path: "/",
      protocol: "HTTP/1.1",
      requestId: "request-id",
      requestTime: "17/Sep/2026:00:00:00 +0000",
      requestTimeEpoch: 0,
      resourceId: "resource-id",
      resourcePath: "/",
      stage: "test",
    },
    resource: "/",
    stageVariables: null,
    ...overrides,
  };
}
