import { Agent } from "../agent/Agent";
import { Hooks } from "../agent/hooks/Hooks";
import { Wrapper } from "../agent/Wrapper";
import { isPackageInstalled } from "../helpers/isPackageInstalled";
import { isPlainObject } from "../helpers/isPlainObject";
import { createRequestListener } from "./http-server/createRequestListener";

export class HTTPServer implements Wrapper {
  private wrapRequestListener(args: unknown[], module: string, agent: Agent) {
    // Parse body only if next is installed
    // We can only read the body stream once
    // This is tricky, see replaceRequestBody(...)
    // e.g. Hono uses web requests and web streams
    // (uses Readable.toWeb(req) to convert to a web stream)
    const parseBody = isPackageInstalled("next");

    // Without options
    // http(s).createServer(listener)
    if (args.length > 0 && typeof args[0] === "function") {
      return [createRequestListener(args[0], module, agent, parseBody)];
    }

    // With options
    // http(s).createServer({ ... }, listener)
    if (args.length > 1 && typeof args[1] === "function") {
      return [
        args[0],
        createRequestListener(args[1], module, agent, parseBody),
      ];
    }

    return args;
  }

  private wrapOn(args: unknown[], module: string, agent: Agent) {
    if (
      args.length < 2 ||
      typeof args[0] !== "string" ||
      typeof args[1] !== "function"
    ) {
      return args;
    }
    if (args[0] !== "request") {
      return args;
    }
    return this.wrapRequestListener(args, module, agent);
  }

  wrap(hooks: Hooks) {
    hooks
      .addBuiltinModule("http")
      .addSubject((exports) => exports)
      .modifyArguments("createServer", (args, subject, agent) => {
        return this.wrapRequestListener(args, "http", agent);
      })
      .inspectNewInstance("createServer")
      .addSubject((exports) => exports)
      .modifyArguments("on", (args, subject, agent) => {
        return this.wrapOn(args, "http", agent);
      });

    hooks
      .addBuiltinModule("https")
      .addSubject((exports) => exports)
      .modifyArguments("createServer", (args, subject, agent) => {
        return this.wrapRequestListener(args, "https", agent);
      })
      .inspectNewInstance("createServer")
      .addSubject((exports) => exports)
      .modifyArguments("on", (args, subject, agent) => {
        return this.wrapOn(args, "https", agent);
      });
  }
}
