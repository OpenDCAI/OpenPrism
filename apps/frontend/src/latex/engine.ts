export interface CompileOutcome {
  pdf: Uint8Array<ArrayBuffer>;
  log: string;
  status: number;
  engine: string;
}
