/* EERP diagram objects. Only the native SDK mutates the open document. */
(function () {
  "use strict";
  const channel = "eerp-office-diagrams-v1";
  const guid = "asc.{864F46F0-1927-4A84-A784-E48EE7B38994}";
  const origin = window.location.origin;
  const host = window.parent.parent;
  let requestId;
  let busy = false;
  let timer;
  const french = () => String(Asc.plugin.info.lang).startsWith("fr");
  const status = (en, fr) => {
    document.getElementById("status").textContent = french() ? fr : en;
  };
  const send = (type, extra) =>
    host.postMessage({ channel, type, requestId, ...extra }, origin);
  const close = () => {
    clearTimeout(timer);
    Asc.plugin.executeCommand("close", "");
  };
  const cancel = () => {
    if (!busy) {
      send("cancel");
      close();
    }
  };
  document.getElementById("cancel").onclick = cancel;
  Asc.plugin.button = cancel;
  Asc.plugin.init = function (data) {
    if (Asc.plugin.info.resize) {
      close();
      return;
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    requestId = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
      .join("")
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    document.getElementById("cancel").textContent = french()
      ? "Annuler"
      : "Cancel";
    status("Opening EERP diagrams…", "Ouverture des diagrammes EERP…");
    send("open", { data, editing: Asc.plugin.info.objectId !== undefined });
    timer = setTimeout(
      () =>
        status(
          "Open this document from EERP to insert a diagram.",
          "Ouvrez ce document depuis EERP pour insérer un diagramme.",
        ),
      10000,
    );
  };
  window.addEventListener("message", function (event) {
    const msg = event.data;
    if (
      event.origin !== origin ||
      event.source !== host ||
      !msg ||
      msg.channel !== channel ||
      msg.requestId !== requestId
    )
      return;
    if (msg.type === "ready") {
      clearTimeout(timer);
      return;
    }
    if (msg.type === "cancel") {
      close();
      return;
    }
    if (msg.type !== "insert" || busy) return;
    // Bound payloads before handing them to the native SDK. The host checks the
    // specification against its installed module registry and current rights.
    if (
      typeof msg.image !== "string" ||
      !msg.image.startsWith("data:image/png;base64,") ||
      msg.image.length > 24000000 ||
      typeof msg.data !== "string" ||
      msg.data.length > 4096 ||
      !Number.isFinite(msg.width) ||
      !Number.isFinite(msg.height) ||
      msg.width <= 0 ||
      msg.height <= 0 ||
      msg.width > 8192 ||
      msg.height > 8192
    )
      return;
    busy = true;
    status("Inserting diagram…", "Insertion du diagramme…");
    const scale = Math.min(155 / msg.width, 195 / msg.height);
    const info = Asc.plugin.info;
    const value = {
      guid,
      data: msg.data,
      imgSrc: msg.image,
      widthPix: msg.width,
      heightPix: msg.height,
      width: msg.width * scale,
      height: msg.height * scale,
      objectId: info.objectId,
      resize: false,
    };
    Asc.plugin.executeMethod(
      info.objectId === undefined ? "AddOleObject" : "EditOleObject",
      [value],
      function () {
        send("inserted");
        close();
      },
    );
  });
})();
