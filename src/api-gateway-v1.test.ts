import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyHandler,
  APIGatewayProxyResult,
  APIGatewayProxyWithLambdaAuthorizerEvent,
} from "aws-lambda";
import { createHandler, createHeaders, createRequest, createResult } from "./api-gateway-v1.ts";

describe("createHeaders", () => {
  it("combines headers and gives multi-value headers precedence case-insensitively", () => {
    let headers = createHeaders(
      { Accept: "text/plain", "X-Mode": "single" },
      { accept: ["application/json", "text/html"], Cookie: ["a=1", "b=2"], cookie: ["c=3"] },
    );

    assert.equal(headers.get("accept"), "application/json, text/html");
    assert.equal(headers.get("x-mode"), "single");
    assert.equal(headers.get("cookie"), "a=1; b=2; c=3");
  });

  it("falls back to a single-value header when the multi-value entry is undefined", () => {
    let headers = createHeaders({ Accept: "text/plain" }, { accept: undefined });
    assert.equal(headers.get("accept"), "text/plain");
  });
});

describe("createRequest", () => {
  it("creates a URL from forwarded headers and preserves multi-value query parameters", () => {
    let request = createRequest(
      createEvent({
        headers: { Host: "internal.example.com" },
        multiValueHeaders: {
          "X-Forwarded-Host": ["www.example.com", "proxy.example.com"],
          "X-Forwarded-Proto": ["https"],
        },
        path: "/search?#fragment",
        queryStringParameters: { page: "2", tag: "ignored" },
        multiValueQueryStringParameters: { tag: ["one", "two"] },
      }),
    );

    assert.equal(
      request.url,
      "https://www.example.com/search%3F%23fragment?tag=one&tag=two&page=2",
    );
  });

  it("uses requestContext.domainName and https by default", () => {
    let request = createRequest(
      createEvent({
        headers: {},
        path: "hello",
        requestContext: createRequestContext("api.example.com"),
      }),
    );
    assert.equal(request.url, "https://api.example.com/hello");
  });

  it("escapes query values without losing literal plus signs, empty values, or Unicode", () => {
    let request = createRequest(
      createEvent({
        multiValueQueryStringParameters: { tag: ["a+b", "", "café & tea"], page: undefined },
        queryStringParameters: { tag: "ignored", page: "2" },
      }),
    );

    let url = new URL(request.url);
    assert.deepEqual(url.searchParams.getAll("tag"), ["a+b", "", "café & tea"]);
    assert.equal(url.searchParams.get("page"), "2");
  });

  it("uses only the origin from an explicit origin URL", () => {
    let request = createRequest(createEvent({ path: "/users" }), {
      origin: "https://www.example.com/ignored?also=ignored",
    });
    assert.equal(request.url, "https://www.example.com/users");
  });

  it("throws when no request origin can be determined", () => {
    assert.throws(
      () => createRequest(createEvent({ headers: {}, requestContext: createRequestContext("") })),
      /without an origin/,
    );
  });

  it("ignores bodies on GET and HEAD requests", async () => {
    let getRequest = createRequest(createEvent({ body: "ignored", httpMethod: "GET" }));
    let headRequest = createRequest(createEvent({ body: "ignored", httpMethod: "HEAD" }));
    assert.equal(await getRequest.text(), "");
    assert.equal(await headRequest.text(), "");
  });

  it("passes text request bodies through unchanged", async () => {
    let request = createRequest(createEvent({ body: "hello 🌍", httpMethod: "POST" }));
    assert.equal(await request.text(), "hello 🌍");
    assert.equal(request.headers.get("content-type"), null);
  });

  it("preserves an explicit content type when converting form bodies", async () => {
    let request = createRequest(
      createEvent({
        httpMethod: "POST",
        headers: { Host: "example.com", "Content-Type": "application/x-www-form-urlencoded" },
        body: "tag=a%2Bb&tag=caf%C3%A9",
      }),
    );

    assert.deepEqual((await request.formData()).getAll("tag"), ["a+b", "café"]);
  });

  it("decodes base64 request bodies without changing their bytes", async () => {
    let request = createRequest(
      createEvent({ body: "AP+AQA==", httpMethod: "POST", isBase64Encoded: true }),
    );
    assert.deepEqual(
      new Uint8Array(await request.arrayBuffer()),
      new Uint8Array([0, 255, 128, 64]),
    );
  });
});

