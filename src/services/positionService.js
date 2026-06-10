const fs = require("fs");
const path = require("path");

const positionFile = path.join(__dirname, "../data/position.json");

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

function savePosition(position) {
  fs.writeFileSync(positionFile, JSON.stringify(position, null, 2));
}

module.exports = {
  loadPosition,
  savePosition,
};
