const t = require("tap");
const { spawn } = require("child_process");
const { resolve } = require("path");
const timeout = require("../timeout");

const pathToApp = resolve(__dirname, "../../sample-apps/hono-xml", "app.js");

t.test("it blocks in blocking mode", (t) => {
  const server = spawn(`node`, [pathToApp, "4002"], {
    env: { ...process.env, AIKIDO_DEBUG: "true", AIKIDO_BLOCKING: "true" },
  });

  server.on("close", () => {
    t.end();
  });

  server.on("error", (err) => {
    t.fail(err.message);
  });

  let stdout = "";
  server.stdout.on("data", (data) => {
    stdout += data.toString();
  });

  let stderr = "";
  server.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  // Wait for the server to start
  timeout(2000)
    .then(() => {
      return Promise.all([
        fetch("http://127.0.0.1:4002/add", {
          method: "POST",
          body: "<cat><name>Njuska'); DELETE FROM cats;-- H</name></cat>",
          headers: {
            "Content-Type": "application/xml",
          },
          signal: AbortSignal.timeout(5000),
        }),
        fetch("http://127.0.0.1:4002/add-attribute", {
          method: "POST",
          body: `<cat name="Njuska'); DELETE FROM cats;-- H"></cat>`,
          headers: {
            "Content-Type": "application/xml",
          },
          signal: AbortSignal.timeout(5000),
        }),
        fetch("http://127.0.0.1:4002/add", {
          method: "POST",
          body: "<cat><name>Miau</name></cat>",
          headers: {
            "Content-Type": "application/xml",
          },
          signal: AbortSignal.timeout(5000),
        }),
      ]);
    })
    .then(([sqlInjection, sqlInjection2, normalAdd]) => {
      t.equal(sqlInjection.status, 500);
      t.equal(sqlInjection2.status, 500);
      t.equal(normalAdd.status, 200);
      t.match(stdout, /Starting agent/);
      t.match(stderr, /Aikido firewall has blocked an SQL injection/);
    })
    .catch((error) => {
      t.fail(error.message);
    })
    .finally(() => {
      server.kill();
    });
});

t.test("it does not block in dry mode", (t) => {
  const server = spawn(`node`, [pathToApp, "4003"], {
    env: { ...process.env, AIKIDO_DEBUG: "true" },
  });

  server.on("close", () => {
    t.end();
  });

  let stdout = "";
  server.stdout.on("data", (data) => {
    stdout += data.toString();
  });

  let stderr = "";
  server.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  // Wait for the server to start
  timeout(2000)
    .then(() =>
      Promise.all([
        fetch("http://127.0.0.1:4003/add", {
          method: "POST",
          body: "<cat><name>Njuska'); DELETE FROM cats;-- H</name></cat>",
          headers: {
            "Content-Type": "application/xml",
          },
          signal: AbortSignal.timeout(5000),
        }),
        fetch("http://127.0.0.1:4003/add-attribute", {
          method: "POST",
          body: `<cat name="Njuska'); DELETE FROM cats;-- H"></cat>`,
          headers: {
            "Content-Type": "application/xml",
          },
          signal: AbortSignal.timeout(5000),
        }),
        fetch("http://127.0.0.1:4003/add", {
          method: "POST",
          body: "<cat><name>Miau</name></cat>",
          headers: {
            "Content-Type": "application/xml",
          },
          signal: AbortSignal.timeout(5000),
        }),
      ])
    )
    .then(([sqlInjection, sqlInjection2, normalAdd]) => {
      t.equal(sqlInjection.status, 200);
      t.equal(sqlInjection2.status, 200);
      t.equal(normalAdd.status, 200);
      t.match(stdout, /Starting agent/);
      t.notMatch(stderr, /Aikido firewall has blocked an SQL injection/);
    })
    .catch((error) => {
      t.fail(error.message);
    })
    .finally(() => {
      server.kill();
    });
});