describe("createResult", () => {
  it("creates a text proxy result with status and headers", async () => {
    let result = await createResult(
      new Response("created", { status: 201, headers: { "X-Request-Id": "abc" } }),
    );

    assert.deepEqual(result, {
      statusCode: 201,
      headers: { "content-type": "text/plain;charset=UTF-8", "x-request-id": "abc" },
      body: "created",
      isBase64Encoded: false,
    });
  });

  it("emits multiple Set-Cookie headers as multi-value headers", async () => {
    let headers = new Headers();
    headers.append("Set-Cookie", "a=1; Path=/");
    headers.append("Set-Cookie", "b=2; Path=/");

    let result = await createResult(new Response(null, { headers }));

    assert.equal(result.headers, undefined);
    assert.deepEqual(result.multiValueHeaders, {
      "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
    });
  });

  it("preserves response headers named __proto__", async () => {
    let headers = new Headers();
    headers.set("__proto__", "value");

    let result = await createResult(new Response(null, { headers }));

    assert.equal(result.headers?.__proto__, "value");
    assert.equal(Object.hasOwn(result.headers ?? {}, "__proto__"), true);
  });

  it("removes headers nominated by the Connection header", async () => {
    let result = await createResult(
      new Response(null, {
        headers: {
          Connection: " X-Private, Set-Cookie ",
          "X-Private": "private",
          "X-Public": "visible",
          "Set-Cookie": "session=abc",
        },
      }),
    );

    assert.deepEqual(result.headers, { "x-public": "visible" });
    assert.equal(result.multiValueHeaders, undefined);
  });

  it("base64-encodes exact binary media type matches", async () => {
    let result = await createResult(
      new Response(new Uint8Array([0, 255, 128, 64]), {
        headers: { "Content-Type": "application/octet-stream; charset=binary" },
      }),
      { binaryMediaTypes: ["application/octet-stream"] },
    );

    assert.equal(result.body, "AP+AQA==");
    assert.equal(result.isBase64Encoded, true);
  });

  it("base64-encodes subtype wildcard matches case-insensitively", async () => {
    let result = await createResult(
      new Response("image", { headers: { "Content-Type": "IMAGE/PNG" } }),
      {
        binaryMediaTypes: ["image/*"],
      },
    );
    assert.equal(result.body, "aW1hZ2U=");
    assert.equal(result.isBase64Encoded, true);
  });

  it("base64-encodes responses without a content type when */* is configured", async () => {
    let result = await createResult(new Response(null), { binaryMediaTypes: ["*/*"] });
    assert.equal(result.body, "");
    assert.equal(result.isBase64Encoded, true);
  });

  it("does not encode unmatched response content types", async () => {
    let result = await createResult(
      new Response("hello", { headers: { "Content-Type": "text/plain" } }),
      {
        binaryMediaTypes: ["image/*"],
      },
    );
    assert.equal(result.body, "hello");
    assert.equal(result.isBase64Encoded, false);
  });

  it("handles binary bodies larger than the base64 conversion chunk size", async () => {
    let body = new Uint8Array(70_000);
    body.fill(255);
    let result = await createResult(
      new Response(body, { headers: { "Content-Type": "application/octet-stream" } }),
      {
        binaryMediaTypes: ["application/octet-stream"],
      },
    );
    assert.equal(result.body, Buffer.from(body).toString("base64"));
  });

  it("rejects a Fetch network error response with status zero", async () => {
    await assert.rejects(createResult(Response.error()), /between 100 and 599/);
  });
});

