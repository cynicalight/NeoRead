// WPS ribbon callbacks. Each button runs one Reader citation command.
(function (root) {
  "use strict";

  const commands = [
    "addEditCitation",
    "addEditBibliography",
    "refresh",
    "setDocPrefs",
    "removeCodes",
  ];
  const images = {
    addEditCitation: "images/citation.svg",
    addEditBibliography: "images/bibliography.svg",
    refresh: "images/refresh.svg",
    setDocPrefs: "images/preferences.svg",
    removeCodes: "images/unlink.svg",
  };
  let running = false;

  function alertUser(message) {
    try {
      root.wps.WpsApplication().ActiveDocument.ActiveWindow.Activate();
    } catch (e) {
      /* Show the message anyway. */
    }
    root.alert(message);
  }

  root.OnAddinLoad = function (ribbonUI) {
    root.wps.ribbonUI = ribbonUI;
    return true;
  };

  root.GetImage = function (control) {
    return images[control.Id] || "";
  };

  root.OnAction = function (control) {
    const command = control.Id;
    if (!commands.includes(command) || running) return true;
    const app = root.wps.WpsApplication();
    if (!app.Documents.Count) {
      alertUser("请先打开一份文档。");
      return true;
    }
    const doc = root.ReaderCiteWord.createDocument(app);
    running = true;
    root.ReaderCiteProtocol.bootstrap(root.location.pathname)
      .then((post) =>
        root.ReaderCiteProtocol.runCommand({
          command,
          documentId: doc.id(),
          client: "wps",
          document: doc,
          post,
        }),
      )
      .then((error) => {
        if (error) alertUser(error);
      })
      .catch((e) => alertUser(String((e && e.message) || e)))
      .finally(() => {
        running = false;
      });
    return true;
  };
})(typeof globalThis === "object" ? globalThis : this);
