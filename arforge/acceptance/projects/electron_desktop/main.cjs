const {app, BrowserWindow} = require("electron");
const path = require("node:path");

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {contextIsolation: true, sandbox: true},
  });
  try {
    await window.loadFile(path.join(__dirname, "renderer.html"));
    const result = await window.webContents.executeJavaScript(
      "document.querySelector('#status').textContent"
    );
    if (result !== "Electron project depth") {
      throw new Error(`unexpected renderer value: ${result}`);
    }
    console.log(`PASS:integration:Electron-${process.versions.electron}`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