describe("createHandler", () => {
  it("runs a Fetch handler and returns its response as a proxy result", async () => {
    let handler = createHandler(async (request) => {
      return Response.json({ pathname: new URL(request.url).pathname });
    });

    let result = await handler(createEvent({ path: "/hello" }));
    assert.equal(result.statusCode, 200);
    assert.equal(result.body, '{"pathname":"/hello"}');
  });

  it("uses a custom error response", async () => {
    let expectedError = new Error("broken");
    let receivedError: unknown;
    let handler = createHandler(
      () => {
        throw expectedError;
      },
      {
        onError(error) {
          receivedError = error;
          return new Response("custom failure", { status: 503 });
        },
      },
    );

    let result = await handler(createEvent());
    assert.equal(receivedError, expectedError);
    assert.equal(result.statusCode, 503);
    assert.equal(result.body, "custom failure");
  });

  it("uses the default response when a custom error handler returns undefined", async () => {
    let handler = createHandler(
      () => {
        throw new Error("broken");
      },
      { onError() {} },
    );

    let result = await handler(createEvent());
    assert.equal(result.statusCode, 500);
    assert.equal(result.body, "Internal Server Error");
  });

  it("lets a custom error handler propagate an error", async () => {
    let expectedError = new Error("broken");
    let handler = createHandler(
      () => {
        throw expectedError;
      },
      {
        onError(error) {
          throw error;
        },
      },
    );

    await assert.rejects(handler(createEvent()), (error) => error === expectedError);
  });

  it("handles an invalid Fetch response status", async () => {
    let receivedError: unknown;
    let handler = createHandler(() => Response.error(), {
      onError(error) {
        receivedError = error;
        return new Response("bad gateway", { status: 502 });
      },
    });

    let result = await handler(createEvent());

    assert.match(String(receivedError), /between 100 and 599/);
    assert.equal(result.statusCode, 502);
    assert.equal(result.body, "bad gateway");
  });

  it("handles request conversion errors before calling the Fetch handler", async () => {
    let called = false;
    let receivedEvent: APIGatewayProxyEvent | undefined;
    let event = createEvent({ body: "not base64!", httpMethod: "POST", isBase64Encoded: true });
    let handler = createHandler(
      () => {
        called = true;
        return new Response("unexpected");
      },
      {
        onError(_error, context) {
          receivedEvent = context.event;
          return new Response("invalid body", { status: 400 });
        },
      },
    );

    assert.equal((await handler(event)).statusCode, 400);
    assert.equal(called, false);
    assert.equal(receivedEvent, event);
  });

  it("handles asynchronous failures while reading a buffered response", async () => {
    let expectedError = new Error("body failed");
    let handler = createHandler(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(expectedError);
            },
          }),
        ),
      {
        async onError(error) {
          assert.equal(error, expectedError);
          return new Response("upstream failed", { status: 502 });
        },
      },
    );

    let result = await handler(createEvent());
    assert.equal(result.statusCode, 502);
    assert.equal(result.body, "upstream failed");
  });
});

it("creates an official API Gateway proxy handler and result", async () => {
  let handler: APIGatewayProxyHandler = createHandler(() => new Response("ok"));
  let result: APIGatewayProxyResult = await createResult(new Response("ok"));

  assert.equal(typeof handler, "function");
  assert.equal(result.statusCode, 200);
});

it("preserves a custom authorizer event type in the Fetch handler context", () => {
  type Event = APIGatewayProxyWithLambdaAuthorizerEvent<{ tenantId: string }>;
  let handler = createHandler<Event>((_request, { event }) => {
    return new Response(event.requestContext.authorizer.tenantId);
  });

  assert.equal(typeof handler, "function");
});

function createEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
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
    resource: "/{proxy+}",
    stageVariables: null,
    requestContext: createRequestContext("example.execute-api.eu-west-2.amazonaws.com"),
    ...overrides,
  };
}

function createRequestContext(domainName: string): APIGatewayProxyEvent["requestContext"] {
  return {
    accountId: "123456789012",
    apiId: "api-id",
    authorizer: undefined,
    domainName,
    domainPrefix: "example",
    extendedRequestId: "extended-id",
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
    requestTimeEpoch: 0,
    resourceId: "resource-id",
    resourcePath: "/{proxy+}",
    stage: "test",
  };
}
