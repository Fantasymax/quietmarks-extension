/* global postMessage, setInterval */
(function () {
  "use strict";

  function ping() {
    postMessage({
      type: "quietmarks:keepalive"
    });
  }

  ping();
  setInterval(ping, 15000);
})();
