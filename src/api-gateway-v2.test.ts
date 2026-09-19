import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import zlib from "node:zlib";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from "aws-lambda";
import { createHandler, createHeaders, createRequest, createResult } from "./api-gateway-v2.ts";

describe("API Gateway v2 createHeaders", () => {
  it("combines event cookies into a Fetch Cookie header", () => {
    let headers = createHeaders({ accept: "application/json" }, ["session=abc", "theme=dark"]);

    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("cookie"), "session=abc; theme=dark");
  });
});

describe("API Gateway v2 createRequest", () => {
  it("preserves raw path encoding and the raw query string", () => {
    let request = createRequest(
      createEvent({
        rawPath: "/files/a%2Fb",
        rawQueryString: "tag=one&tag=two&encoded=a%2Fb&space=a+b&empty=",
      }),
    );

    assert.equal(
      request.url,
      "https://example.com/files/a%2Fb?tag=one&tag=two&encoded=a%2Fb&space=a+b&empty=",
    );
  });

  it("uses the v2 HTTP method and decodes a base64 body", async () => {
    let event = createEvent({ body: "AP+AQA==", isBase64Encoded: true });
    event.requestContext.http.method = "POST";

    let request = createRequest(event);

    assert.equal(request.method, "POST");
    assert.deepEqual(
      new Uint8Array(await request.arrayBuffer()),
      new Uint8Array([0, 255, 128, 64]),
    );
  });

  it("supports an explicit external origin", () => {
    let request = createRequest(createEvent({ rawPath: "/users" }), {
      origin: "https://www.example.com/ignored",
    });

    assert.equal(request.url, "https://www.example.com/users");
  });
});

describe("API Gateway v2 createResult", () => {
  it("puts Set-Cookie values in the v2 cookies field", async () => {
    let headers = new Headers({ "X-Request-Id": "abc" });
    headers.append("Set-Cookie", "a=1; Path=/");
    headers.append("Set-Cookie", "b=2; Path=/");

    let result = await createResult(new Response("created", { status: 201, headers }));

    assert.deepEqual(result, {
      statusCode: 201,
      headers: {
        "content-type": "text/plain;charset=UTF-8",
        "x-request-id": "abc",
      },
      cookies: ["a=1; Path=/", "b=2; Path=/"],
      body: "created",
      isBase64Encoded: false,
    });
  });

  it("base64-encodes configured binary response types", async () => {
    let result = await createResult(
      new Response(new Uint8Array([0, 255, 128, 64]), {
        headers: { "Content-Type": "application/octet-stream" },
      }),
      { binaryMediaTypes: ["application/octet-stream"] },
    );

    assert.equal(result.body, "AP+AQA==");
    assert.equal(result.isBase64Encoded, true);
  });

  let original = Buffer.from("decoded body 🌍");
  let gzip = zlib.gzipSync(original);
  let encodings = [
    { encoding: "gzip", body: gzip, decoded: true },
    { encoding: "x-gzip", body: gzip, decoded: true },
    { encoding: "deflate", body: zlib.deflateSync(original), decoded: true },
    { encoding: "br", body: zlib.brotliCompressSync(original), decoded: true },
    { encoding: "gzip, br", body: zlib.brotliCompressSync(gzip), decoded: true },
    { encoding: "x-custom", body: gzip, decoded: false },
    { encoding: "gzip, x-custom", body: gzip, decoded: false },
  ];

  for (let { encoding, body, decoded } of encodings) {
    it(`preserves the body and encoding contract for native Fetch ${encoding} responses`, async () => {
      await withServer(body, { "Content-Encoding": encoding }, async (url) => {
        let result = await createResult(await fetch(url), { binaryMediaTypes: ["*/*"] });

        assert.deepEqual(Buffer.from(result.body ?? "", "base64"), decoded ? original : body);
        assert.equal(result.headers?.["content-encoding"], decoded ? undefined : encoding);
        assert.equal(result.headers?.["content-length"], undefined);
        assert.equal(result.headers?.connection, undefined);
        assert.equal(result.headers?.["keep-alive"], undefined);
        assert.equal(result.headers?.["content-type"], "text/plain");
      });
    });
  }

  it(
    "matches the current runtime's native Fetch zstd decoding",
    {
      skip: typeof zlib.zstdCompressSync !== "function",
    },
    async () => {
      let compressed = zlib.zstdCompressSync(original);
      await withServer(compressed, { "Content-Encoding": "zstd" }, async (url) => {
        let response = await fetch(url);
        let nativeBody = Buffer.from(await response.clone().arrayBuffer());
        let decoded = nativeBody.equals(original);
        let result = await createResult(response, { binaryMediaTypes: ["*/*"] });

        assert.deepEqual(Buffer.from(result.body ?? "", "base64"), nativeBody);
        assert.equal(result.headers?.["content-encoding"], decoded ? undefined : "zstd");
      });
    },
  );

  it("retains encoding metadata on bodyless native Fetch responses", async () => {
    await withServer(gzip, { "Content-Encoding": "gzip" }, async (url) => {
      let result = await createResult(await fetch(url, { method: "HEAD" }));
      assert.equal(result.body, "");
      assert.equal(result.headers?.["content-encoding"], "gzip");
    });
  });

  it("preserves intentionally compressed bytes and headers on constructed responses", async () => {
    let result = await createResult(
      new Response(gzip, { headers: { "Content-Encoding": "gzip", "Content-Type": "text/plain" } }),
      { binaryMediaTypes: ["*/*"] },
    );

    assert.deepEqual(Buffer.from(result.body ?? "", "base64"), gzip);
    assert.equal(result.headers?.["content-encoding"], "gzip");
  });
});

