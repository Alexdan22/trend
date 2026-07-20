function utcDayKey(value = new Date()) { return new Date(value).toISOString().slice(0, 10); }

class AnalysisLimiter {
  constructor({ repository, maxRpm, maxCallsPerDay, maxDailyCostUsd, now = () => new Date() }) {
    this.repository = repository;
    this.maxRpm = maxRpm;
    this.maxCallsPerDay = maxCallsPerDay;
    this.maxDailyCostUsd = maxDailyCostUsd;
    this.now = now;
  }

  async reserve(estimatedCostUsd = 0.02) {
    const now = this.now();
    const minuteKey = now.toISOString().slice(0, 16);
    const rate = await this.repository.reserveRate({ minuteKey, maxRpm: this.maxRpm, now });
    if (!rate) return { allowed: false, status: "RATE_LIMITED" };
    const dayKey = utcDayKey(now);
    const budget = await this.repository.reserveBudget({
      dayKey, maxCalls: this.maxCallsPerDay, maxCostUsd: this.maxDailyCostUsd, estimatedCostUsd, now,
    });
    if (!budget) return { allowed: false, status: "DAILY_LIMIT" };
    return { allowed: true, dayKey, estimatedCostUsd };
  }

  async reconcile(reservation, actualCostUsd, usage) {
    if (!reservation?.allowed) return;
    await this.repository.reconcileBudget({ ...reservation, actualCostUsd, usage });
  }
}

module.exports = { AnalysisLimiter, utcDayKey };
