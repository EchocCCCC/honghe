import { invokeSkillPdf } from './python-pdf.js';
export { python } from './python-pdf.js';

export async function appendTableStructure(prepared, file, directory) {
  const result = await invokeSkillPdf('table', { prepared, file, directory });
  Object.assign(prepared, result.prepared);
  return result.payload;
}
