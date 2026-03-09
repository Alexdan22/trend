/*
Entry Lock

Ensures only one trade per symbol is active.
*/

const activeLocks = new Map();

/*
Check if entry is allowed
*/
function checkEntryLock(symbol) {

  if (activeLocks.has(symbol)) {
    return false;
  }

  return true;
}

/*
Lock entry when trade opens
*/
function lockEntry(symbol) {

  activeLocks.set(symbol, true);

}

/*
Unlock entry when trade closes
*/
function unlockEntry(symbol) {

  activeLocks.delete(symbol);

}

module.exports = {
  checkEntryLock,
  lockEntry,
  unlockEntry
};