describe("createHandler", () => {
  it("passes the original event to the Fetch handler context", async () => {
    let event = createEvent({ rawPath: "/hello" });
    let receivedEvent: APIGatewayProxyEventV2 | undefined;
    let handler = createHandler((request, context) => {
      receivedEvent = context.event;
      return Response.json({ pathname: new URL(request.url).pathname });
    });

    let result = await handler(event);

    assert.equal(receivedEvent, event);
    assert.equal(result.body, '{"pathname":"/hello"}');
  });

  it("logs unhandled errors and returns the default 500", async (t) => {
    let expectedError = new Error("handler failed");
    let log = t.mock.method(console, "error", () => {});
    let handler = createHandler(async () => {
      throw expectedError;
    });

    let result = await handler(createEvent());
    assert.equal(result.statusCode, 500);
    assert.equal(result.body, "Internal Server Error");
    assert.equal(result.headers?.["content-type"], "text/plain");
    assert.equal(log.mock.calls[0]?.arguments[0], expectedError);
  });

  it("passes Lambda context to async onError and propagates its rejection", async () => {
    let event = createEvent();
    let context = { awsRequestId: "invocation-id" } as Context;
    let expectedError = new Error("propagated");
    let handler = createHandler(() => Response.error(), {
      async onError(_error, receivedContext) {
        assert.equal(receivedContext.event, event);
        assert.equal(receivedContext.lambdaContext, context);
        throw expectedError;
      },
    });

    await assert.rejects(handler(event, context), (error) => error === expectedError);
  });
});

it("creates official API Gateway v2 handler and result types", async () => {
  let handler: APIGatewayProxyHandlerV2 = createHandler(() => new Response("ok"));
  let result: APIGatewayProxyStructuredResultV2 = await createResult(new Response("ok"));

  assert.equal(typeof handler, "function");
  assert.equal(result.statusCode, 200);
});

it("preserves a JWT authorizer event type in the Fetch handler context", () => {
  let handler = createHandler<APIGatewayProxyEventV2WithJWTAuthorizer>(
    (_request, { event }) => new Response(String(event.requestContext.authorizer.jwt.claims.sub)),
  );

  assert.equal(typeof handler, "function");
});

function createEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/",
    rawQueryString: "",
    headers: { host: "example.com" },
    requestContext: {
      accountId: "123456789012",
      apiId: "api-id",
      domainName: "example.execute-api.eu-west-2.amazonaws.com",
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

async function withServer(
  body: Buffer,
  headers: Record<string, string>,
  run: (url: string) => Promise<void>,
): Promise<void> {
  let server = createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Length": body.byteLength,
      "Content-Type": "text/plain",
      ...headers,
    });
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    let address = server.address();
    assert(address !== null && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
