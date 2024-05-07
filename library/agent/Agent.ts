/* eslint-disable max-lines-per-function */
import { hostname, platform, release } from "os";
import { convertRequestBodyToString } from "../helpers/convertRequestBodyToString";
import { getAgentVersion } from "../helpers/getAgentVersion";
import { ip } from "../helpers/ipAddress";
import { filterEmptyRequestHeaders } from "../helpers/filterEmptyRequestHeaders";
import { limitLengthMetadata } from "../helpers/limitLengthMetadata";
import { ReportingAPI, ReportingAPIResponse } from "./api/ReportingAPI";
import { AgentInfo } from "./api/Event";
import { ConfigAPI } from "./config-api/ConfigAPI";
import { Token } from "./Token";
import { Kind } from "./Attack";
import { Context } from "./Context";
import { Hostnames } from "./Hostnames";
import { InspectionStatistics } from "./InspectionStatistics";
import { Logger } from "./logger/Logger";
import { Routes } from "./Routes";
import { Config } from "./Config";
import { Source } from "./Source";
import { Users } from "./Users";
import { wrapInstalledPackages } from "./wrapInstalledPackages";
import { Wrapper } from "./Wrapper";

type WrappedPackage = { version: string | null; supported: boolean };

export class Agent {
  private started = false;
  private sendHeartbeatEveryMS = 30 * 60 * 1000;
  private checkIfHeartbeatIsNeededEveryMS = 60 * 1000;
  private lastHeartbeat = Date.now();
  private reportedInitialStats = false;
  private interval: NodeJS.Timeout | undefined = undefined;
  private preventedPrototypePollution = false;
  private incompatiblePackages: Record<string, string> = {};
  private wrappedPackages: Record<string, WrappedPackage> = {};
  private timeoutInMS = 5000;
  private hostnames = new Hostnames(200);
  private config = new Config([], [], Date.now());
  private routes: Routes = new Routes(200);
  private users: Users = new Users(1000);
  private statistics = new InspectionStatistics({
    maxPerfSamplesInMemory: 5000,
    maxCompressedStatsInMemory: 100,
  });

  constructor(
    private readonly block: boolean,
    private readonly logger: Logger,
    private readonly api: ReportingAPI,
    private readonly token: Token | undefined,
    private readonly serverless: string | undefined,
    private readonly configAPI: ConfigAPI
  ) {
    if (typeof this.serverless === "string" && this.serverless.length === 0) {
      throw new Error("Serverless cannot be an empty string");
    }
  }

  shouldBlock() {
    return this.block;
  }

  getHostnames() {
    return this.hostnames;
  }

  getInspectionStatistics() {
    return this.statistics;
  }

  unableToPreventPrototypePollution(
    incompatiblePackages: Record<string, string>
  ) {
    this.incompatiblePackages = incompatiblePackages;

    const list: string[] = [];
    for (const pkg in incompatiblePackages) {
      list.push(`${pkg}@${incompatiblePackages[pkg]}`);
    }

    this.logger.log(
      `Unable to prevent prototype pollution, incompatible packages found: ${list.join(" ")}`
    );
  }

  onPrototypePollutionPrevented() {
    this.logger.log("Prevented prototype pollution!");

    // Will be sent in the next heartbeat
    this.preventedPrototypePollution = true;
    this.incompatiblePackages = {};
  }

  /**
   * Reports to the API that this agent has started
   */
  onStart() {
    if (this.token) {
      this.api
        .report(
          this.token,
          {
            type: "started",
            time: Date.now(),
            agent: this.getAgentInfo(),
          },
          this.timeoutInMS
        )
        .then((result) => this.updateConfig(result))
        .catch((error) => {
          this.logger.log("Failed to report started event");
        });
    }
  }

  onErrorThrownByInterceptor({
    error,
    module,
    method,
  }: {
    error: Error;
    module: string;
    method: string;
  }) {
    this.logger.log(
      `Internal error in module "${module}" in method "${method}"\n${error.stack}`
    );
  }

  /**
   * This function gets called when an attack is detected, it reports this attack to the API
   */
  onDetectedAttack({
    module,
    operation,
    kind,
    blocked,
    source,
    request,
    stack,
    path,
    metadata,
    payload,
  }: {
    module: string;
    operation: string;
    kind: Kind;
    blocked: boolean;
    source: Source;
    request: Context;
    stack: string;
    path: string;
    metadata: Record<string, string>;
    payload: unknown;
  }) {
    if (this.token) {
      this.api
        .report(
          this.token,
          {
            type: "detected_attack",
            time: Date.now(),
            attack: {
              module: module,
              operation: operation,
              blocked: blocked,
              path: path,
              stack: stack,
              source: source,
              metadata: limitLengthMetadata(metadata, 4096),
              kind: kind,
              payload: JSON.stringify(payload).substring(0, 4096),
            },
            user: request.user,
            request: {
              method: request.method,
              url: request.url,
              ipAddress: request.remoteAddress,
              userAgent:
                typeof request.headers["user-agent"] === "string"
                  ? request.headers["user-agent"]
                  : undefined,
              body: convertRequestBodyToString(request.body),
              headers: filterEmptyRequestHeaders(request.headers),
              source: request.source,
              route: request.route,
            },
            agent: this.getAgentInfo(),
          },
          this.timeoutInMS
        )
        .catch(() => {
          this.logger.log("Failed to report attack");
        });
    }
  }

  /**
   * Sends a heartbeat via the API to the server (only when not in serverless mode)
   */
  private heartbeat(timeoutInMS = this.timeoutInMS) {
    this.sendHeartbeat(timeoutInMS).catch(() => {
      this.logger.log("Failed to do heartbeat");
    });
  }

  getConfig() {
    return this.config;
  }

