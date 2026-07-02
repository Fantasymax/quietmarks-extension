const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const projectRoot = path.resolve(__dirname, "..");

function loadScript(context, relativePath) {
  const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
  vm.runInContext(source, context, {
    filename: relativePath
  });
}

function createContext(fetchImpl) {
  const context = {
    console,
    Headers,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
    btoa(value) {
      return Buffer.from(value, "binary").toString("base64");
    },
    atob(value) {
      return Buffer.from(value, "base64").toString("binary");
    },
    globalThis: null
  };
  context.globalThis = context;
  vm.createContext(context);
  loadScript(context, "src/core/constants.js");
  loadScript(context, "src/core/utils.js");
  loadScript(context, "src/core/state-model.js");
  loadScript(context, "src/remote/webdav-store.js");
  return context;
}

async function testPutStateWritesCompactJson() {
  const requests = [];
  const context = createContext(async (url, options) => {
    requests.push({
      url,
      options
    });
    return {
      ok: true,
      status: 204,
      headers: {
        get(name) {
          return name === "ETag" ? "\"etag-next\"" : null;
        }
      }
    };
  });
  const store = new context.QuietMarks.WebDavStore({
    async encryptState(state) {
      return {
        quietmarks: 1,
        nodes: state.nodes
      };
    }
  });

  const etag = await store.putState({
    webdavUrl: "https://example.com/dav",
    remoteFile: "state.json",
    username: "",
    password: "",
    passphrase: ""
  }, {
    nodes: {
      a: {
        title: "A"
      }
    }
  }, null, true);

  assert.strictEqual(etag, "\"etag-next\"");
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].options.method, "PUT");
  assert.strictEqual(requests[0].options.body, "{\"quietmarks\":1,\"nodes\":{\"a\":{\"title\":\"A\"}}}");
  assert(!requests[0].options.body.includes("\n"), "PUT body should be compact JSON");
}

async function testHardTimeoutRejectsUnsettledWork() {
  const context = createContext(async () => new Promise(() => {}));
  const store = new context.QuietMarks.WebDavStore({
    async encryptState(state) {
      return state;
    }
  });

  await assert.rejects(
    () => store.fetchWithTimeout("https://example.com/state.json", {
      method: "GET"
    }, "GET", 10),
    /WebDAV GET timed out/
  );

  await assert.rejects(
    () => store.withTimeout(new Promise(() => {}), "GET body", 10),
    /WebDAV GET body timed out/
  );
}

async function testCustomFetchImplementationIsUsed() {
  let called = false;
  const context = createContext(async () => {
    throw new Error("global fetch should not be used");
  });
  const store = new context.QuietMarks.WebDavStore({
    async decryptState(state) {
      return state;
    }
  }, {
    async fetchImpl() {
      called = true;
      return {
        ok: false,
        status: 404,
        headers: {
          get() {
            return null;
          }
        },
        async json() {
          return {};
        }
      };
    }
  });

  const bundle = await store.fetchState({
    webdavUrl: "https://example.com/dav",
    remoteFile: "state.json",
    clientId: "local",
    username: "",
    password: "",
    passphrase: ""
  });

  assert.strictEqual(called, true);
  assert.strictEqual(bundle.exists, false);
}

async function run() {
  await testPutStateWritesCompactJson();
  await testHardTimeoutRejectsUnsettledWork();
  await testCustomFetchImplementationIsUsed();
  console.log("webdav-store tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
