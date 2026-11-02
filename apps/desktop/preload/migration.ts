import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("neoreadMigration", {
  decide: (confirmed: boolean) =>
    ipcRenderer.send("neoread:migration-decision", confirmed),
});
