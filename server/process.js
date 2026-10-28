import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

// Argument arrays only: uploaded file names and model output never enter a shell.
export function runProcess(command, args, { timeout = 60000, maxBytes = 24e6, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, ...options });
    child.stdin?.end();
    const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
    let stdout = '', stderr = '', bytes = 0, failure;
    const abort = (error) => { failure ||= error; child.kill('SIGKILL'); };
    const timer = setTimeout(() => abort(new Error('处理超时，请减少文件数量后重试')), timeout);
    child.stdout.on('data', b => { bytes += b.length; if (bytes > maxBytes) abort(new Error('输出超过限制')); else stdout += stdoutDecoder.write(b); });
    child.stderr.on('data', b => { const text = stderrDecoder.write(b); if (stderr.length < 32000) stderr += text.slice(0, 32000 - stderr.length); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); stdout += stdoutDecoder.end(); stderr += stderrDecoder.end(); if (failure) reject(failure); else if (code !== 0) reject(new Error(`${command} 运行失败 (${code}): ${stderr.slice(-2000)}`)); else resolve({ stdout, stderr }); });
  });
}
