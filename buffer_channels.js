const { listBufferOrganizationsAndChannels } = require("./lib/buffer");

async function main() {
  const result = await listBufferOrganizationsAndChannels();
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error(`[BUFFER] ${err.message}`);
  process.exitCode = 1;
});
