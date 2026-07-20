const { z } = require("zod");

const finiteNumber = z.number().finite();
const optionalPrice = finiteNumber.nullable();

const BlindAssessmentSchema = z.object({
  marketState: z.string().min(1).max(500),
  action: z.enum(["BUY", "SELL", "WAIT"]),
  bestAvailableSetup: z.string().min(1).max(1_500),
  idealEntryZone: z.object({ low: optionalPrice, high: optionalPrice, notes: z.string().max(500) }).strict(),
  invalidation: z.string().min(1).max(1_000),
  targets: z.array(z.object({ price: optionalPrice, rationale: z.string().max(500) }).strict()).max(6),
  requiredConfirmation: z.array(z.string().min(1).max(500)).max(8),
  risks: z.array(z.string().min(1).max(500)).max(10),
  confidence: z.number().int().min(0).max(100),
  limitations: z.array(z.string().min(1).max(500)).max(10),
}).strict();

const SignalComparisonSchema = z.object({
  directionAlignment: z.enum(["ALIGNED", "OPPOSED", "BLIND_WAIT"]),
  grade: z.enum(["A", "B", "C", "D", "E", "F"]),
  entryQuality: z.string().min(1).max(1_000),
  stopLossQuality: z.string().min(1).max(1_000),
  takeProfitQuality: z.string().min(1).max(1_000),
  matchedWell: z.array(z.string().min(1).max(500)).max(8),
  mayHaveMissed: z.array(z.string().min(1).max(500)).max(8),
  differenceFromIdeal: z.string().min(1).max(1_500),
  confidence: z.number().int().min(0).max(100),
  limitations: z.array(z.string().min(1).max(500)).max(10),
}).strict();

const OutcomeReviewSchema = z.object({
  outcomeSummary: z.string().min(1).max(1_500),
  thesisValidation: z.enum(["SUPPORTED", "PARTIAL", "INVALIDATED", "INCONCLUSIVE"]),
  entryReview: z.string().min(1).max(1_000),
  managementObservations: z.array(z.string().min(1).max(500)).max(8),
  lessons: z.array(z.string().min(1).max(500)).max(8),
  originalGradeStillInformative: z.boolean(),
  limitations: z.array(z.string().min(1).max(500)).max(10),
}).strict();

module.exports = { BlindAssessmentSchema, OutcomeReviewSchema, SignalComparisonSchema };
