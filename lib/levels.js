const { execFile } = require("child_process");
const { promisify } = require("util");

const {
  PYTHON_EXECUTABLE,
  LEVELS_SCRIPT_PATH,
  LEVELS_TIMEOUT_MS
} = require("./config");

const execFileAsync = promisify(execFile);

async function runLevelsScript(ticker) {
  const safeTicker = String(ticker || "").trim().toUpperCase();
  if (!safeTicker) return "Levels unavailable.";

  try {
    console.log(`[LEVELS] Running levels script for ${safeTicker}`);

    const { stdout, stderr } = await execFileAsync(
      PYTHON_EXECUTABLE,
      [LEVELS_SCRIPT_PATH, safeTicker],
      {
        timeout: LEVELS_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      }
    );

    const stdoutText = String(stdout || "");
    const stderrText = String(stderr || "").trim();

    if (stderrText) {
      console.warn(`[LEVELS] stderr for ${safeTicker}: ${stderrText}`);
    }

    if (!stdoutText.trim()) {
      console.warn(`[LEVELS] No stdout returned for ${safeTicker}`);
      return "Levels unavailable.";
    }

    const lines = stdoutText.split(/\r?\n/);
    const startIndex = lines.findIndex(line => line.trim() === `**$${safeTicker}**`);

    if (startIndex === -1) {
      console.warn(`[LEVELS] Clean trader block not found for ${safeTicker}`);
      return "Levels unavailable.";
    }

    const cleanedLines = lines.slice(startIndex).map(line => line.trimEnd());

    while (cleanedLines.length && cleanedLines[cleanedLines.length - 1].trim() === "") {
      cleanedLines.pop();
    }

    const cleaned = cleanedLines.join("\n").trim();
    return cleaned || "Levels unavailable.";
  } catch (err) {
    console.error(`[LEVELS] Failed for ${safeTicker}: ${err.message}`);
    return "Levels unavailable.";
  }
}

module.exports = {
  runLevelsScript
};
