/**
 * Lightweight module-level store for passing OCR results
 * and push outcomes between the linear capture → review → success flow.
 */

export interface MsaFields {
  vehicleMake: string;
  vehicleModel: string;
  vehicleVariant: string;
  vehicleEngineNumber: string;
  vehicleChassisNumber: string;
  vehicleExShowroomPrice: number;
  vehicleDateOfPurchase: string;
  ownerFullName: string;
  ownerBillingAddress: string;
  ownerPincode: number;
  ownerPhoneNumber: string;
  ownerEmail: string;
  ownerDateOfBirth: string;
  ownerIdProofType: 'AADHAR' | 'PAN' | 'PASSPORT' | 'DRIVING_LICENSE' | 'VOTER_ID';
  ownerIdProofNumber: string;
  rtoRegistrationCity: string;
  rtoRegistrationState: string;
  rtoCode: string;
}

export interface IngestResult {
  fields: MsaFields;
  confidence: Record<string, number>;
  rawText?: string | null;
}

let _ingestResult: IngestResult | null = null;
let _applicationId: number | null = null;

export function setIngestResult(r: IngestResult): void {
  _ingestResult = r;
}

export function getIngestResult(): IngestResult | null {
  return _ingestResult;
}

export function setApplicationId(id: number): void {
  _applicationId = id;
}

export function getApplicationId(): number | null {
  return _applicationId;
}

export function clearStore(): void {
  _ingestResult = null;
  _applicationId = null;
}
