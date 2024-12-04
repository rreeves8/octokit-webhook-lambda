import type { Webhooks } from "@octokit/webhooks";
import type { MiddlewareOptions } from "@octokit/webhooks/dist-types/middleware/node/types";
import type {
  WebhookEventName,
  WebhookEventHandlerError,
} from "@octokit/webhooks/dist-types/types";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

export async function createLambdaAPIGatewayMiddleware(
  webhooks: Webhooks,
  request: APIGatewayProxyEventV2,
  options: Omit<MiddlewareOptions, "path">
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!options.log) {
    options.log = console;
  }

  if (request.requestContext.http.method !== "POST") {
    return {
      statusCode: 404,
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        error: `Unknown route: ${request.requestContext.http.method}`,
      }),
    };
  }

  // Check if the Content-Type header is `application/json` and allow for charset to be specified in it
  // Otherwise, return a 415 Unsupported Media Type error
  // See https://github.com/octokit/webhooks.js/issues/158
  if (
    !request.headers["content-type"] ||
    !request.headers["content-type"].startsWith("application/json")
  ) {
    return {
      statusCode: 415,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        error: `Unsupported "Content-Type" header value. Must be "application/json"`,
      }),
    };
  }

  const missingHeaders = getMissingHeaders(request).join(", ");

  if (missingHeaders) {
    return {
      statusCode: 400,
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        error: `Required headers missing: ${missingHeaders}`,
      }),
    };
  }

  const eventName = request.headers["x-github-event"] as WebhookEventName;
  const signatureSHA256 = request.headers["x-hub-signature-256"] as string;
  const id = request.headers["x-github-delivery"] as string;

  options.log.debug(`${eventName} event received (id: ${id})`);

  const payload = request.body;

  if (!payload) {
    return {
      statusCode: 400,
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        error: `Required Body`,
      }),
    };
  }

  try {
    await Promise.race([
      webhooks.verifyAndReceive({
        id: id,
        name: eventName as any,
        payload,
        signature: signatureSHA256,
      }),
      new Promise((resolve, reject) => {
        setTimeout(() => {
          reject(new TimeoutError("Timeout"));
        }, 9000);
      }),
    ]);

    return {
      statusCode: 200,
      body: "ok\n",
    };
  } catch (error) {
    if (error instanceof TimeoutError) {
      return {
        statusCode: 408,
        body: "Timeout",
      };
    }

    const err = Array.from((error as WebhookEventHandlerError).errors)[0];
    const errorMessage = err.message
      ? `${err.name}: ${err.message}`
      : "Error: An Unspecified error occurred";

    options.log.error(error);

    return {
      statusCode: typeof err.status !== "undefined" ? err.status : 500,
      body: JSON.stringify({
        error: errorMessage,
      }),
    };
  }
}

const WEBHOOK_HEADERS = [
  "x-github-event",
  "x-hub-signature-256",
  "x-github-delivery",
];

// https://docs.github.com/en/developers/webhooks-and-events/webhook-events-and-payloads#delivery-headers
function getMissingHeaders(request: APIGatewayProxyEventV2) {
  return WEBHOOK_HEADERS.filter((header) => !(header in request.headers));
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}
