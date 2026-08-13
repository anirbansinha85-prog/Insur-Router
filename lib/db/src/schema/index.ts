export * from "./owners";
export * from "./users";
export * from "./showrooms";
// entity -> registration -> branch, the shape of a dealership (OBJ-37, R-119).
export * from "./org";
export * from "./dms_deals";
export * from "./dms_job_cards";
export * from "./dms_enquiries";
export * from "./dms_registrations";
export * from "./dms_part_stock";
export * from "./dms_receivables";
export * from "./dms_vehicle_stock";
export * from "./entities";
export * from "./decision_log";
export * from "./record_events";
export * from "./dealer_policy";
// The first records DDMS creates rather than copies (OBJ-22, R-76).
export * from "./record_activities";
export * from "./tasks";
// Where each thing in the building has got to (OBJ-23, R-77).
export * from "./journeys";
export * from "./autonomy";
// What ran unattended, what it cost, and when it stood down (OBJ-28).
export * from "./trace";
// Double entry, from the documents DDMS issues (OBJ-31, R-98..R-103).
export * from "./ledger";
// The other half of every entry: parties, bills, purchases (OBJ-38, R-109..R-111).
export * from "./parties";
// Stock that moves without being sold, and the chassis register (OBJ-39, R-117).
export * from "./stock_moves";
// Receipts, payments, bill-wise allocation and the day close (OBJ-40, R-111).
export * from "./money";
// Three ways in, one record (OBJ-24, R-84).
export * from "./ingest";
// Price lists with history, and the document DDMS issues (OBJ-25, R-87..R-90).
export * from "./pricing";
export * from "./outbound_messages";
// The dealership's own account on somebody else's network, and what came
// back on it (OBJ-27, R-106).
export * from "./channels";
export * from "./providers";
export * from "./insurer_panel";
export * from "./applications";
export * from "./submission_logs";
export * from "./policies";
export * from "./ocr_engines";
