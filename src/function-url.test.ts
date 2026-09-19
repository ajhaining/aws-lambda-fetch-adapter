import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  LambdaFunctionURLEvent,
  LambdaFunctionURLEventWithIAMAuthorizer,
  LambdaFunctionURLHandler,
  LambdaFunctionURLResult,
} from "aws-lambda";
import { createHandler, createRequest, createResult } from "./function-url.ts";

describe("Function URL createRequest", () => {
  it("creates a Fetch request from the Function URL event", () => {
    let request = createRequest(
      createEvent({
        rawPath: "/files/a%2Fb",
        rawQueryString: "tag=one&tag=two",
        cookies: ["session=abc", "theme=dark"],
      }),
    );

    assert.equal(
      request.url,
      "https://example.lambda-url.eu-west-2.on.aws/files/a%2Fb?tag=one&tag=two",
    );
    assert.equal(request.headers.get("cookie"), "session=abc; theme=dark");
  });
});

describe("Function URL createResult", () => {
  it("creates a buffered result with Function URL cookies", async () => {
    let headers = new Headers();
    headers.append("Set-Cookie", "a=1; Path=/");
    headers.append("Set-Cookie", "b=2; Path=/");

    let result = await createResult(new Response("created", { status: 201, headers }));

    assert.deepEqual(result, {
      statusCode: 201,
      headers: { "content-type": "text/plain;charset=UTF-8" },
      cookies: ["a=1; Path=/", "b=2; Path=/"],
      body: "created",
      isBase64Encoded: false,
    });
  });
});

describe("Function URL createHandler", () => {
  it("passes the original Function URL event to the Fetch handler", async () => {
    let event = createEvent({ rawPath: "/hello" });
    let receivedEvent: LambdaFunctionURLEvent | undefined;
    let handler = createHandler((request, context) => {
      receivedEvent = context.event;
      return new Response(new URL(request.url).pathname);
    });

    let result = await handler(event);

    assert.equal(receivedEvent, event);
    assert.equal(result.body, "/hello");
  });

  it("uses an asynchronous custom error response", async () => {
    let expectedError = new Error("failed");
    let handler = createHandler(
      async () => {
        throw expectedError;
      },
      {
        async onError(error) {
          assert.equal(error, expectedError);
          return new Response("unavailable", { status: 503 });
        },
      },
    );

    let result = await handler(createEvent());
    assert.equal(result.statusCode, 503);
    assert.equal(result.body, "unavailable");
  });

  it("propagates an invalid error response without calling onError again", async () => {
    let calls = 0;
    let handler = createHandler(() => Response.error(), {
      onError() {
        calls++;
        return Response.error();
      },
    });

    await assert.rejects(handler(createEvent()), /between 100 and 599/);
    assert.equal(calls, 1);
  });
});

it("creates official Function URL handler and result types", async () => {
  let handler: LambdaFunctionURLHandler = createHandler(() => new Response("ok"));
  let result: LambdaFunctionURLResult = await createResult(new Response("ok"));

  assert.equal(typeof handler, "function");
  assert.equal(typeof result === "object" && result !== null ? result.statusCode : undefined, 200);
});

it("preserves an IAM authorizer event type in the Fetch handler context", () => {
  let handler = createHandler<LambdaFunctionURLEventWithIAMAuthorizer>(
    (_request, { event }) => new Response(event.requestContext.authorizer.iam.userArn),
  );

  assert.equal(typeof handler, "function");
});

function createEvent(overrides: Partial<LambdaFunctionURLEvent> = {}): LambdaFunctionURLEvent {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/",
    rawQueryString: "",
    headers: { host: "example.lambda-url.eu-west-2.on.aws" },
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
