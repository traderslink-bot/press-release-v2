const fs = require("fs");
const path = require("path");

const appendChainsByFile = new Map();

function appendTextQueued(filePath, text, encoding = "utf8") {
  const resolvedPath = path.resolve(String(filePath || ""));
  const previous = appendChainsByFile.get(resolvedPath) || Promise.resolve();

  const next = previous
    .catch(() => {})
    .then(async () => {
      await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.promises.appendFile(resolvedPath, text, encoding);
    });

  appendChainsByFile.set(resolvedPath, next);

  next.finally(() => {
    if (appendChainsByFile.get(resolvedPath) === next) {
      appendChainsByFile.delete(resolvedPath);
    }
  });

  return next;
}

module.exports = {
  appendTextQueued
};
