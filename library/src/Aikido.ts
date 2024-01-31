import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { API, Kind, Token } from "./API";
import { Logger } from "./Logger";
import { Request } from "./RequestContext";
import { resolve } from "path";
import { Source } from "./Source";

// Lambda instances are reused, so we need to make sure we only report the installed event once
let INSTALLED = false;

export class Aikido {
  private version: string | undefined = undefined;

  constructor(
    private readonly logger: Logger,
    private readonly api: API,
    private readonly token: Token | undefined
  ) {
    if (!this.token) {
      this.logger.log("No token provided, disabling reporting");
    }
  }

  private getVersion() {
    if (this.version) {
      return this.version;
    }

    const entrypoint = require.resolve("@aikidosec/rasp");
    const json: { version: string } = JSON.parse(
      readFileSync(
        resolve(entrypoint, "..", "..", "package.json"),
        "utf-8"
      ).toString()
    );
    this.version = json.version;

    return json.version;
  }

  installed() {
    if (INSTALLED) {
      return;
    }

    INSTALLED = true;

    if (this.token) {
      this.api
        .report(this.token, {
          type: "installed",
          hostname: hostname(),
          version: this.getVersion(),
        })
        .catch((error) => {
          this.logger.log("Failed to report event to Aikido: " + error.message);
        });
    }
  }

  report({
    kind,
    source,
    request,
    stack,
    path,
    metadata,
  }: {
    kind: Kind;
    source: Source;
    request: Request;
    stack: string;
    path: string;
    metadata: Record<string, string>;
  }) {
    if (this.token) {
      this.api
        .report(this.token, {
          type: "blocked",
          kind: kind,
          ipAddress: request.remoteAddress,
          userAgent:
            typeof request.headers["user-agent"] === "string"
              ? request.headers["user-agent"]
              : undefined,
          url: request.url as string,
          method: request.method,
          path: path,
          stack: stack,
          source: source,
          metadata: metadata,
          version: this.getVersion(),
          hostname: hostname(),
        })
        .catch((error) => {
          this.logger.log("Failed to report event: " + error.message);
        });
    }
  }
}
