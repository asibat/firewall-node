import * as t from "tap";
import { Agent } from "./Agent";
import { APIForTesting } from "./api/APIForTesting";
import { applyHooks } from "./applyHooks";
import { Context, runWithContext } from "./Context";
import { Hooks } from "./hooks/Hooks";
import { LoggerForTesting } from "./logger/LoggerForTesting";

const context: Context = {
  remoteAddress: "::1",
  method: "POST",
  url: "http://localhost:4000",
  query: {},
  headers: {},
  body: undefined,
  cookies: {},
};

function createAgent() {
  const logger = new LoggerForTesting();
  const agent = new Agent(true, logger, new APIForTesting(), undefined, true);

  return {
    agent,
    logger,
  };
}

t.test("it ignores if package is not installed", async (t) => {
  const hooks = new Hooks();
  hooks.addPackage("unknown").withVersion("^1.0.0");

  const { agent } = createAgent();
  t.same(applyHooks(hooks, agent), {});
});

t.test("it ignores if packages have empty selectors", async (t) => {
  const hooks = new Hooks();
  hooks.addPackage("shimmer").withVersion("^1.0.0");

  const { agent } = createAgent();
  t.same(applyHooks(hooks, agent), {
    shimmer: {
      version: "1.2.1",
      supported: false,
    },
  });
});

t.test("it ignores unknown selectors", async (t) => {
  const hooks = new Hooks();
  hooks
    .addPackage("shimmer")
    .withVersion("^1.0.0")
    .addSubject((exports) => exports.doesNotExist)
    .inspect("method", () => {});

  const { agent } = createAgent();
  t.same(applyHooks(hooks, agent), {
    shimmer: {
      version: "1.2.1",
      supported: true,
    },
  });

  // Force require to load shimmer
  require("shimmer");
});

t.test("it ignores if version is not supported", async (t) => {
  const hooks = new Hooks();
  hooks
    .addPackage("shimmer")
    .withVersion("^2.0.0")
    .addSubject((exports) => exports)
    .inspect("method", () => {});

  const { agent } = createAgent();
  t.same(applyHooks(hooks, agent), {
    shimmer: {
      version: "1.2.1",
      supported: false,
    },
  });
});

function removeStackTraceErrorMessage(error: string) {
  const [msg] = error.split("\n");

  return msg;
}

t.test("it adds try/catch around the wrapped method", async (t) => {
  const hooks = new Hooks();
  const connection = hooks
    .addPackage("mysql2")
    .withVersion("^3.0.0")
    .addSubject((exports) => exports.Connection.prototype);
  connection.inspect("query", () => {
    throw new Error("THIS SHOULD BE CATCHED");
  });
  connection.modifyArguments("execute", () => {
    throw new Error("THIS SHOULD BE CATCHED");
  });
  connection.inspect("ping", () => {
    throw new Error("Aikido guard has blocked a SQL injection");
  });
  connection.modifyArguments("rollback", () => {
    throw new Error("Aikido guard has blocked a SQL injection");
  });

  const { agent, logger } = createAgent();
  t.same(applyHooks(hooks, agent), {
    mysql2: {
      version: "3.9.2",
      supported: true,
    },
  });

  const mysql = require("mysql2/promise");
  const actualConnection = await mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "mypassword",
    database: "catsdb",
    port: 27015,
    multipleStatements: true,
  });

  const [queryRows] = await runWithContext(context, () =>
    actualConnection.query("SELECT 1 as number")
  );
  t.same(queryRows, [{ number: 1 }]);

  const [executeRows] = await runWithContext(context, () =>
    actualConnection.execute("SELECT 1 as number")
  );
  t.same(executeRows, [{ number: 1 }]);

  t.same(logger.getMessages().map(removeStackTraceErrorMessage), [
    'Internal error in module "mysql2" in method "query"',
    'Internal error in module "mysql2" in method "execute"',
  ]);

  const error = await t.rejects(() =>
    runWithContext(context, () => actualConnection.ping())
  );
  if (error instanceof Error) {
    t.equal(error.message, "Aikido guard has blocked a SQL injection");
  }

  const error2 = await t.rejects(() =>
    runWithContext(context, () => actualConnection.rollback())
  );
  if (error2 instanceof Error) {
    t.equal(error2.message, "Aikido guard has blocked a SQL injection");
  }

  await actualConnection.end();
});
