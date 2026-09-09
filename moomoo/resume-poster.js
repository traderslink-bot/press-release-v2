const fs = require("fs");
const path = require("path");
const { MOOMOO_DIR } = require("./queue");

const KILL_SWITCH_FILE = path.join(MOOMOO_DIR, "KILL_SWITCH");

if (fs.existsSync(KILL_SWITCH_FILE)) fs.unlinkSync(KILL_SWITCH_FILE);
console.log("Moomoo posting is ready for future new articles. Missed articles will not be reposted.");
