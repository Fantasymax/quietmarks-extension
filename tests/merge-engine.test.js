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

function createContext() {
  const context = {
    console,
    URL,
    btoa(value) {
      return Buffer.from(value, "binary").toString("base64");
    },
    atob(value) {
      return Buffer.from(value, "base64").toString("binary");
    },
    crypto: {
      getRandomValues(bytes) {
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = index + 1;
        }
        return bytes;
      }
    },
    globalThis: null
  };
  context.globalThis = context;
  vm.createContext(context);
  loadScript(context, "src/core/constants.js");
  loadScript(context, "src/core/utils.js");
  loadScript(context, "src/core/state-model.js");
  loadScript(context, "src/bookmarks/bookmark-adapter.js");
  loadScript(context, "src/sync/merge-engine.js");
  return context;
}

function stateWithNodes(clientId, nodes) {
  return {
    version: 1,
    updatedAt: "2026-07-02T00:00:00.000Z",
    lastWriter: clientId,
    roots: ["root:toolbar"],
    nodes: {
      "root:toolbar": {
        guid: "root:toolbar",
        type: "root",
        title: "Bookmarks bar",
        parentGuid: "",
        index: 0,
        deleted: false
      },
      ...nodes
    },
    events: []
  };
}

function testRemoteOnlyBookmarksSurviveBlankLocalBase() {
  const context = createContext();
  const engine = new context.QuietMarks.MergeEngine();
  const blank = context.QuietMarks.StateModel.blankState("office");
  const local = stateWithNodes("office", {
    "office:bookmark": {
      guid: "office:bookmark",
      type: "bookmark",
      title: "Office Bookmark",
      url: "https://office.example/",
      parentGuid: "root:toolbar",
      index: 0,
      modifiedAt: "2026-07-02T00:00:00.000Z",
      deleted: false
    }
  });
  const remote = stateWithNodes("home", {
    "home:bookmark": {
      guid: "home:bookmark",
      type: "bookmark",
      title: "Home Bookmark",
      url: "https://home.example/",
      parentGuid: "root:toolbar",
      index: 1,
      modifiedAt: "2026-07-02T01:00:00.000Z",
      deleted: false
    }
  });

  const merged = engine.mergeStates(blank, local, remote, "office");

  assert(merged.state.nodes["office:bookmark"], "local bookmark should remain after reset-local merge");
  assert(merged.state.nodes["home:bookmark"], "remote bookmark should be imported after reset-local merge");
}

function run() {
  testRemoteOnlyBookmarksSurviveBlankLocalBase();
  console.log("merge-engine tests passed");
}

run();
