/*
 * Persists the bot's current open position to disk.
 * This lets the algo server recover position state after a restart.
 * The saved data includes direction, security id, quantity, and option symbol.
 */
const fs = require("fs");
const path = require("path");

const positionFile = path.join(__dirname, "../data/position.json");

// Load the last saved position, or start flat if the file is missing/corrupt.
function loadPosition() {
  try {
    const data = fs.readFileSync(positionFile, "utf8");

    return JSON.parse(data);
  } catch (error) {
    return {
      currentPosition: null,
    };
  }
}

// Save the full position snapshot used by future exit signals.
function savePosition(position) {
  fs.writeFileSync(positionFile, JSON.stringify(position, null, 2));
}

module.exports = {
  loadPosition,
  savePosition,
};
