import { invokeSkillPdf, invokeDrawingOcr } from './python-pdf.js';
export { poppler } from './python-pdf.js';

export const prepareDocuments = (files, directory, options = {}) => invokeSkillPdf('prepare', { files, directory, options });
export const prepareSpecification = (file, directory, options = {}) => invokeSkillPdf('specification', { file, directory, options });
export async function prepareDrawingDocuments(files, directory, options = {}) {
  const prepared = await invokeSkillPdf('drawing', { files, directory });
  if (options.ocr) Object.assign(prepared, await invokeDrawingOcr(prepared, directory));
  return prepared;
}

export async function augmentTableEvidence(prepared, files, directory) {
  const result = await invokeSkillPdf('augment', { prepared, files, directory });
  Object.assign(prepared, result);
  return prepared;
}
