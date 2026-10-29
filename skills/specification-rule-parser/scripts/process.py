"""Bounded, noninteractive execution of PDF utilities; never invoke a shell."""
import os
import subprocess
import threading


def run_process(command, args, *, timeout=60000, max_bytes=24_000_000):
    options = {"stdin": subprocess.DEVNULL, "stdout": subprocess.PIPE,
               "stderr": subprocess.PIPE, "shell": False}
    if os.name == "nt":
        options["creationflags"] = subprocess.CREATE_NO_WINDOW
    process = subprocess.Popen([str(command), *map(str, args)], **options)
    chunks, errors = [], []
    state = {"bytes": 0, "overflow": False}

    def read_stdout():
        while True:
            chunk = process.stdout.read(65536)
            if not chunk:
                break
            state["bytes"] += len(chunk)
            if state["bytes"] > max_bytes:
                state["overflow"] = True
                process.kill()
                break
            chunks.append(chunk)

    def read_stderr():
        kept = 0
        while True:
            chunk = process.stderr.read(65536)
            if not chunk:
                break
            if kept < 128000:
                saved = chunk[:128000 - kept]
                errors.append(saved)
                kept += len(saved)

    readers = [threading.Thread(target=read_stdout, daemon=True),
               threading.Thread(target=read_stderr, daemon=True)]
    for reader in readers:
        reader.start()
    timed_out = False
    try:
        process.wait(timeout=timeout / 1000)
    except subprocess.TimeoutExpired:
        timed_out = True
        process.kill()
        process.wait()
    finally:
        for reader in readers:
            reader.join()
        process.stdout.close()
        process.stderr.close()
    if timed_out:
        raise RuntimeError("处理超时，请减少文件数量后重试")
    if state["overflow"]:
        raise RuntimeError("输出超过限制")
    stdout = b"".join(chunks).decode("utf-8", errors="replace")
    stderr = b"".join(errors).decode("utf-8", errors="replace")[:32000]
    if process.returncode:
        raise RuntimeError(f"{command} 运行失败 ({process.returncode}): {stderr[-2000:]}")
    return {"stdout": stdout, "stderr": stderr}
