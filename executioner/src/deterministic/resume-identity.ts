import { upstreamResumeId } from "../contracts/index.ts";

export const productResumeId = (sha256: string) => upstreamResumeId(`resume_${sha256.slice(0, 24)}`);

export function questionnaireUploadFileName(sha256: string): string {
  return `c3-attachment-${sha256}.pdf`;
}
