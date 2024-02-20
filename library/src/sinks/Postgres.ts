import { Wrapper } from "../agent/Wrapper";
import { Client } from "pg";
import { Hook } from "require-in-the-middle";
import { massWrap } from "shimmer";
import { Agent } from "../agent/Agent";
import { getInstance } from "../agent/AgentSingleton";
import { Context, getContext } from "../agent/Context";

export class Postgres implements Wrapper {
  private checkForSqlInjection(sqlStatement: string, request: Context) {
    // Currently, do nothing : Still needs to be implemented
  }
  private wrapQueryFunction(exports: unknown) {
    const that = this;

    massWrap(
      // @ts-expect-error This is magic that TypeScript doesn't understand
      [exports.Client.prototype, exports.Pool.prototype],
      ["query"],
      function wrapQueryFunction(original) {
        return function safeQueryFunction(this: Client, ...args: unknown[]) {
          const agent = getInstance();
          if (!agent) {
            return original.apply(this, args);
          }

          const request = getContext();
          if (!request) {
            agent.onInspectedCall({
              module: "postgres",
              withoutContext: true,
              detectedAttack: false,
            });

            return original.apply(this, args);
          }
          if (typeof args[0] !== "string") {
            // The query is not a string, not much to do here
            return original.apply(this, args);
          }
          const querystring: string = args[0];

          that.checkForSqlInjection(querystring, request);

          return original.apply(this, args);
        };
      }
    );
  }

  private onModuleRequired<T>(exports: T): T {
    this.wrapQueryFunction(exports);
    return exports;
  }

  wrap() {
    new Hook(["pg"], this.onModuleRequired.bind(this));
  }
}

function isStringPossibleSQLInjection(checkString: string):boolean {
  throw new Error("Function not yet implemented");
  const regex = /()/gmi // Needs to be an actual regex
  return regex.test(checkString);

/**
 * This function is the 2nd and last check to determine if a SQL injection is happening,
 * If the sql statement contains user input, this function returns true (case-insensitive)
 * @param sql The SQL Statement you want to check it against
 * @param input The user input you want to check
 * @returns True when the sql statement contains the input
 */
function sqlContainsInput(sql: string, input: string) {
  const lowercaseSql = sql.toLowerCase();
  const lowercaseInput = input.toLowerCase();
  return lowercaseSql.includes(lowercaseInput);
}