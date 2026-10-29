import { invokeSkillPdf } from './python-pdf.js';
export { poppler } from './python-pdf.js';

export const prepareDocuments = (files, directory, options = {}) => invokeSkillPdf('prepare', { files, directory, options });
export const prepareSpecification = (file, directory, options = {}) => invokeSkillPdf('specification', { file, directory, options });
export const prepareDrawingDocuments = (files, directory) => invokeSkillPdf('drawing', { files, directory });

export async function augmentTableEvidence(prepared, files, directory) {
  const result = await invokeSkillPdf('augment', { prepared, files, directory });
  Object.assign(prepared, result);
  return prepared;
}
