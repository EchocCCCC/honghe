// Shared evidence normalization for current specification and drawing contracts.
export const normalizeEvidence = text => String(text).normalize('NFKC').replace(/[\s\u200b\u00ad]/g, '');