  private updateConfig(response: ReportingAPIResponse) {
    if (response.success) {
      if (response.endpoints) {
        this.config = new Config(
          response.endpoints,
          response.blockedUserIds ? response.blockedUserIds : [],
          typeof response.configUpdatedAt === "number"
            ? response.configUpdatedAt
            : Date.now()
        );
      }

      const minimumHeartbeatIntervalMS = 2 * 60 * 1000;

      if (
        typeof response.heartbeatIntervalInMS === "number" &&
        response.heartbeatIntervalInMS >= minimumHeartbeatIntervalMS
      ) {
        this.sendHeartbeatEveryMS = response.heartbeatIntervalInMS;
      }
    }
  }

  private async sendHeartbeat(timeoutInMS: number) {
    if (this.token) {
      this.logger.log("Heartbeat...");
      const stats = this.statistics.getStats();
      const endedAt = Date.now();
      this.statistics.reset();
      const response = await this.api.report(
        this.token,
        {
          type: "heartbeat",
          time: Date.now(),
          agent: this.getAgentInfo(),
          stats: {
            sinks: stats.sinks,
            startedAt: stats.startedAt,
            endedAt: endedAt,
            requests: stats.requests,
          },
          hostnames: this.hostnames.asArray(),
          routes: this.routes.asArray(),
          users: this.users.asArray(),
        },
        timeoutInMS
      );
      this.updateConfig(response);
    }
  }

  /**
   * Starts a heartbeat when not in serverless mode : Make contact with api every x seconds.
   */
  private startHeartbeats() {
    /* c8 ignore next 3 */
    if (this.serverless) {
      throw new Error("Heartbeats in serverless mode are not supported");
    }

    /* c8 ignore next 3 */
    if (this.interval) {
      throw new Error("Interval already started");
    }

    this.interval = setInterval(() => {
      const now = Date.now();
      const diff = now - this.lastHeartbeat;
      const shouldSendHeartbeat = diff > this.sendHeartbeatEveryMS;
      const shouldReportInitialStats =
        this.statistics.hasCompressedStats() && !this.reportedInitialStats;

      if (shouldSendHeartbeat || shouldReportInitialStats) {
        this.heartbeat();
        this.lastHeartbeat = now;
        this.reportedInitialStats = true;
      }

      this.configNeedsUpdate()
        .then((needsUpdate) => {
          if (needsUpdate) {
            this.grabLatestConfig().catch(() => {
              this.logger.log("Failed to grab latest config");
            });
          }
        })
        .catch(() => {
          this.logger.log("Failed to check if config needs updated");
        });
    }, this.checkIfHeartbeatIsNeededEveryMS);

    this.interval.unref();
  }

  private getAgentInfo(): AgentInfo {
    return {
      dryMode: !this.block,
      /* c8 ignore next */
      hostname: hostname() || "",
      version: getAgentVersion(),
      /* c8 ignore next */
      ipAddress: ip() || "",
      packages: Object.keys(this.wrappedPackages).reduce(
        (packages: Record<string, string>, pkg) => {
          const details = this.wrappedPackages[pkg];
          if (details.version && details.supported) {
            packages[pkg] = details.version;
          }

          return packages;
        },
        {}
      ),
      incompatiblePackages: {
        prototypePollution: this.incompatiblePackages,
      },
      preventedPrototypePollution: this.preventedPrototypePollution,
      nodeEnv: process.env.NODE_ENV || "",
      serverless: !!this.serverless,
      stack: Object.keys(this.wrappedPackages).concat(
        this.serverless ? [this.serverless] : []
      ),
      os: {
        name: platform(),
        version: release(),
      },
    };
  }

  start(wrappers: Wrapper[]) {
    if (this.started) {
      throw new Error("Agent already started!");
    }

    this.started = true;

    this.logger.log("Starting agent...");

    if (!this.block) {
      this.logger.log("Dry mode enabled, no requests will be blocked!");
    }

    if (this.token) {
      this.logger.log("Found token, reporting enabled!");
    } else {
      this.logger.log("No token provided, disabling reporting.");
    }

    this.wrappedPackages = wrapInstalledPackages(this, wrappers);

    for (const pkg in this.wrappedPackages) {
      const details = this.wrappedPackages[pkg];

      /* c8 ignore next 3 */
      if (!details.version) {
        continue;
      }

      if (details.supported) {
        this.logger.log(`${pkg}@${details.version} is supported!`);
      } else {
        this.logger.log(`${pkg}@${details.version} is not supported!`);
      }
    }

    this.onStart();

    if (!this.serverless && this.token) {
      this.startHeartbeats();
    }
  }

  onFailedToWrapMethod(module: string, name: string) {
    this.logger.log(`Failed to wrap method ${name} in module ${module}`);
  }

  onConnectHostname(hostname: string, port: number | undefined) {
    this.hostnames.add(hostname, port);
  }

  onRouteExecute(method: string, path: string) {
    this.routes.addRoute(method, path);
  }

  getUsers() {
    return this.users;
  }

  async flushStats(timeoutInMS: number) {
    this.statistics.forceCompress();
    await this.sendHeartbeat(timeoutInMS);
  }

  private async configNeedsUpdate() {
    if (!this.token) {
      throw new Error("Token is required");
    }

    const lastUpdated = await this.configAPI.getLastUpdatedAt(this.token);

    return lastUpdated > this.config.getLastUpdatedAt();
  }

  private async grabLatestConfig() {
    if (!this.token) {
      throw new Error("Token is required");
    }

    try {
      const response = await this.api.getConfig(this.token, this.timeoutInMS);
      this.updateConfig(response);
    } catch (error) {
      this.logger.log("Failed to grab latest config");
    }
  }
}
