// src/trade/tradeRegistry.js

// Active trade pairs
const openPairs = {};

// Prevent newly placed trades from being marked as external
const recentTickets = new Set();

// Map broker ticket → pairId
const ticketOwnershipMap = new Map();

function registerRecentTicket(ticket) {
  if (!ticket) return;
  const t = String(ticket);
  recentTickets.add(t);

  // auto-expire after 15s (same behavior as exness.js)
  setTimeout(() => {
    recentTickets.delete(t);
  }, 15000);
}

function registerTicketOwnership(ticket, pairId) {
  if (!ticket || !pairId) return;
  ticketOwnershipMap.set(String(ticket), pairId);
}

function removeTicketOwnership(ticket) {
  if (!ticket) return;
  ticketOwnershipMap.delete(String(ticket));
}

function getPair(pairId) {
  return openPairs[pairId] || null;
}

function setPair(pairId, pairData) {
  openPairs[pairId] = pairData;
}

function deletePair(pairId) {
  delete openPairs[pairId];
}

module.exports = {
  openPairs,
  recentTickets,
  ticketOwnershipMap,
  registerRecentTicket,
  registerTicketOwnership,
  removeTicketOwnership,
  getPair,
  setPair,
  deletePair
};